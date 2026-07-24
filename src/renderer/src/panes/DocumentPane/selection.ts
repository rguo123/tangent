import type { TextQuoteSelector } from '@shared/entities'
import { buildSelector } from '@shared/textQuote'
import { indexTextContent, offsetsFromRange } from '../../lib/domText'

/** A live document selection, ready to become an Anchor if the user picks
 *  note/ask from the floating menu. */
export interface PendingSelection {
  documentId: string
  selector: TextQuoteSelector
  /** Viewport coordinates for the floating menu (top-center of selection). */
  x: number
  y: number
}

function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
}

/** The anchorable region a range lives in: one PDF page's text layer, or the
 *  markdown view. Selections spanning pages (or neither region) don't anchor. */
function findRegion(range: Range): { root: Element; pageNumber?: number } | null {
  const startEl = elementOf(range.startContainer)
  const endEl = elementOf(range.endContainer)
  if (!startEl || !endEl) return null

  const textLayer = startEl.closest('.react-pdf__Page__textContent')
  if (textLayer) {
    if (endEl.closest('.react-pdf__Page__textContent') !== textLayer) return null
    const pageAttr = textLayer.closest('.react-pdf__Page')?.getAttribute('data-page-number')
    const pageNumber = pageAttr ? Number(pageAttr) : NaN
    return Number.isFinite(pageNumber) ? { root: textLayer, pageNumber } : null
  }

  const markdown = startEl.closest('.markdown-view')
  if (markdown && endEl.closest('.markdown-view') === markdown) {
    return { root: markdown.querySelector('.tiptap') ?? markdown }
  }
  return null
}

/** Read the current window selection into a PendingSelection, or null when
 *  there's nothing anchorable selected inside `container`. */
export function readSelection(
  container: HTMLElement | null,
  documentId: string | null,
): PendingSelection | null {
  if (!container || !documentId) return null
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!container.contains(range.commonAncestorContainer)) return null

  const region = findRegion(range)
  if (!region) return null
  const index = indexTextContent(region.root)
  const offsets = offsetsFromRange(index, range)
  if (!offsets) return null
  const quote = buildSelector(index.text, offsets.start, offsets.end)
  if (!quote) return null

  const rect = range.getBoundingClientRect()
  return {
    documentId,
    selector: {
      type: 'text-quote',
      ...quote,
      ...(region.pageNumber !== undefined ? { pageNumber: region.pageNumber } : {}),
    },
    x: rect.left + rect.width / 2,
    y: rect.top,
  }
}
