/**
 * W3C-style text-quote selector building and matching (spec §2).
 *
 * Both ends of an anchor's life go through this module: `buildSelector` runs
 * at selection time against the rendered text, and `findQuote` re-locates the
 * quote in the (re-)rendered text at highlight-paint time. Matching is
 * whitespace-insensitive — text layers and editors disagree about spaces and
 * line breaks between renders — but nothing more: when the quote can't be
 * found verbatim the caller degrades to a page-level jump (spec §4), never
 * fuzzy re-anchoring.
 */

export interface TextQuote {
  exact: string
  prefix: string
  suffix: string
}

/** Offsets into the text the quote was matched against; end is exclusive. */
export interface QuoteMatch {
  start: number
  end: number
}

/** How much context to capture on each side of the quote at build time. */
const CONTEXT_LENGTH = 32

const WHITESPACE = /\s/

interface NormalizedText {
  text: string
  /** map[i] = index in the original string of normalized char i. */
  map: number[]
}

/** Collapse whitespace runs to single spaces (dropping leading/trailing runs
 *  entirely), keeping a map back to original offsets. */
function normalize(input: string): NormalizedText {
  let text = ''
  const map: number[] = []
  let runStart = -1
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (WHITESPACE.test(ch)) {
      if (runStart < 0) runStart = i
      continue
    }
    if (runStart >= 0 && text.length > 0) {
      text += ' '
      map.push(runStart)
    }
    runStart = -1
    text += ch
    map.push(i)
  }
  return { text, map }
}

/**
 * Capture a selector for text[start, end). Bounds are trimmed to the
 * selection's non-whitespace core; returns null for whitespace-only
 * selections.
 */
export function buildSelector(text: string, start: number, end: number): TextQuote | null {
  while (start < end && WHITESPACE.test(text[start]!)) start++
  while (end > start && WHITESPACE.test(text[end - 1]!)) end--
  if (start >= end) return null
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
    suffix: text.slice(end, end + CONTEXT_LENGTH),
  }
}

/** How many characters of context agree, walking outward from the boundary.
 *  `direction` -1 compares a prefix right-to-left, +1 a suffix left-to-right. */
function contextAgreement(hay: string, boundary: number, context: string, direction: -1 | 1): number {
  let agreed = 0
  for (let i = 0; i < context.length; i++) {
    const hayIdx = boundary + direction * (direction < 0 ? i + 1 : i)
    const ctxIdx = direction < 0 ? context.length - 1 - i : i
    if (hayIdx < 0 || hayIdx >= hay.length || hay[hayIdx] !== context[ctxIdx]) break
    agreed++
  }
  return agreed
}

/** Normalize a context string, keeping its quote-facing boundary whitespace
 *  as a single space — normalize() alone would drop it, and then the context
 *  could never agree with the space that precedes/follows the quote. */
function normalizeContext(raw: string, side: 'prefix' | 'suffix'): string {
  let text = normalize(raw).text
  if (raw.length > 0) {
    if (side === 'prefix' && WHITESPACE.test(raw[raw.length - 1]!)) text += ' '
    if (side === 'suffix' && WHITESPACE.test(raw[0]!)) text = ' ' + text
  }
  return text
}

/**
 * Locate the selector's quote in `text`. Ambiguous quotes are disambiguated
 * by prefix/suffix agreement (best total wins; ties go to the earliest
 * occurrence). Returns offsets into the original `text`, or null when the
 * quote does not occur — the caller's degrade path.
 */
export function findQuote(text: string, selector: TextQuote): QuoteMatch | null {
  const hay = normalize(text)
  const needle = normalize(selector.exact).text
  if (!needle) return null

  const prefix = normalizeContext(selector.prefix, 'prefix')
  const suffix = normalizeContext(selector.suffix, 'suffix')

  let best: { index: number; score: number } | null = null
  for (let from = 0; ; ) {
    const index = hay.text.indexOf(needle, from)
    if (index < 0) break
    const score =
      contextAgreement(hay.text, index, prefix, -1) +
      contextAgreement(hay.text, index + needle.length, suffix, 1)
    if (!best || score > best.score) best = { index, score }
    from = index + 1
  }
  if (!best) return null

  return {
    start: hay.map[best.index]!,
    end: hay.map[best.index + needle.length - 1]! + 1,
  }
}
