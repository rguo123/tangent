/**
 * The LLM provider seam (spec §3): every model call in the app goes through
 * this interface, and no provider-specific type crosses it. Callers see plain
 * strings, zod schemas, and Float32Arrays — never an SDK message block.
 *
 * The interface is one thing; the implementation behind it is usually two
 * vendors, because the services that serve cheap chat mostly don't serve
 * embeddings. That split lives entirely behind `createProvider`.
 */

import type { ZodType } from 'zod'

export type ChatRole = 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

export interface ChatRequest {
  system?: string
  /** Alternating turns, oldest first; must start with a user turn. */
  messages: ChatMessage[]
  maxTokens?: number
  signal?: AbortSignal
}

/** Streaming unit. A union from the start so a later `thinking` or `tool_use`
 *  delta is an added member, not a breaking signature change. */
export type ChatDelta = { type: 'text'; text: string }

export interface StructuredRequest<T> {
  system?: string
  prompt: string
  schema: ZodType<T>
  /** Names the schema for the provider; also what MockProvider reports when it
   *  has no queued response. */
  schemaName: string
  maxTokens?: number
  /** Extraction and cardgen are high-volume background work — they run lower
   *  than the interactive chat path. */
  effort?: 'low' | 'medium' | 'high'
  /**
   * What this call should produce when there is no model at all — offline dev
   * (`TANGENT_MOCK_LLM=1`), where a background pipeline that throws would take
   * a whole feature offline with it. Only MockProvider reads it, and only in
   * that mode: tests queue their responses explicitly and a missing one still
   * fails loudly.
   */
  offlineFallback?: () => T
}

export interface LLMProvider {
  readonly chatModel: string
  /** Which endpoint the chat model is served from — worth surfacing, since
   *  the same model id means different things on different hosts. */
  readonly chatBaseUrl: string
  readonly embeddingModel: string
  /** Non-null when the provider cannot be called at all (no API key). Checked
   *  by the UI before the first ask; calls throw the same message. */
  readonly unavailable: string | null
  chat(req: ChatRequest): AsyncIterable<ChatDelta>
  structured<T>(req: StructuredRequest<T>): Promise<T>
  embed(texts: string[]): Promise<Float32Array[]>
}
