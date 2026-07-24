import { create } from 'zustand'
import type { Anchor, Entry, TextQuoteSelector } from '@shared/entities'
import { reportError, useAppStore } from './appStore'

/** A selection the user picked "note"/"ask" on, waiting in the composer. The
 *  anchor row is only created when the entry is submitted. */
export interface DraftAnchor {
  kind: 'note' | 'question'
  documentId: string
  selector: TextQuoteSelector
}

/**
 * Timeline state for the active thread. Same philosophy as appStore: main
 * owns the truth, so mutations go over IPC and re-pull. The two `nonce`d
 * fields are one-shot cross-navigation signals — document pane and notes
 * pane each consume the one aimed at them.
 */
interface TimelineState {
  threadId: string | null
  entries: Entry[]
  anchors: Anchor[]
  draft: DraftAnchor | null
  /** Document pane: scroll to this anchor's region. */
  docJump: { anchor: Anchor; nonce: number } | null
  /** Notes pane: scroll to this anchor's entries. */
  entryFocus: { anchorId: string; nonce: number } | null

  load: (threadId: string | null) => Promise<void>
  refresh: () => Promise<void>
  submitEntry: (body: string) => Promise<void>
  updateEntryBody: (entryId: string, body: string) => Promise<void>
  armDraft: (draft: DraftAnchor) => void
  clearDraft: () => void
  jumpToAnchor: (anchorId: string) => void
  focusEntriesForAnchor: (anchorId: string) => void
}

export const useTimelineStore = create<TimelineState>((set, get) => ({
  threadId: null,
  entries: [],
  anchors: [],
  draft: null,
  docJump: null,
  entryFocus: null,

  load: async (threadId) => {
    set({ threadId, entries: [], anchors: [], draft: null, docJump: null, entryFocus: null })
    if (threadId) await get().refresh()
  },

  refresh: async () => {
    const { threadId } = get()
    if (!threadId) return
    try {
      const data = await window.tangent.timeline.get(threadId)
      if (get().threadId === threadId) set(data)
    } catch (err) {
      reportError(err)
    }
  },

  submitEntry: async (body) => {
    const { threadId, draft } = get()
    if (!threadId) return
    try {
      await window.tangent.entries.create({
        threadId,
        kind: draft?.kind ?? 'note',
        body,
        anchor: draft ? { documentId: draft.documentId, selector: draft.selector } : undefined,
      })
      set({ draft: null })
      await get().refresh()
    } catch (err) {
      reportError(err)
    }
  },

  updateEntryBody: async (entryId, body) => {
    try {
      await window.tangent.entries.updateBody(entryId, body)
      await get().refresh()
    } catch (err) {
      reportError(err)
    }
  },

  armDraft: (draft) => set({ draft }),
  clearDraft: () => set({ draft: null }),

  jumpToAnchor: (anchorId) => {
    const anchor = get().anchors.find((a) => a.id === anchorId)
    if (!anchor) return
    useAppStore.getState().openDocumentPane()
    set((s) => ({ docJump: { anchor, nonce: (s.docJump?.nonce ?? 0) + 1 } }))
  },

  focusEntriesForAnchor: (anchorId) => {
    useAppStore.getState().openNotesPane()
    set((s) => ({ entryFocus: { anchorId, nonce: (s.entryFocus?.nonce ?? 0) + 1 } }))
  },
}))
