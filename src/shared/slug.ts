/**
 * Heading slugs — the two ends of an in-document link.
 *
 * Shared because those ends are computed in different processes: web import
 * (main) rewrites an article's intra-page hrefs to the slug of the heading they
 * point at, and the document pane (renderer) finds that heading again by
 * slugging what it rendered. They have to agree character for character or the
 * jump silently does nothing, so there is exactly one implementation.
 *
 * Nothing is written into the DOM as an id, deliberately. The document view
 * renders through Tiptap, which drops attributes its schema doesn't declare,
 * and clipped heading text is attacker-controlled — matching on demand avoids
 * both the lost ids and the question of what a page could name itself.
 */

export function slugify(text: string): string {
  const base = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'section'
}

/**
 * A slugger, not a function: repeated heading text has to get distinct ids, so
 * the numbering is stateful and depends on document order. One slugger per
 * document, used from the top.
 */
export function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>()
  return (text) => {
    const base = slugify(text)
    const used = seen.get(base) ?? 0
    seen.set(base, used + 1)
    return used === 0 ? base : `${base}-${used}`
  }
}
