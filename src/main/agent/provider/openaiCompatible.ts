import OpenAI, { type ClientOptions } from 'openai'
import { z } from 'zod'
import type { ChatDelta, ChatRequest, StructuredRequest } from './types'

/**
 * Chat, structured output, and embeddings against any endpoint that speaks the
 * OpenAI wire format — which is nearly every cheap option: OpenRouter, Groq,
 * DeepSeek, Together, OpenAI itself, and local Ollama / LM Studio. Only
 * `baseUrl` and `model` change between them.
 *
 * Everything OpenAI-shaped stops at this file: callers upstream see async
 * iterables of ChatDelta, zod-validated objects, and Float32Arrays.
 */

/** A ceiling, not a target — cheap models are happy to ramble. `max_tokens` is
 *  the field every compatible endpoint understands (OpenAI's own reasoning
 *  models want `max_completion_tokens`, but they aren't the target here). */
const CHAT_MAX_TOKENS = 8000
const STRUCTURED_MAX_TOKENS = 8000

export interface OpenAICompatibleConfig {
  /** Empty is legitimate: a local Ollama / LM Studio server wants no key. */
  apiKey: string
  baseUrl: string
  model: string
  /** Injectable so tests can exercise the wire format without a network. */
  fetch?: ClientOptions['fetch']
}

function createClient({ apiKey, baseUrl, fetch }: OpenAICompatibleConfig): OpenAI {
  return new OpenAI({
    // The SDK refuses to construct without one; local servers ignore the value.
    apiKey: apiKey || 'no-key-required',
    baseURL: baseUrl,
    fetch,
  })
}

export function createOpenAICompatibleChat(config: OpenAICompatibleConfig) {
  const client = createClient(config)
  const { model } = config

  return {
    async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
      try {
        const stream = await client.chat.completions.create(
          {
            model,
            max_tokens: req.maxTokens ?? CHAT_MAX_TOKENS,
            stream: true,
            messages: [
              ...(req.system ? [{ role: 'system' as const, content: req.system }] : []),
              ...req.messages,
            ],
          },
          req.signal ? { signal: req.signal } : undefined,
        )

        for await (const chunk of stream) {
          const text = chunk.choices[0]?.delta?.content
          if (text) yield { type: 'text', text }
        }
      } catch (err) {
        throw describe(err, config)
      }
    },

    async structured<T>(req: StructuredRequest<T>): Promise<T> {
      // `effort` is a hint the OpenAI wire format has no portable field for —
      // endpoints that expose reasoning controls all spell them differently,
      // so it's ignored here rather than risking a 400 on every call.
      const messages = [
        ...(req.system ? [{ role: 'system' as const, content: req.system }] : []),
        { role: 'user' as const, content: req.prompt },
      ]
      const maxTokens = req.maxTokens ?? STRUCTURED_MAX_TOKENS
      const schema = jsonSchemaFor(req.schema)

      try {
        let text: string
        try {
          text = await complete(client, {
            model,
            max_tokens: maxTokens,
            messages,
            response_format: {
              type: 'json_schema',
              json_schema: { name: req.schemaName, schema, strict: true },
            },
          })
        } catch (err) {
          if (!isUnsupportedFormat(err)) throw err
          // Plenty of cheap models can produce JSON but not a *schema-checked*
          // response. Fall back to plain JSON mode with the schema inlined in
          // the prompt; zod still validates what comes back, so a model that
          // can't hold the shape fails loudly either way.
          text = await complete(client, {
            model,
            max_tokens: maxTokens,
            messages: [
              ...messages,
              {
                role: 'user' as const,
                content: `Reply with JSON matching this schema, and nothing else:\n${JSON.stringify(schema)}`,
              },
            ],
            response_format: { type: 'json_object' },
          })
        }
        return req.schema.parse(JSON.parse(text))
      } catch (err) {
        throw describe(err, config)
      }
    },
  }
}

export function createOpenAICompatibleEmbeddings(config: OpenAICompatibleConfig) {
  const client = createClient(config)

  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return []
      try {
        const response = await client.embeddings.create({
          model: config.model,
          input: texts,
          // Explicit: left unset, the SDK asks for base64 and decodes it
          // itself. That's an OpenAI optimisation plenty of compatible servers
          // don't implement, and the failure is silent — empty vectors, not an
          // error.
          encoding_format: 'float',
        })
        if (response.data.length !== texts.length) {
          throw new Error(`Expected ${texts.length} embeddings, got ${response.data.length}.`)
        }
        // The API documents index-ordered results; sort anyway so a reordered
        // response can never silently mis-pair a vector with its text.
        return [...response.data]
          .sort((a, b) => a.index - b.index)
          .map((d) => Float32Array.from(d.embedding))
      } catch (err) {
        throw describe(err, config)
      }
    },
  }
}

async function complete(
  client: OpenAI,
  params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
): Promise<string> {
  const response = await client.chat.completions.create(params)
  const text = response.choices[0]?.message?.content
  if (!text) {
    throw new Error(
      `Model returned no content (${response.choices[0]?.finish_reason ?? 'unknown'}).`,
    )
  }
  return text
}

/** zod → JSON Schema. `$schema` is stripped: strict mode rejects unknown
 *  top-level keys on several endpoints. */
function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>
  delete generated.$schema
  return generated
}

/** Endpoints disagree on wording, so match on the status plus a mention of the
 *  parameter rather than any one vendor's message. */
function isUnsupportedFormat(err: unknown): boolean {
  return (
    err instanceof OpenAI.APIError &&
    (err.status === 400 || err.status === 404) &&
    /response_format|json_schema|structured/i.test(err.message)
  )
}

/** SDK errors stringify to something unhelpful in a UI banner; give the entry's
 *  failed state a sentence a person can act on. */
function describe(err: unknown, config: OpenAICompatibleConfig): Error {
  const host = hostOf(config.baseUrl)
  if (err instanceof OpenAI.AuthenticationError) {
    return new Error(`${host} rejected the API key — check the key for this endpoint.`)
  }
  if (err instanceof OpenAI.NotFoundError) {
    return new Error(`${host} does not serve "${config.model}" — check the model id.`)
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new Error(`${host} rate limit hit — retry in a moment.`)
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new Error(
      `Could not reach ${host} — check the connection, or that the server is running.`,
    )
  }
  if (err instanceof OpenAI.APIError) {
    return new Error(`${host} error ${err.status ?? ''}: ${err.message}`.trim())
  }
  return err instanceof Error ? err : new Error(String(err))
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}
