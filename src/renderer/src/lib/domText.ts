/**
 * Bridges DOM text and flat string offsets. Selector building and highlight
 * painting both index a container's text nodes through this module, so the
 * offsets they exchange (via textQuote) are always computed the same way.
 */

interface TextSegment {
  node: Text
  /** Offset of this node's first character in the concatenated text. */
  start: number
}

export interface TextIndex {
  text: string
  segments: TextSegment[]
}

/** Concatenate every text node under `root`, remembering where each lives. */
export function indexTextContent(root: Element): TextIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let text = ''
  const segments: TextSegment[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text
    if (!node.data) continue
    segments.push({ node, start: text.length })
    text += node.data
  }
  return { text, segments }
}

/** Resolve a DOM boundary point to an offset in the indexed text. Element
 *  boundaries snap forward to the next indexed character. */
function positionOf(index: TextIndex, node: Node, offset: number): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const segment = index.segments.find((s) => s.node === node)
    return segment ? segment.start + offset : null
  }
  for (let i = offset; i < node.childNodes.length; i++) {
    const child = node.childNodes[i]!
    const segment = index.segments.find((s) => child.contains(s.node))
    if (segment) return segment.start
  }
  // Boundary sits after every indexed descendant → end of the subtree's text.
  for (let i = index.segments.length - 1; i >= 0; i--) {
    const segment = index.segments[i]!
    if (node.contains(segment.node)) return segment.start + segment.node.data.length
  }
  return null
}

export function offsetsFromRange(
  index: TextIndex,
  range: Range,
): { start: number; end: number } | null {
  const start = positionOf(index, range.startContainer, range.startOffset)
  const end = positionOf(index, range.endContainer, range.endOffset)
  if (start === null || end === null || end <= start) return null
  return { start, end }
}

function segmentAt(index: TextIndex, position: number): TextSegment | null {
  for (const segment of index.segments) {
    if (position >= segment.start && position < segment.start + segment.node.data.length) {
      return segment
    }
  }
  return null
}

export function rangeFromOffsets(index: TextIndex, start: number, end: number): Range | null {
  if (start < 0 || end <= start || end > index.text.length) return null
  const startSegment = segmentAt(index, start)
  const endSegment = segmentAt(index, end - 1)
  if (!startSegment || !endSegment) return null
  const range = document.createRange()
  range.setStart(startSegment.node, start - startSegment.start)
  range.setEnd(endSegment.node, end - endSegment.start)
  return range
}
