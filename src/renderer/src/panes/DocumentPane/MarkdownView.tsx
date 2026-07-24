import { useEffect, useMemo, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { marked } from 'marked'
import { clearRegionHighlights, getAnchorRange, paintAnchors } from '../../lib/highlights'
import { useTimelineStore } from '../../state/timelineStore'

const REGION = 'markdown'

/**
 * Read-only Tiptap view for markdown/generated documents. Tiptap (not plain
 * HTML) so anchors' text-quote selectors resolve against the same rendered
 * text the composer stack uses. `editable: false` is the immutability rule
 * (spec §2) — there is deliberately no edit mode.
 */
export default function MarkdownView({
  content,
  documentId,
}: {
  content: string
  documentId: string
}) {
  const html = useMemo(() => marked.parse(content, { async: false }), [content])
  const editor = useEditor(
    {
      extensions: [StarterKit],
      content: html,
      editable: false,
    },
    [html],
  )
  const containerRef = useRef<HTMLDivElement>(null)

  const anchors = useTimelineStore((s) => s.anchors)
  const docJump = useTimelineStore((s) => s.docJump)
  const documentAnchors = useMemo(
    () => anchors.filter((a) => a.documentId === documentId),
    [anchors, documentId],
  )

  // Paint highlights once the editor DOM is committed (rAF: EditorContent
  // mounts the ProseMirror view in its own effect).
  useEffect(() => {
    if (!editor) return
    const frame = requestAnimationFrame(() => {
      const root = containerRef.current?.querySelector('.tiptap')
      if (root) paintAnchors(REGION, root, documentAnchors)
    })
    return () => {
      cancelAnimationFrame(frame)
      clearRegionHighlights(REGION)
    }
  }, [editor, html, documentAnchors])

  // Cross-navigation: markdown has no pages to degrade to, so a quote that
  // no longer matches simply doesn't move the view.
  useEffect(() => {
    if (!docJump || docJump.anchor.documentId !== documentId) return
    const range = getAnchorRange(docJump.anchor.id)
    range?.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [docJump, documentId])

  return (
    <div ref={containerRef}>
      <EditorContent editor={editor} className="markdown-view" />
    </div>
  )
}
