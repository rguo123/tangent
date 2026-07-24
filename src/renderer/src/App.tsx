import { useEffect, useState } from 'react'
import Sidebar from './sidebar/Sidebar'
import DocumentPane from './panes/DocumentPane/DocumentPane'
import NotesPane from './panes/NotesPane/NotesPane'
import DevStats from './DevStats'
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

  // Timeline loads at app level (not in NotesPane) — the document pane needs
  // the thread's anchors for highlights even when the notes pane is closed.
  useEffect(() => {
    void useTimelineStore.getState().load(activeThreadId)
  }, [activeThreadId])

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
      <div className="app-body">
        <Sidebar />
        {documentPaneOpen && <DocumentPane />}
        {notesPaneOpen && <NotesPane />}
        {!documentPaneOpen && !notesPaneOpen && (
          <p className="pane-status all-closed">Both panes are closed.</p>
        )}
      </div>
      {showDevStats && <DevStats onClose={() => setShowDevStats(false)} />}
    </div>
  )
}
