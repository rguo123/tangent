/**
 * Registry of painted anchor highlights, rendered through the CSS Custom
 * Highlight API (styled by `::highlight(tangent-anchor)` in styles.css).
 * Non-destructive by design: the pdf.js text layer and Tiptap DOM are never
 * mutated, so selection offsets and re-renders stay untouched.
 *
 * Ranges are registered per *region* — a PDF page's text layer or the whole
 * markdown view — because PDF pages are virtualized: each region repaints (or
 * clears) as it mounts and unmounts.
 */

import type { Anchor } from '@shared/entities'
import { findQuote } from '@shared/textQuote'
import { indexTextContent, rangeFromOffsets } from './domText'

const HIGHLIGHT_NAME = 'tangent-anchor'

const regions = new Map<string, Map<string, Range>>()

function rebuild(): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return
  const highlight = new Highlight()
  for (const ranges of regions.values()) {
    for (const range of ranges.values()) highlight.add(range)
  }
  CSS.highlights.set(HIGHLIGHT_NAME, highlight)
}

export function setRegionHighlights(region: string, ranges: Map<string, Range>): void {
  regions.set(region, ranges)
  rebuild()
}

/** Match `anchors` against the rendered text under `root` and (re)paint the
 *  region. A quote that doesn't match is simply not painted — its entries
 *  fall back to a page-level jump (spec §4). */
export function paintAnchors(region: string, root: Element, anchors: Anchor[]): void {
  const index = indexTextContent(root)
  const ranges = new Map<string, Range>()
  for (const anchor of anchors) {
    const match = findQuote(index.text, anchor.selector)
    const range = match && rangeFromOffsets(index, match.start, match.end)
    if (range) ranges.set(anchor.id, range)
  }
  setRegionHighlights(region, ranges)
}

export function clearRegionHighlights(region: string): void {
  if (regions.delete(region)) rebuild()
}

/** The live Range for an anchor, if its quote matched in a mounted region. */
export function getAnchorRange(anchorId: string): Range | null {
  for (const ranges of regions.values()) {
    const range = ranges.get(anchorId)
    if (range) return range
  }
  return null
}

function caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y)
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null
  }
  const range = doc.caretRangeFromPoint(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

/** Which anchor's highlight (if any) sits under viewport point (x, y) —
 *  Highlight API paint isn't hit-testable, so clicks resolve through here. */
export function anchorAtPoint(x: number, y: number): string | null {
  const caret = caretFromPoint(x, y)
  if (!caret) return null
  for (const ranges of regions.values()) {
    for (const [anchorId, range] of ranges) {
      if (range.isPointInRange(caret.node, caret.offset)) return anchorId
    }
  }
  return null
}
