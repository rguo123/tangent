import { useEffect, useMemo, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import Image from '@tiptap/extension-image'
import StarterKit from '@tiptap/starter-kit'
import { createSlugger } from '@shared/slug'
import { clearRegionHighlights, getAnchorRange, paintAnchors } from '../../lib/highlights'
import { renderMarkdown } from '../../lib/markdown'
import { useTimelineStore } from '../../state/timelineStore'

const REGION = 'markdown'

/**
 * Find the heading a `#slug` refers to by re-deriving slugs from what was
 * actually rendered, in document order — the same computation web import ran
 * over the article's headings when it rewrote the href.
 *
 * Matching rather than reading an id: Tiptap drops attributes its schema
 * doesn't declare, so an id put into the HTML never survives to the DOM.
 */
function findHeading(root: Element, slug: string): Element | null {
  const slugger = createSlugger()
  for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    if (slugger(heading.textContent ?? '') === slug) return heading
  }
  return null
}

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
  const html = useMemo(() => renderMarkdown(content, { breaks: false, document: true }), [content])
  const editor = useEditor(
    {
      extensions: [
        // Links are handled below rather than by the extension, so that a
        // fragment and an external URL take visibly different paths.
        StarterKit.configure({ link: { openOnClick: false } }),
        // Not in StarterKit — without it a clipped article's figures are
        // silently dropped on the way into the view.
        Image.configure({ inline: false }),
      ],
      content: html,
      editable: false,
      // Lands on the ProseMirror element (not the wrapper), so the rendered
      // markdown styles are the same ones the entry bodies use.
      editorProps: { attributes: { class: 'markdown-body' } },
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

  // Only a fragment needs handling here: it points inside this document, and
  // main can't scroll a pane. Every other link already carries `target=_blank`
  // and belongs to the app-wide route in main/index.ts that sends it to the OS
  // browser — the same one entry bodies use.
  const handleLinkClick = (event: React.MouseEvent) => {
    const href = (event.target as Element).closest?.('a[href]')?.getAttribute('href')
    if (!href?.startsWith('#')) return
    event.preventDefault()

    const heading = findHeading(event.currentTarget, decodeURIComponent(href.slice(1)))
    heading?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  return (
    <div ref={containerRef} onClick={handleLinkClick}>
      <EditorContent editor={editor} className="markdown-view" />
    </div>
  )
}
