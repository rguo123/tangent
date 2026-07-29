import { create } from 'zustand'
import type { ExtractionSummary } from '@shared/ipc'
import { plural } from '../lib/plural'
import { reportError } from './appStore'

/**
 * The extraction chip (spec §7): extraction writes silently, and the only
 * thing it owes the user afterwards is a note of what it did and a way to take
 * it back.
 *
 * Deliberately not an error path. A failed background run says so on the same
 * chip and disappears with it — nothing was written, the entries are still due,
 * and there is nothing for the user to fix mid-sentence.
 */

export interface ExtractionNotice {
  /** Null when there's nothing to undo — a quiet run, or an already-undone one. */
  batchId: string | null
  text: string
  failed: boolean
  /** Drafts waiting in the Artifacts pane because of this run — the chip is
   *  where the user finds out there is a cull pass to do. */
  cardsAdded: number
}

interface ExtractionState {
  notice: ExtractionNotice | null
  /** Wire up main's pushes. Returns an unsubscribe. */
  subscribe: () => () => void
  /** Dev "extract now": run and report, including the nothing-to-do case that
   *  background runs stay quiet about. */
  runNow: (threadId: string) => Promise<void>
  undo: () => Promise<void>
  dismiss: () => void
}

export const useExtractionStore = create<ExtractionState>((set, get) => ({
  notice: null,

  subscribe: () => {
    const offCommitted = window.tangent.extraction.onCommitted((summary) => {
      set((s) => ({ notice: noticeFor(summary, s.notice) }))
    })
    const offFailed = window.tangent.extraction.onFailed(({ error }) => {
      set({ notice: { batchId: null, text: error, failed: true, cardsAdded: 0 } })
    })
    return () => {
      offCommitted()
      offFailed()
    }
  },

  runNow: async (threadId) => {
    try {
      const summary = await window.tangent.extraction.run(threadId)
      set((s) => ({ notice: noticeFor(summary, s.notice) }))
    } catch (err) {
      set({ notice: { batchId: null, text: String(err), failed: true, cardsAdded: 0 } })
    }
  },

  undo: async () => {
    const { notice } = get()
    if (!notice?.batchId) return
    try {
      await window.tangent.extraction.undo(notice.batchId)
      // Undo takes the batch's draft cards with it, which the cards store hears
      // about over `cards:changed` — main is the one that knows what went.
      set({ notice: { batchId: null, text: 'Extraction undone', failed: false, cardsAdded: 0 } })
    } catch (err) {
      reportError(err)
    }
  },

  dismiss: () => set({ notice: null }),
}))

/** A run that reached the renderer twice — once as the manual call's result,
 *  once as the broadcast every window gets — is one event. Returning the same
 *  object keeps the chip's dismiss timer running from when it appeared, since
 *  the timer keys on notice identity. */
function noticeFor(summary: ExtractionSummary, current: ExtractionNotice | null): ExtractionNotice {
  if (current && summary.batchId !== null && current.batchId === summary.batchId) return current
  return {
    batchId: summary.batchId,
    text: describe(summary),
    failed: false,
    cardsAdded: summary.cardsAdded,
  }
}

function describe({ conceptsAdded, mentionsAdded, cardsAdded }: ExtractionSummary): string {
  const parts: string[] = []
  if (conceptsAdded > 0) parts.push(`${plural(conceptsAdded, 'concept')} added`)
  if (mentionsAdded > 0) parts.push(plural(mentionsAdded, 'mention'))
  if (cardsAdded > 0) parts.push(plural(cardsAdded, 'card'))
  return parts.length > 0 ? parts.join(' · ') : 'No new concepts'
}
