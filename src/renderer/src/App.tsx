import { useEffect, useState } from 'react'
import Sidebar from './sidebar/Sidebar'
import DocumentPane from './panes/DocumentPane/DocumentPane'
import NotesPane from './panes/NotesPane/NotesPane'
import DevStats from './DevStats'
import SplitView, { type SplitPane } from './layout/SplitView'
import { useAppStore } from './state/appStore'
import { useTimelineStore } from './state/timelineStore'

export default function App() {
  const refreshThreads = useAppStore((s) => s.refreshThreads)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const documentPaneOpen = useAppStore((s) => s.documentPaneOpen)
  const notesPaneOpen = useAppStore((s) => s.notesPaneOpen)
  const toggleDocumentPane = useAppStore((s) => s.toggleDocumentPane)
  const toggleNotesPane = useAppStore((s) => s.toggleNotesPane)
  const error = useAppStore((s) => s.error)
  const clearError = useAppStore((s) => s.clearError)
  const [showDevStats, setShowDevStats] = useState(false)

  useEffect(() => {
    refreshThreads()
  }, [refreshThreads])

  // Streaming answers arrive as main-process pushes, not as responses to a
  // call — subscribe once for the app's lifetime.
  useEffect(() => {
    const unsubscribe = useTimelineStore.getState().subscribeAgent()
    void useTimelineStore.getState().loadAgentStatus()
    return unsubscribe
  }, [])

  // Timeline loads at app level (not in NotesPane) — the document pane needs
  // the thread's anchors for highlights even when the notes pane is closed.
  useEffect(() => {
    void useTimelineStore.getState().load(activeThreadId)
  }, [activeThreadId])

  // The shell is a split of whatever is open: dividers appear between the
  // panes that exist, and the survivors keep their proportions when one is
  // toggled off. Min sizes are the point below which a pane stops being
  // usable — a PDF column narrower than this is unreadable, not compact.
  const panes: SplitPane[] = [{ id: 'sidebar', minSize: 150, node: <Sidebar /> }]
  if (documentPaneOpen) panes.push({ id: 'document', minSize: 280, node: <DocumentPane /> })
  if (notesPaneOpen) panes.push({ id: 'notes', minSize: 260, node: <NotesPane /> })
  if (!documentPaneOpen && !notesPaneOpen) {
    panes.push({
      id: 'empty',
      node: <p className="pane-status all-closed">Both panes are closed.</p>,
    })
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-name">Tangent</span>
        <div className="header-actions">
          <button
            className={documentPaneOpen ? 'pane-toggle on' : 'pane-toggle'}
            onClick={toggleDocumentPane}
          >
            Document
          </button>
          <button
            className={notesPaneOpen ? 'pane-toggle on' : 'pane-toggle'}
            onClick={toggleNotesPane}
          >
            Notes
          </button>
          <button className="pane-toggle" onClick={() => setShowDevStats((v) => !v)}>
            DB
          </button>
        </div>
      </header>
      {error && (
        <div className="error-banner">
          {error} <button onClick={clearError}>dismiss</button>
        </div>
      )}
      <SplitView className="app-body" panes={panes} />
      {showDevStats && <DevStats onClose={() => setShowDevStats(false)} />}
    </div>
  )
}
