import { useState } from 'react'
import { isWebDocument, type SourceType } from '@shared/entities'
import type { ThreadListItem } from '@shared/ipc'
import { useAppStore } from '../state/appStore'

const SOURCE_BADGE: Record<SourceType, string> = {
  pdf: 'PDF',
  markdown: 'MD',
  generated: 'GEN',
  chat_transcript: 'CHAT',
}

function badgeFor(document: ThreadListItem['document']): string {
  return isWebDocument(document) ? 'WEB' : SOURCE_BADGE[document.sourceType]
}

/** Accepts what a person actually pastes: a bare `example.com/post` gets the
 *  scheme it obviously meant. Anything that still isn't http(s) is rejected
 *  here rather than after a round trip. */
function normalizeUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function UrlImport() {
  const importUrl = useAppStore((s) => s.importUrl)
  const importingUrl = useAppStore((s) => s.importingUrl)
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const url = normalizeUrl(value)
    if (!url) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    // Keep the text on failure — a typo is worth correcting, not retyping.
    if (await importUrl(url)) setValue('')
  }

  return (
    <form className="url-import" onSubmit={submit}>
      <input
        type="text"
        className={invalid ? 'url-input invalid' : 'url-input'}
        placeholder="Paste an article URL"
        value={value}
        disabled={importingUrl}
        onChange={(e) => {
          setValue(e.target.value)
          setInvalid(false)
        }}
      />
      <button type="submit" className="url-submit" disabled={importingUrl || !value.trim()}>
        {importingUrl ? '…' : 'Add'}
      </button>
    </form>
  )
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
      <span className="thread-badge">{badgeFor(document)}</span>
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
      <UrlImport />
      {active.length === 0 ? (
        <p className="sidebar-empty">
          No threads yet. Import a PDF or markdown file — or paste an article URL — to start
          reading.
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
