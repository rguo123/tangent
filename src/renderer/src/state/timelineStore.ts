import { create } from 'zustand'
import type { Anchor, Entry, TextQuoteSelector } from '@shared/entities'
import type { AgentStatus } from '@shared/ipc'
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
 *
 * Streaming answers are the one place the renderer holds text main hasn't
 * persisted yet: `streaming[entryId]` is the live reply, replaced by the
 * stored body as soon as the stream ends. Its *presence* (even as an empty
 * string) means "in flight" — which is what separates a thinking answer from
 * a failed one.
 */
interface TimelineState {
  threadId: string | null
  entries: Entry[]
  anchors: Anchor[]
  draft: DraftAnchor | null
  /** Composer mode when no draft anchor is armed: write a note, or ask. */
  composerMode: 'note' | 'question'
  /** entryId → text received so far. Key present ⇒ stream in flight. */
  streaming: Record<string, string>
  /** entryId → why the last attempt failed. */
  failed: Record<string, string>
  agentStatus: AgentStatus | null
  /** Document pane: scroll to this anchor's region. */
  docJump: { anchor: Anchor; nonce: number } | null
  /** Notes pane: scroll to this anchor's entries. */
  entryFocus: { anchorId: string; nonce: number } | null

  load: (threadId: string | null) => Promise<void>
  refresh: () => Promise<void>
  submitEntry: (body: string) => Promise<void>
  updateEntryBody: (entryId: string, body: string) => Promise<void>
  setPinned: (entryId: string, pinned: boolean) => Promise<void>
  retryAsk: (entryId: string) => Promise<void>
  setComposerMode: (mode: 'note' | 'question') => void
  armDraft: (draft: DraftAnchor) => void
  clearDraft: () => void
  jumpToAnchor: (anchorId: string) => void
  focusEntriesForAnchor: (anchorId: string) => void
  /** Wire up main's streaming pushes. Returns an unsubscribe. */
  subscribeAgent: () => () => void
  loadAgentStatus: () => Promise<void>
}

/** What the composer will submit: an armed draft names its own kind (the
 *  selection menu already asked), so it wins over the mode toggle. One
 *  definition, used by both the composer's labels and its submit path. */
export const activeComposerKind = (s: TimelineState): 'note' | 'question' =>
  s.draft?.kind ?? s.composerMode

export const useTimelineStore = create<TimelineState>((set, get) => ({
  threadId: null,
  entries: [],
  anchors: [],
  draft: null,
  composerMode: 'note',
  streaming: {},
  failed: {},
  agentStatus: null,
  docJump: null,
  entryFocus: null,

  load: async (threadId) => {
    // Streaming/failed state is keyed by entry id and deliberately survives a
    // thread switch — an answer still generating in another thread keeps
    // streaming, and lands correctly when you switch back.
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
    const state = get()
    const { threadId, draft } = state
    if (!threadId) return
    const anchor = draft ? { documentId: draft.documentId, selector: draft.selector } : undefined
    try {
      // In-flight state comes from `agent:start`, not from here — the first
      // deltas can land before this call resolves.
      if (activeComposerKind(state) === 'question') {
        await window.tangent.agent.ask({ threadId, body, anchor })
      } else {
        await window.tangent.entries.create({ threadId, kind: 'note', body, anchor })
      }
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

  setPinned: async (entryId, pinned) => {
    try {
      // Patch the one row the handler returns rather than re-pulling the
      // thread: a full refresh gives every entry a new identity, which
      // re-renders answers that are mid-stream.
      const updated = await window.tangent.entries.setPinned(entryId, pinned)
      set((s) => ({ entries: s.entries.map((e) => (e.id === updated.id ? updated : e)) }))
    } catch (err) {
      reportError(err)
    }
  },

  retryAsk: async (entryId) => {
    try {
      // In-flight and failed state both come from `agent:start`.
      await window.tangent.agent.retry(entryId)
    } catch (err) {
      reportError(err)
    }
  },

  setComposerMode: (composerMode) => set({ composerMode }),
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

  subscribeAgent: () => {
    const offStart = window.tangent.agent.onStart(({ entryId }) => {
      set((s) => ({
        streaming: { ...s.streaming, [entryId]: s.streaming[entryId] ?? '' },
        failed: omit(s.failed, entryId),
      }))
    })
    const offDelta = window.tangent.agent.onDelta(({ entryId, text }) => {
      set((s) => ({
        streaming: { ...s.streaming, [entryId]: (s.streaming[entryId] ?? '') + text },
      }))
    })
    const offEnd = window.tangent.agent.onEnd(async ({ entryId, error }) => {
      // Pull the persisted body *before* dropping the live text, so the answer
      // never blinks out between the two.
      await get().refresh()
      set((s) => ({
        streaming: omit(s.streaming, entryId),
        failed: error ? { ...s.failed, [entryId]: error } : omit(s.failed, entryId),
      }))
    })
    return () => {
      offStart()
      offDelta()
      offEnd()
    }
  },

  loadAgentStatus: async () => {
    try {
      set({ agentStatus: await window.tangent.agent.status() })
    } catch (err) {
      reportError(err)
    }
  },
}))

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const rest = { ...record }
  delete rest[key]
  return rest
}
