import { useEffect, useMemo, useRef, useState } from 'react'
import type { Anchor, Entry } from '@shared/entities'
import { useAppStore } from '../../state/appStore'
import { useTimelineStore } from '../../state/timelineStore'
import Composer from './Composer'

const KIND_LABEL: Record<Entry['kind'], string> = {
  note: 'Note',
  question: 'Question',
  ai_response: 'AI',
}

/** The quote an entry is anchored to. Click → document pane jumps there. */
function QuoteChip({ anchor }: { anchor: Anchor }) {
  const jumpToAnchor = useTimelineStore((s) => s.jumpToAnchor)
  return (
    <button
      className="quote-chip"
      title={anchor.selector.exact}
      onClick={() => jumpToAnchor(anchor.id)}
    >
      {anchor.selector.pageNumber !== undefined && (
        <span className="quote-page">p.{anchor.selector.pageNumber}</span>
      )}
      <span className="quote-text">{anchor.selector.exact}</span>
    </button>
  )
}

function EntryItem({ entry, anchor }: { entry: Entry; anchor: Anchor | null }) {
  const updateEntryBody = useTimelineStore((s) => s.updateEntryBody)
  const [editing, setEditing] = useState(false)
  const [draftBody, setDraftBody] = useState('')

  const save = async () => {
    const body = draftBody.trim()
    if (body && body !== entry.body) await updateEntryBody(entry.id, body)
    setEditing(false)
  }

  return (
    <article
      className={`entry entry-${entry.kind}`}
      data-anchor-id={entry.anchorId ?? undefined}
    >
      <header className="entry-meta">
        <span className="entry-kind">{KIND_LABEL[entry.kind]}</span>
        <time>{new Date(entry.createdAt).toLocaleString()}</time>
        {entry.kind !== 'ai_response' && !editing && (
          <button
            className="entry-action"
            onClick={() => {
              setDraftBody(entry.body)
              setEditing(true)
            }}
          >
            edit
          </button>
        )}
      </header>
      {anchor && <QuoteChip anchor={anchor} />}
      {editing ? (
        <div className="entry-edit">
          <textarea value={draftBody} onChange={(e) => setDraftBody(e.target.value)} autoFocus />
          <div className="entry-edit-actions">
            <button onClick={save}>Save</button>
            <button onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <p className="entry-body">{entry.body}</p>
      )}
    </article>
  )
}

/** The notes half of the unified surface: chronological entry timeline over
 *  the active thread, composer at the bottom. */
export default function NotesPane() {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const entries = useTimelineStore((s) => s.entries)
  const anchors = useTimelineStore((s) => s.anchors)
  const entryFocus = useTimelineStore((s) => s.entryFocus)
  const listRef = useRef<HTMLDivElement>(null)

  const anchorById = useMemo(() => new Map(anchors.map((a) => [a.id, a])), [anchors])

  // Cross-navigation: highlight click → scroll to that anchor's entries and
  // flash them.
  useEffect(() => {
    if (!entryFocus) return
    const el = listRef.current?.querySelector(`[data-anchor-id="${entryFocus.anchorId}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.add('flash')
    const timer = setTimeout(() => el.classList.remove('flash'), 1600)
    return () => clearTimeout(timer)
  }, [entryFocus])

  // New entry → keep the timeline pinned to the bottom, where it landed.
  const prevCount = useRef(0)
  useEffect(() => {
    if (entries.length > prevCount.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
    prevCount.current = entries.length
  }, [entries.length])

  if (!activeThreadId) {
    return (
      <section className="pane notes-pane">
        <header className="pane-header">
          <span className="pane-title">Notes + chat</span>
        </header>
        <div className="pane-body">
          <p className="pane-status">Open a thread to take notes.</p>
        </div>
      </section>
    )
  }

  return (
    <section className="pane notes-pane">
      <header className="pane-header">
        <span className="pane-title">Notes + chat</span>
      </header>
      <div className="pane-body entry-list" ref={listRef}>
        {entries.length === 0 && (
          <p className="pane-status">
            No entries yet — write a note below, or select text in the document.
          </p>
        )}
        {entries.map((entry) => (
          <EntryItem
            key={entry.id}
            entry={entry}
            anchor={entry.anchorId ? (anchorById.get(entry.anchorId) ?? null) : null}
          />
        ))}
      </div>
      <Composer />
    </section>
  )
}
