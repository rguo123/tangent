import { useEffect, useRef, useState } from 'react'
import type { DocumentContent } from '@shared/ipc'
import { anchorAtPoint } from '../../lib/highlights'
import { useAppStore } from '../../state/appStore'
import { useTimelineStore } from '../../state/timelineStore'
import PdfView from './PdfView'
import MarkdownView from './MarkdownView'
import SelectionMenu from './SelectionMenu'
import { readSelection, type PendingSelection } from './selection'

/** Renders the active Thread's Document. Read-only throughout — documents are
 *  immutable after import (spec §2), so there are no edit affordances. What
 *  *is* interactive: selecting text (→ note/ask menu) and clicking painted
 *  highlights (→ scroll the timeline to their entries). */
export default function DocumentPane() {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const item = useAppStore((s) => s.threads.find((t) => t.thread.id === s.activeThreadId))
  const openNotesPane = useAppStore((s) => s.openNotesPane)
  const armDraft = useTimelineStore((s) => s.armDraft)
  const focusEntriesForAnchor = useTimelineStore((s) => s.focusEntriesForAnchor)
  const documentId = item?.document.id ?? null

  const bodyRef = useRef<HTMLDivElement>(null)
  const [content, setContent] = useState<DocumentContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<PendingSelection | null>(null)

  useEffect(() => {
    setContent(null)
    setError(null)
    setMenu(null)
    if (!documentId) return
    let stale = false
    window.tangent.documents
      .content(documentId)
      .then((c) => {
        if (!stale) setContent(c)
      })
      .catch((err: unknown) => {
        if (!stale) setError(String(err))
      })
    return () => {
      stale = true
    }
  }, [documentId])

  // Selection → floating menu. Read after the browser has finalized the
  // selection for this mouseup; a click that collapses it hides the menu.
  const handleMouseUp = () => {
    requestAnimationFrame(() => setMenu(readSelection(bodyRef.current, documentId)))
  }

  // Click on a painted highlight → timeline scrolls to its entries. Skipped
  // while a selection is live (the click that ends a drag-select).
  const handleClick = (e: React.MouseEvent) => {
    if (!window.getSelection()?.isCollapsed) return
    const anchorId = anchorAtPoint(e.clientX, e.clientY)
    if (anchorId) focusEntriesForAnchor(anchorId)
  }

  const pickAnchorKind = (kind: 'note' | 'question') => {
    if (!menu) return
    armDraft({ kind, documentId: menu.documentId, selector: menu.selector })
    openNotesPane()
    window.getSelection()?.removeAllRanges()
    setMenu(null)
  }

  return (
    <section className="pane document-pane">
      <header className="pane-header">
        <span className="pane-title" title={item?.document.title}>
          {item ? item.document.title : 'Document'}
        </span>
      </header>
      <div
        className="pane-body"
        ref={bodyRef}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        onScrollCapture={() => menu && setMenu(null)}
      >
        {!activeThreadId && (
          <p className="pane-status">Select a thread — or import a document — to read.</p>
        )}
        {error && <p className="pane-status error">{error}</p>}
        {activeThreadId && !content && !error && <p className="pane-status">Loading…</p>}
        {content?.sourceType === 'pdf' && documentId && (
          <PdfView data={content.data} documentId={documentId} />
        )}
        {(content?.sourceType === 'markdown' || content?.sourceType === 'generated') &&
          documentId && <MarkdownView content={content.content} documentId={documentId} />}
      </div>
      {menu && <SelectionMenu selection={menu} onPick={pickAnchorKind} />}
    </section>
  )
}
