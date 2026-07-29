import type { ExtractionSummary } from '@shared/ipc'
import {
  commitCards,
  commitExtraction,
  undoExtraction,
  type ExtractionBatch,
} from '../db/extraction'
import type { Storage } from '../db/init'
import type { RendererEmit } from '../ipc/emit'
import { errorMessage } from '../util'
import { planCards } from './cardgen'
import { planExtraction } from './extraction'
import type { LLMProvider } from './provider'

/**
 * When extraction runs (spec §5.1) and what can be taken back.
 *
 * Two triggers, both meaning "that stretch of thinking is over": leaving a
 * thread, and going quiet in one. Never per-keystroke — main only ever hears
 * about committed entries, so the finest granularity available here is already
 * "a note was saved", and the idle timer coarsens it further.
 *
 * Runs are silent. The user finds out afterwards, from a chip they can undo
 * (spec §7), and the batch that chip reverses is held here in memory for as
 * long as the offer stands.
 */

/** Something engaged landed in a thread — restart its idle timer. Passed to the
 *  IPC registrars that see writes, which is why it lives here rather than in
 *  one of them. */
export type OnThreadActivity = (threadId: string) => void

/** Long enough that a pause to think isn't a trigger, short enough that the
 *  concepts are there when you come back. */
const IDLE_MS = 90_000
/** Undo is a transient offer on a chip; a handful of batches covers every one
 *  that could still be on screen. */
const MAX_UNDOABLE_BATCHES = 10

export interface ExtractionService {
  touch: OnThreadActivity
  /** The user moved to another thread (or none): extract what they left. */
  setActiveThread(threadId: string | null): void
  /** Run now, and tell the caller what happened — the dev "extract now" path. */
  run(threadId: string): Promise<ExtractionSummary>
  undo(batchId: string): void
  /** Drop pending timers (app quit). In-flight runs finish on their own. */
  dispose(): void
}

export function createExtractionService(
  storage: Storage,
  provider: LLMProvider,
  emit: RendererEmit,
  /** `idleMs` is injectable so tests don't have to wait out the real window. */
  options: { idleMs?: number } = {},
): ExtractionService {
  const idleMs = options.idleMs ?? IDLE_MS
  const timers = new Map<string, NodeJS.Timeout>()
  const running = new Map<string, Promise<ExtractionSummary>>()
  const batches = new Map<string, ExtractionBatch>()
  let activeThreadId: string | null = null

  function cancelTimer(threadId: string): void {
    const timer = timers.get(threadId)
    if (timer) {
      clearTimeout(timer)
      timers.delete(threadId)
    }
  }

  async function execute(threadId: string): Promise<ExtractionSummary> {
    const plan = await planExtraction(storage, provider, threadId)
    // Nothing engaged since last time. The common case for a timer that fires
    // while you're reading rather than writing — one query, then stop.
    if (!plan) return { threadId, batchId: null, conceptsAdded: 0, mentionsAdded: 0, cardsAdded: 0 }

    const batch = commitExtraction(storage.db, storage.repos, plan)
    const summary: ExtractionSummary = {
      threadId,
      batchId: batch.id,
      conceptsAdded: batch.createdConceptIds.length,
      mentionsAdded: batch.createdMentionIds.length,
      cardsAdded: await generateCards(batch, plan.fieldId),
    }

    // A run that consumed entries but wrote nothing new has nothing to offer
    // and nothing to take back — remembering it would evict an older batch
    // whose chip is still on screen.
    if (summary.conceptsAdded === 0 && summary.mentionsAdded === 0) return summary

    remember(batch)
    emit('extraction:committed', summary)
    return summary
  }

  /**
   * Draft cards for the concepts this batch created (spec §5.2) — only the new
   * ones, so a re-read that merely adds a mention never rewrites a card.
   *
   * The extraction is already committed by the time this runs, and that's the
   * point: cardgen is a second model call, and a failure in it costs the cards
   * and nothing else. The concepts stay, the watermarks stay stamped, and the
   * chip still reports what was learned.
   */
  async function generateCards(batch: ExtractionBatch, fieldId: string): Promise<number> {
    if (batch.createdConceptIds.length === 0) return 0
    try {
      const drafts = await planCards(storage, provider, batch.createdConceptIds)
      batch.createdFlashcardIds = commitCards(storage.db, storage.repos, fieldId, drafts)
      if (batch.createdFlashcardIds.length > 0) emit('cards:changed', { reason: 'generated' })
      return batch.createdFlashcardIds.length
    } catch (err) {
      console.warn(`Card generation failed for batch ${batch.id}: ${String(err)}`)
      return 0
    }
  }

  function remember(batch: ExtractionBatch): void {
    batches.set(batch.id, batch)
    // Map iteration is insertion-ordered, so the oldest offer is the first out.
    while (batches.size > MAX_UNDOABLE_BATCHES) {
      const oldest = batches.keys().next().value as string
      batches.delete(oldest)
    }
  }

  function run(threadId: string): Promise<ExtractionSummary> {
    cancelTimer(threadId)
    // A thread switch and a manual click can land on the same thread at once;
    // they should share one run rather than race to extract the same entries.
    const inFlight = running.get(threadId)
    if (inFlight) return inFlight
    const pending = execute(threadId).finally(() => running.delete(threadId))
    running.set(threadId, pending)
    return pending
  }

  /** Trigger-driven runs have nobody to reject to, so a failure becomes an
   *  event — an unreachable embeddings endpoint should say so, not vanish. */
  function runInBackground(threadId: string): void {
    void run(threadId).catch((err: unknown) => {
      emit('extraction:failed', { threadId, error: errorMessage(err, 'Extraction failed.') })
    })
  }

  return {
    touch(threadId) {
      cancelTimer(threadId)
      const timer = setTimeout(() => {
        timers.delete(threadId)
        runInBackground(threadId)
      }, idleMs)
      // A pending extraction is not a reason to keep the process alive.
      timer.unref?.()
      timers.set(threadId, timer)
    },

    setActiveThread(threadId) {
      const previous = activeThreadId
      activeThreadId = threadId
      if (previous && previous !== threadId) runInBackground(previous)
    },

    run,

    undo(batchId) {
      const batch = batches.get(batchId)
      if (!batch) throw new Error('That extraction can no longer be undone.')
      undoExtraction(storage.db, storage.repos, batch)
      batches.delete(batchId)
      // The batch's drafts went with it, so anyone showing the cull queue is
      // now showing cards that no longer exist.
      if (batch.createdFlashcardIds.length > 0) emit('cards:changed', { reason: 'undone' })
    },

    dispose() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}
