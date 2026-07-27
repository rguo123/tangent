import { create } from 'zustand'
import type { ThreadStatus } from '@shared/entities'
import type { ThreadListItem } from '@shared/ipc'

/**
 * Renderer app state. Thin by design — main owns the truth, so every mutation
 * goes over IPC and then re-pulls the thread list rather than patching a
 * local copy.
 */
interface AppState {
  threads: ThreadListItem[]
  activeThreadId: string | null
  documentPaneOpen: boolean
  notesPaneOpen: boolean
  error: string | null
  /** A web clip is in flight. Unlike the file picker, this one takes seconds —
   *  a real browser has to load the page — so the UI has to say so. */
  importingUrl: boolean

  refreshThreads: () => Promise<void>
  importDocument: () => Promise<void>
  importUrl: (url: string) => Promise<boolean>
  selectThread: (threadId: string) => void
  setThreadStatus: (threadId: string, status: ThreadStatus) => Promise<void>
  toggleDocumentPane: () => void
  toggleNotesPane: () => void
  /** Cross-navigation targets a pane; make sure it's visible first. */
  openDocumentPane: () => void
  openNotesPane: () => void
  clearError: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  threads: [],
  activeThreadId: null,
  documentPaneOpen: true,
  notesPaneOpen: true,
  error: null,
  importingUrl: false,

  refreshThreads: async () => {
    try {
      set({ threads: await window.tangent.threads.list() })
    } catch (err) {
      reportError(err)
    }
  },

  importDocument: async () => {
    try {
      const result = await window.tangent.documents.import()
      if (!result) return // picker canceled
      await get().refreshThreads()
      set({ activeThreadId: result.thread.id })
    } catch (err) {
      reportError(err)
    }
  },

  /** Resolves true when the clip landed, so the caller can clear its input
   *  only on success and leave a failed URL there to retry or correct. */
  importUrl: async (url) => {
    if (get().importingUrl) return false
    set({ importingUrl: true, error: null })
    try {
      const result = await window.tangent.documents.importUrl(url)
      await get().refreshThreads()
      set({ activeThreadId: result.thread.id })
      return true
    } catch (err) {
      reportError(err)
      return false
    } finally {
      set({ importingUrl: false })
    }
  },

  selectThread: (threadId) => set({ activeThreadId: threadId }),

  setThreadStatus: async (threadId, status) => {
    try {
      await window.tangent.threads.setStatus(threadId, status)
      await get().refreshThreads()
      // Archiving the open thread closes it.
      if (status === 'archived' && get().activeThreadId === threadId) {
        set({ activeThreadId: null })
      }
    } catch (err) {
      reportError(err)
    }
  },

  toggleDocumentPane: () => set((s) => ({ documentPaneOpen: !s.documentPaneOpen })),
  toggleNotesPane: () => set((s) => ({ notesPaneOpen: !s.notesPaneOpen })),
  openDocumentPane: () => set({ documentPaneOpen: true }),
  openNotesPane: () => set({ notesPaneOpen: true }),
  clearError: () => set({ error: null }),
}))

/** Surface an unknown error in the app-level banner — the one error path for
 *  every store's IPC calls. */
export function reportError(err: unknown): void {
  useAppStore.setState({ error: String(err) })
}
