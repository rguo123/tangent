import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'react-pdf/dist/Page/TextLayer.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import type { Anchor } from '@shared/entities'
import { clearRegionHighlights, getAnchorRange, paintAnchors } from '../../lib/highlights'
import { useTimelineStore } from '../../state/timelineStore'

// The classic react-pdf-under-Vite snag: the worker must be served as an
// asset, not bundled. `?url` makes Vite emit it and hand back the URL.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** Letter-ish aspect ratio used to size placeholders before a page has
 *  rendered once (then we remember its real height). */
const ESTIMATED_PAGE_RATIO = 1.3

const NO_ANCHORS: Anchor[] = []

/**
 * One page slot. Pages are virtualized: only slots near the viewport mount a
 * real <Page> (canvas + text layer); the rest are fixed-height placeholders so
 * scroll position stays stable. Once a page's text layer renders, its anchors'
 * quotes are matched against it and painted; a quote that no longer matches
 * simply isn't painted — its entry still page-jumps here (spec §4 degrade).
 */
function LazyPage({
  pageNumber,
  width,
  anchors,
  registerSlot,
}: {
  pageNumber: number
  width: number
  anchors: Anchor[]
  registerSlot: (pageNumber: number, el: HTMLDivElement | null) => void
}) {
  const slotRef = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(false)
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null)
  // Read by the stable callbacks below. Painting must NOT go through state:
  // a state bump re-renders <Page>, and react-pdf then re-runs the text layer
  // render, whose success callback would bump state again — an infinite
  // clear-and-repopulate loop that leaves the text layer perpetually empty.
  const anchorsRef = useRef(anchors)

  useEffect(() => {
    const slot = slotRef.current
    if (!slot) return
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      // Mount pages well before they scroll into view.
      { rootMargin: '1500px 0px' },
    )
    observer.observe(slot)
    return () => observer.disconnect()
  }, [])

  /** (Re)paint this page's anchors; a no-op until the text layer exists. */
  const paintHighlights = useCallback(() => {
    const textLayer = slotRef.current?.querySelector('.react-pdf__Page__textContent')
    if (textLayer) paintAnchors(`pdf:${pageNumber}`, textLayer, anchorsRef.current)
  }, [pageNumber])

  // Repaint when the anchor set changes; clear when the page slides out of
  // the virtualization window or unmounts.
  useEffect(() => {
    anchorsRef.current = anchors
    if (visible) paintHighlights()
    else clearRegionHighlights(`pdf:${pageNumber}`)
  }, [anchors, visible, pageNumber, paintHighlights])
  useEffect(() => () => clearRegionHighlights(`pdf:${pageNumber}`), [pageNumber])

  const handleRenderSuccess = useCallback(() => {
    const height = slotRef.current?.querySelector('.react-pdf__Page')?.clientHeight
    if (height) setMeasuredHeight(height)
  }, [])

  const placeholderHeight = measuredHeight ?? Math.round(width * ESTIMATED_PAGE_RATIO)
  return (
    <div
      ref={(el) => {
        slotRef.current = el
        registerSlot(pageNumber, el)
      }}
      className="pdf-page-slot"
      style={{ minHeight: placeholderHeight }}
    >
      {visible && (
        <Page
          pageNumber={pageNumber}
          width={width}
          onRenderSuccess={handleRenderSuccess}
          onRenderTextLayerSuccess={paintHighlights}
        />
      )}
    </div>
  )
}

export default function PdfView({ data, documentId }: { data: Uint8Array; documentId: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [numPages, setNumPages] = useState(0)
  const [pageWidth, setPageWidth] = useState(0)
  const slotsRef = useRef(new Map<number, HTMLDivElement>())

  const anchors = useTimelineStore((s) => s.anchors)
  const docJump = useTimelineStore((s) => s.docJump)

  const anchorsByPage = useMemo(() => {
    const byPage = new Map<number, Anchor[]>()
    for (const anchor of anchors) {
      const page = anchor.selector.pageNumber
      if (anchor.documentId !== documentId || page === undefined) continue
      const list = byPage.get(page) ?? []
      list.push(anchor)
      byPage.set(page, list)
    }
    return byPage
  }, [anchors, documentId])

  const registerSlot = useCallback((pageNumber: number, el: HTMLDivElement | null) => {
    if (el) slotsRef.current.set(pageNumber, el)
    else slotsRef.current.delete(pageNumber)
  }, [])

  // pdf.js transfers this buffer to its worker (detaching it), so hand over a
  // copy — the original stays usable across StrictMode remounts.
  const file = useMemo(() => ({ data: new Uint8Array(data) }), [data])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(([entry]) => {
      setPageWidth(Math.max(0, Math.floor(entry.contentRect.width) - 48))
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // Cross-navigation: entry click → jump to the anchor's page immediately,
  // then refine to the highlight once the (virtualized) text layer has
  // painted it. If the quote never matches, the page-level jump *is* the
  // behavior (spec §4) — no error, no fuzzy re-anchoring.
  useEffect(() => {
    if (!docJump) return
    const pageNumber = docJump.anchor.selector.pageNumber
    if (pageNumber === undefined || docJump.anchor.documentId !== documentId) return
    slotsRef.current.get(pageNumber)?.scrollIntoView({ block: 'start' })
    let tries = 0
    const timer = window.setInterval(() => {
      const range = getAnchorRange(docJump.anchor.id)
      if (range) {
        window.clearInterval(timer)
        range.startContainer.parentElement?.scrollIntoView({ block: 'center' })
      } else if (++tries >= 20) {
        window.clearInterval(timer)
      }
    }, 100)
    return () => window.clearInterval(timer)
  }, [docJump, documentId])

  return (
    <div ref={containerRef} className="pdf-view">
      <Document
        file={file}
        onLoadSuccess={(pdf) => setNumPages(pdf.numPages)}
        loading={<p className="pane-status">Loading PDF…</p>}
        error={<p className="pane-status error">Failed to render PDF.</p>}
      >
        {pageWidth > 0 &&
          Array.from({ length: numPages }, (_, i) => (
            <LazyPage
              key={i + 1}
              pageNumber={i + 1}
              width={pageWidth}
              anchors={anchorsByPage.get(i + 1) ?? NO_ANCHORS}
              registerSlot={registerSlot}
            />
          ))}
      </Document>
    </div>
  )
}
