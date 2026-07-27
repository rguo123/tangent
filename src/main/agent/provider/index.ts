import type { AgentConfig } from '../config'
import { createMockProvider } from './mock'
import type { ChatRequest, LLMProvider, StructuredRequest } from './types'

export type { ChatDelta, ChatMessage, ChatRequest, LLMProvider, StructuredRequest } from './types'
export { createMockProvider, hashEmbedding, MOCK_CHAT_MODEL, MOCK_EMBEDDING_MODEL } from './mock'
export type { MockProvider } from './mock'

/** Streaming a mock reply instantly looks like a non-streamed answer; a few ms
 *  per chunk makes offline dev exercise the same UI path as the real provider.
 *  Tests construct their own mock with no delay. */
const MOCK_DEV_CHUNK_DELAY_MS = 15

/** The half of the interface each vendor covers, so chat and embeddings can be
 *  chosen independently — the two are rarely the same service. */
type ChatHalf = Pick<LLMProvider, 'chat' | 'structured'>
type EmbedHalf = Pick<LLMProvider, 'embed'>

/**
 * Assemble the provider for this launch.
 *
 * Keys come from the environment, and which variable is read depends on what
 * the endpoint is: a vendor-specific name first, then the generic one, so a
 * setup that points chat and embeddings at different services can hold two
 * keys without them colliding.
 */
export function createProvider(
  config: AgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): LLMProvider {
  const chatKey = firstOf(env, 'OPENROUTER_API_KEY', 'OPENAI_API_KEY')
  const embeddingKey =
    config.embeddingProvider === 'voyage'
      ? firstOf(env, 'VOYAGE_API_KEY')
      : firstOf(env, 'EMBEDDING_API_KEY', 'OPENAI_API_KEY')

  const needsMock = config.provider === 'mock' || config.embeddingProvider === 'mock'
  // Recording every call would retain each request's assembled document
  // context for the life of the process — fine for a test, a leak in dev mode.
  const mock = needsMock
    ? createMockProvider({
        chunkDelayMs: MOCK_DEV_CHUNK_DELAY_MS,
        record: false,
        // This mock is the app's only provider for the session, so a structured
        // call has to answer with *something* — see StructuredRequest.offlineFallback.
        offlineFallbacks: true,
      })
    : null

  const chatUnavailable = missingKeyReason(config.provider, config.baseUrl, chatKey, 'chat')

  const chat: ChatHalf =
    config.provider === 'mock'
      ? mock!
      : chatUnavailable
        ? failWith(chatUnavailable)
        : lazyChat(chatKey, config.baseUrl, config.model)

  const embeddings: EmbedHalf = selectEmbeddings(config, embeddingKey, mock)

  return {
    chatModel: config.model,
    chatBaseUrl: config.baseUrl,
    embeddingModel: config.embeddingModel,
    // Only the chat half gates the UI: a missing embeddings key doesn't stop
    // you asking questions, it stops extraction (Phase 5), which reports its
    // own failure when it runs.
    unavailable: chatUnavailable,
    chat: (req) => chat.chat(req),
    structured: (req) => chat.structured(req),
    embed: (texts) => embeddings.embed(texts),
  }
}

function selectEmbeddings(config: AgentConfig, key: string, mock: EmbedHalf | null): EmbedHalf {
  switch (config.embeddingProvider) {
    case 'mock':
      return mock!
    case 'voyage':
      return key
        ? lazyVoyage(key, config.embeddingModel)
        : failWith('Set VOYAGE_API_KEY to generate embeddings.')
    case 'openai-compatible': {
      const reason = missingKeyReason(
        config.embeddingProvider,
        config.embeddingBaseUrl,
        key,
        'embeddings',
      )
      return reason
        ? failWith(reason)
        : lazyEmbeddings(key, config.embeddingBaseUrl, config.embeddingModel)
    }
  }
}

function firstOf(env: NodeJS.ProcessEnv, ...names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim()
    if (value) return value
  }
  return ''
}

/**
 * A local server (Ollama, LM Studio) authenticates nothing, so an empty key is
 * a working setup rather than a misconfiguration — only a remote endpoint gets
 * warned about.
 */
function missingKeyReason(
  provider: string,
  baseUrl: string,
  key: string,
  half: 'chat' | 'embeddings',
): string | null {
  if (provider === 'mock' || key || isLocal(baseUrl)) return null
  const variable = half === 'chat' ? 'OPENROUTER_API_KEY (or OPENAI_API_KEY)' : 'EMBEDDING_API_KEY'
  return `Set ${variable} in .env to reach ${baseUrl}.`
}

function isLocal(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  } catch {
    return false
  }
}

/**
 * Vendor modules are loaded on first use, not at startup: `createProvider` runs
 * before the window opens, and requiring an SDK there costs tens of ms and
 * hundreds of modules that a mock-mode or never-asks session never needs.
 */
function lazyChat(apiKey: string, baseUrl: string, model: string): ChatHalf {
  let loaded: Promise<ChatHalf> | null = null
  const load = (): Promise<ChatHalf> =>
    (loaded ??= import('./openaiCompatible').then((m) =>
      m.createOpenAICompatibleChat({ apiKey, baseUrl, model }),
    ))
  return {
    async *chat(req: ChatRequest) {
      yield* (await load()).chat(req)
    },
    structured: async <T>(req: StructuredRequest<T>) => (await load()).structured(req),
  }
}

function lazyEmbeddings(apiKey: string, baseUrl: string, model: string): EmbedHalf {
  let loaded: Promise<EmbedHalf> | null = null
  return {
    embed: async (texts) =>
      (
        await (loaded ??= import('./openaiCompatible').then((m) =>
          m.createOpenAICompatibleEmbeddings({ apiKey, baseUrl, model }),
        ))
      ).embed(texts),
  }
}

function lazyVoyage(apiKey: string, model: string): EmbedHalf {
  let loaded: Promise<EmbedHalf> | null = null
  return {
    embed: async (texts) =>
      (
        await (loaded ??= import('./voyage').then((m) =>
          m.createVoyageEmbeddings({ apiKey, model }),
        ))
      ).embed(texts),
  }
}

/** Fails at call time rather than construction time, so the app still launches
 *  (and everything but the agent still works) without keys. */
function failWith(message: string): ChatHalf & EmbedHalf {
  const fail = (): never => {
    throw new Error(message)
  }
  return {
    async *chat() {
      fail()
    },
    structured: async () => fail(),
    embed: async () => fail(),
  }
}
