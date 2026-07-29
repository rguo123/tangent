/**
 * Small cross-cutting helpers for the main process. Everything here was written
 * twice somewhere before it was written once here.
 */

/** What a caller falls back to when the reason is empty. */
const DEFAULT_TRUNCATION = '\n\n[...truncated]'

/**
 * Bound a string, marking where it was cut. Callers feeding text to a model
 * want the default marker; a caller clipping a short phrase passes its own
 * (`'…'`) or none.
 */
export function truncate(text: string, max: number, marker = DEFAULT_TRUNCATION): string {
  return text.length <= max ? text : `${text.slice(0, max)}${marker}`
}

/**
 * A passage as a Markdown blockquote, for the prompts that quote the reader's
 * source back at the model.
 *
 * Every line gets the marker, not just the first: an un-prefixed continuation
 * line ends the quote, and the rest of the passage then reads as part of the
 * surrounding instructions.
 */
export function blockquote(text: string): string {
  return `> ${text.replace(/\n/g, '\n> ')}`
}

/**
 * An error as a sentence a person can act on. Both places this is used put the
 * result in front of the user — on a failed entry, or on the extraction chip —
 * so an empty message has to become something rather than nothing.
 */
export function errorMessage(err: unknown, fallback: string): string {
  const text = err instanceof Error ? err.message : String(err)
  return text || fallback
}
