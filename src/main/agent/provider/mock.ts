/**
 * Deterministic provider for tests and offline dev (`TANGENT_MOCK_LLM=1`).
 *
 * Nothing here calls the network, and every output is a pure function of its
 * input, so tests assert on exact text and Phase 5's dedup thresholds can be
 * exercised without embeddings drift. Structured responses are *queued* by the
 * caller rather than invented: the mock still validates them against the real
 * zod schema, so a schema/response mismatch fails in tests the same way it
 * would against a live model.
 */

import type { ChatDelta, ChatRequest, LLMProvider, StructuredRequest } from './types'

export const MOCK_CHAT_MODEL = 'mock-chat'
export const MOCK_EMBEDDING_MODEL = 'mock-embed-64'

/** Small enough to eyeball in a failing assertion, wide enough that unrelated
 *  texts don't collide into a high cosine. */
const EMBEDDING_DIMS = 64
const CHUNK_SIZE = 12

export interface MockProviderOptions {
  /** Delay between streamed chunks. 0 in tests; a few ms in dev makes the
   *  streaming UI behave like the real thing. */
  chunkDelayMs?: number
  /** Keep every request for later assertions. On by default because that's
   *  what tests want; off when the mock is the live provider for a dev
   *  session, where each retained request pins its whole document context. */
  record?: boolean
  /** Let a `structured()` caller's `offlineFallback` stand in for a queued
   *  response. Off by default: a test that forgot to queue should say so, not
   *  quietly take the app's offline path. */
  offlineFallbacks?: boolean
}

/** What a structured call asked for, minus the schema — enough to assert on the
 *  prompt a caller assembled, and on which caller it was, without fighting the
 *  generic. */
export interface RecordedStructuredCall {
  prompt: string
  schemaName: string
}

export interface MockProvider extends LLMProvider {
  /** Queue one `structured()` result, FIFO. Validated against the caller's
   *  schema on the way out. */
  queueStructured(value: unknown): void
  /** Make the next chat or structured call throw — the error path the UI's
   *  retryable failed state is built for. */
  failNext(message: string): void
  readonly chatCalls: ChatRequest[]
  readonly structuredCalls: RecordedStructuredCall[]
  readonly embedCalls: string[][]
}

export function createMockProvider(options: MockProviderOptions = {}): MockProvider {
  const { chunkDelayMs = 0, record = true, offlineFallbacks = false } = options
  const structuredQueue: unknown[] = []
  const chatCalls: ChatRequest[] = []
  const structuredCalls: RecordedStructuredCall[] = []
  const embedCalls: string[][] = []
  let pendingFailure: string | null = null

  function takeFailure(): void {
    if (pendingFailure === null) return
    const message = pendingFailure
    pendingFailure = null
    throw new Error(message)
  }

  return {
    chatModel: MOCK_CHAT_MODEL,
    chatBaseUrl: '',
    embeddingModel: MOCK_EMBEDDING_MODEL,
    unavailable: null,
    chatCalls,
    structuredCalls,
    embedCalls,

    queueStructured(value) {
      structuredQueue.push(value)
    },

    failNext(message) {
      pendingFailure = message
    },

    async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
      if (record) chatCalls.push(req)
      takeFailure()
      for (const chunk of chunks(mockAnswer(req), CHUNK_SIZE)) {
        if (chunkDelayMs > 0) await new Promise((r) => setTimeout(r, chunkDelayMs))
        if (req.signal?.aborted) throw new Error('Aborted')
        yield { type: 'text', text: chunk }
      }
    },

    async structured<T>(req: StructuredRequest<T>): Promise<T> {
      if (record) structuredCalls.push({ prompt: req.prompt, schemaName: req.schemaName })
      takeFailure()
      if (structuredQueue.length === 0) {
        if (offlineFallbacks && req.offlineFallback) return req.schema.parse(req.offlineFallback())
        throw new Error(
          `MockProvider has no queued response for "${req.schemaName}" — call queueStructured() first.`,
        )
      }
      return req.schema.parse(structuredQueue.shift())
    },

    async embed(texts: string[]): Promise<Float32Array[]> {
      if (record) embedCalls.push(texts)
      takeFailure()
      return texts.map(hashEmbedding)
    },
  }
}

/** Echoes the question and the context size — enough for a test to assert that
 *  context assembly actually reached the provider. */
function mockAnswer(req: ChatRequest): string {
  const question = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  return `Mock answer to: ${firstLine(question)} [context ${req.system?.length ?? 0} chars]`
}

function firstLine(text: string): string {
  const trimmed = text.trim()
  const end = trimmed.indexOf('\n')
  return end === -1 ? trimmed : trimmed.slice(0, end)
}

function* chunks(text: string, size: number): Generator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size)
}

/**
 * Bag-of-words hashing into a unit vector. Not semantic — but it is stable and
 * *monotonic in word overlap*, which is exactly the property the dedup tests
 * need: near-duplicate phrasings land close, unrelated ones don't.
 */
export function hashEmbedding(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMS)
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  for (const word of words) {
    let hash = 2166136261
    for (let i = 0; i < word.length; i++) {
      hash ^= word.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    vector[Math.abs(hash) % EMBEDDING_DIMS] += 1
  }
  const norm = Math.hypot(...vector)
  if (norm > 0) for (let i = 0; i < vector.length; i++) vector[i] /= norm
  return vector
}
