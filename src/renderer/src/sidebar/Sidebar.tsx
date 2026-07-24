import { useState } from 'react'
import type { SourceType } from '@shared/entities'
import type { ThreadListItem } from '@shared/ipc'
import { useAppStore } from '../state/appStore'

const SOURCE_BADGE: Record<SourceType, string> = {
  pdf: 'PDF',
  markdown: 'MD',
  generated: 'GEN',
  chat_transcript: 'CHAT',
}

function ThreadRow({ item }: { item: ThreadListItem }) {
  const { thread, document } = item
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const selectThread = useAppStore((s) => s.selectThread)
  const setThreadStatus = useAppStore((s) => s.setThreadStatus)
  const archived = thread.status === 'archived'

  return (
    <li
      className={`thread-row ${thread.id === activeThreadId ? 'selected' : ''}`}
      onClick={() => selectThread(thread.id)}
    >
      <span className="thread-badge">{SOURCE_BADGE[document.sourceType]}</span>
      <span className="thread-title" title={thread.title}>
        {thread.title}
      </span>
      <button
        className="thread-action"
        title={archived ? 'Unarchive' : 'Archive'}
        onClick={(e) => {
          e.stopPropagation()
          setThreadStatus(thread.id, archived ? 'active' : 'archived')
        }}
      >
        {archived ? '↩' : '⌫'}
      </button>
    </li>
  )
}

function ThreadList({ items, archived }: { items: ThreadListItem[]; archived?: boolean }) {
  return (
    <ul className={archived ? 'thread-list archived' : 'thread-list'}>
      {items.map((item) => (
        <ThreadRow key={item.thread.id} item={item} />
      ))}
    </ul>
  )
}

export default function Sidebar() {
  const threads = useAppStore((s) => s.threads)
  const importDocument = useAppStore((s) => s.importDocument)
  const [showArchived, setShowArchived] = useState(false)

  const active = threads.filter((t) => t.thread.status === 'active')
  const archived = threads.filter((t) => t.thread.status === 'archived')

  return (
    <nav className="sidebar">
      <button className="import-button" onClick={importDocument}>
        + Import document
      </button>
      {active.length === 0 ? (
        <p className="sidebar-empty">
          No threads yet. Import a PDF or markdown file to start reading.
        </p>
      ) : (
        <ThreadList items={active} />
      )}
      {archived.length > 0 && (
        <>
          <button className="archived-toggle" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? '▾' : '▸'} Archived ({archived.length})
          </button>
          {showArchived && <ThreadList items={archived} archived />}
        </>
      )}
    </nav>
  )
}
