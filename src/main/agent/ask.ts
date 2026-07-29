import type { AgentStatus, AskRequest, AskResult } from '@shared/ipc'
import type { Storage } from '../db/init'
import { createAskPair } from '../db/timeline'
import type { RendererEmit } from '../ipc/emit'
import { errorMessage } from '../util'
import type { AgentConfig } from './config'
import { buildAskContext } from './context'
import type { LLMProvider } from './provider'

/**
 * Ask AI (spec §6, Phase 0): a question Entry and the `ai_response` Entry that
 * answers it, with the reply streamed in between.
 *
 * Both rows are written before the network call, and the question is never
 * touched again — so a failure anywhere downstream leaves the question intact
 * and the answer retryable. That is the whole design constraint: a lost network
 * call must never be a lost question.
 *
 * The reply streams to the renderer over `agent:delta` and is persisted once,
 * on completion (or on failure, with whatever partial arrived). An `ai_response`
 * with an empty body and no live stream *is* the failed state — see
 * `isUnansweredResponse` in @shared/entities; no extra column, and it survives
 * a relaunch.
 */

export interface AgentService {
  status(): AgentStatus
  ask(req: AskRequest): AskResult
  retry(entryId: string): void
  /** Stop every in-flight stream (app quit, thread teardown). */
  abortAll(): void
}

export function createAgentService(
  storage: Storage,
  provider: LLMProvider,
  config: AgentConfig,
  emit: RendererEmit,
): AgentService {
  const { entries } = storage.repos
  const inFlight = new Map<string, AbortController>()

  /** Drives one answer to completion. Never rejects — failures are reported
   *  on the entry, which is where the user can act on them. */
  async function stream(responseEntryId: string): Promise<void> {
    const controller = new AbortController()
    inFlight.set(responseEntryId, controller)
    // Synchronous, before the first await: the renderer learns the answer is
    // in flight no later than it learns the entry exists.
    emit('agent:start', { entryId: responseEntryId })
    let text = ''

    try {
      const response = entries.getById(responseEntryId)
      if (!response) throw new Error(`No such entry: ${responseEntryId}`)
      const question = response.parentEntryId ? entries.getById(response.parentEntryId) : null
      if (!question) throw new Error('This answer has no question to respond to.')

      const context = await buildAskContext(storage, question)

      for await (const delta of provider.chat({ ...context, signal: controller.signal })) {
        if (controller.signal.aborted) break
        text += delta.text
        emit('agent:delta', { entryId: responseEntryId, text: delta.text })
      }

      persist(responseEntryId, text)
      emit('agent:end', { entryId: responseEntryId, error: null })
    } catch (err) {
      // Keep the partial answer: a truncated reply is more useful than a blank
      // one, and retry overwrites it either way.
      if (text) persist(responseEntryId, text)
      emit('agent:end', {
        entryId: responseEntryId,
        error: errorMessage(err, 'The request failed.'),
      })
    } finally {
      inFlight.delete(responseEntryId)
    }
  }

  /** This runs detached from any IPC call, so a write that fails (a DB closing
   *  under a stream at shutdown) must not become an unhandled rejection. */
  function persist(entryId: string, body: string): void {
    try {
      entries.updateBody(entryId, body)
    } catch (err) {
      console.warn(`Could not persist answer ${entryId}: ${String(err)}`)
    }
  }

  return {
    status: () => ({
      provider: config.provider,
      model: provider.chatModel,
      baseUrl: provider.chatBaseUrl,
      embeddingProvider: config.embeddingProvider,
      embeddingModel: provider.embeddingModel,
      unavailable: provider.unavailable,
    }),

    ask(req) {
      const pair = createAskPair(storage.db, storage.repos, req)
      void stream(pair.response.id)
      return pair
    },

    retry(entryId) {
      const entry = entries.getById(entryId)
      if (!entry) throw new Error(`No such entry: ${entryId}`)
      if (entry.kind !== 'ai_response') throw new Error('Only AI responses can be retried.')
      if (inFlight.has(entryId)) throw new Error('That answer is already being generated.')

      entries.updateBody(entryId, '')
      void stream(entryId)
    },

    abortAll() {
      for (const controller of inFlight.values()) controller.abort()
      inFlight.clear()
    },
  }
}
