import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isUnansweredResponse, type Anchor, type Entry } from '@shared/entities'
import Markdown from '../../Markdown'
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

/** Kind, timestamp, and whatever action the entry offers. */
function EntryHeader({ entry, children }: { entry: Entry; children?: ReactNode }) {
  return (
    <header className="entry-meta">
      <span className="entry-kind">{KIND_LABEL[entry.kind]}</span>
      <time>{new Date(entry.createdAt).toLocaleString()}</time>
      {children}
    </header>
  )
}

/**
 * An `ai_response` is in exactly one of these. A live stream (key present in
 * `streaming`) is thinking then answering; without one, an empty body is a
 * failed ask. That holds after a relaunch too, with no status column.
 */
type AnswerState = 'thinking' | 'answering' | 'answered' | 'failed'

function AiResponse({ entry, replyingTo }: { entry: Entry; replyingTo: Entry | null }) {
  const live = useTimelineStore((s) => s.streaming[entry.id])
  const error = useTimelineStore((s) => s.failed[entry.id])
  const retryAsk = useTimelineStore((s) => s.retryAsk)
  const setPinned = useTimelineStore((s) => s.setPinned)

  const state: AnswerState =
    live !== undefined
      ? live
        ? 'answering'
        : 'thinking'
      : isUnansweredResponse(entry)
        ? 'failed'
        : 'answered'

  return (
    <article className="entry entry-ai_response">
      <EntryHeader entry={entry}>
        {state === 'answered' && (
          <button
            className={entry.pinned ? 'entry-action pinned' : 'entry-action'}
            title={
              entry.pinned
                ? 'Pinned — this answer counts as engagement for extraction'
                : 'Pin to keep this answer as a durable note'
            }
            onClick={() => void setPinned(entry.id, !entry.pinned)}
          >
            {entry.pinned ? '★ pinned' : '☆ pin'}
          </button>
        )}
        {state === 'failed' && (
          <button className="entry-action" onClick={() => void retryAsk(entry.id)}>
            retry
          </button>
        )}
      </EntryHeader>
      {/* Only shown when the answer isn't sitting right under its question —
          two questions in flight land out of order. */}
      {replyingTo && (
        <p className="entry-reply-to" title={replyingTo.body}>
          replying to “{replyingTo.body}”
        </p>
      )}
      {error && <p className="entry-error">{error}</p>}
      {state === 'thinking' && <p className="entry-body entry-thinking">Thinking…</p>}
      {state === 'failed' && (
        <p className="entry-body entry-thinking">No answer — retry to try again.</p>
      )}
      {/* Markdown is re-parsed on every delta; partial syntax renders as the
          plain text it currently is, and resolves as the rest arrives. The
          caret rides the last block via CSS, so it stays inline. */}
      {(state === 'answering' || state === 'answered') && (
        <Markdown
          source={state === 'answering' ? live : entry.body}
          className={state === 'answering' ? 'entry-body streaming' : 'entry-body'}
        />
      )}
    </article>
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
    <article className={`entry entry-${entry.kind}`} data-anchor-id={entry.anchorId ?? undefined}>
      <EntryHeader entry={entry}>
        {!editing && (
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
      </EntryHeader>
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
        // Edit mode is the raw markdown; this is the rendered form of it.
        <Markdown source={entry.body} className="entry-body" />
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
  const entryById = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries])

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
        {entries.map((entry, index) => {
          if (entry.kind === 'ai_response') {
            const parent = entry.parentEntryId ? (entryById.get(entry.parentEntryId) ?? null) : null
            const adjacent = entries[index - 1]?.id === entry.parentEntryId
            return <AiResponse key={entry.id} entry={entry} replyingTo={adjacent ? null : parent} />
          }
          return (
            <EntryItem
              key={entry.id}
              entry={entry}
              anchor={entry.anchorId ? (anchorById.get(entry.anchorId) ?? null) : null}
            />
          )
        })}
      </div>
      <Composer />
    </section>
  )
}
