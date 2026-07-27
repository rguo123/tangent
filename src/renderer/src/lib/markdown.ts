import { Marked } from 'marked'

/**
 * The one markdown → HTML path in the renderer: notes, AI answers, and the
 * markdown document view all go through this.
 *
 * The output is injected with `dangerouslySetInnerHTML`, so this module is the
 * sanitizer too. Two rules, both enforced on the renderer rather than by a
 * post-hoc scrub:
 *
 *  - raw HTML in the source is escaped, never passed through — a model that
 *    emits `<script>` or `<img onerror=…>` gets text, not a tag;
 *  - links keep only http(s)/mailto hrefs and same-document fragments, and
 *    images only http(s) or the app's own asset scheme, so `javascript:` and
 *    `file:` degrade to plain text.
 *
 * That covers what markdown can smuggle without pulling in a DOM sanitizer.
 */

const SAFE_HREF = /^(?:https?:|mailto:)/i
const SAFE_IMG_SRC = /^(?:https?:)/i

/**
 * Two capabilities only an imported document has any use for, off by default.
 *
 * `#…` is how a clipped article points at its own headings (see
 * `documents/webClip.ts`), and `tangent://assets/…` is where its downloaded
 * images live. Entry bodies — notes, and whatever a model wrote — are rendered
 * by the same function, and have no business minting either. Granting them per
 * surface keeps that a line of code rather than a paragraph of reasoning.
 */
const DOCUMENT_HREF = /^(?:https?:|mailto:|#)/i
const DOCUMENT_IMG_SRC = /^(?:https?:|tangent:)/i

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const marked = new Marked({ gfm: true })

/** Set for the duration of one `renderMarkdown` call. Safe as module state
 *  because `marked.parse` is synchronous — the same reason the renderer
 *  callbacks below can read it at all. */
let safeHref = SAFE_HREF
let safeImgSrc = SAFE_IMG_SRC

marked.use({
  renderer: {
    html({ text }) {
      return escapeHtml(text)
    },

    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens)
      if (!safeHref.test(href)) return text
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
      // A fragment stays inside this document, so it gets no target — the
      // document view intercepts it and scrolls. Everything else is elsewhere:
      // Electron's window-open handler sends those to the OS browser, and
      // without the target they would navigate the app itself away.
      const target = href.startsWith('#') ? '' : ' target="_blank" rel="noreferrer noopener"'
      return `<a href="${escapeHtml(href)}"${titleAttr}${target}>${text}</a>`
    },

    image({ href, title, text }) {
      if (!safeImgSrc.test(href)) return escapeHtml(text)
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${titleAttr} />`
    },
  },
})

/**
 * `breaks` treats a lone newline as a line break. On for entries — those are
 * typed into a textarea, where a newline is meant literally, and it preserves
 * the `white-space: pre-wrap` rendering it replaced. Off for source documents,
 * where hard-wrapped paragraphs are just paragraphs.
 *
 * `document` widens what a link or image may point at, for the one surface that
 * renders imported content. See the two pattern pairs above.
 */
export function renderMarkdown(source: string, { breaks = true, document = false } = {}): string {
  safeHref = document ? DOCUMENT_HREF : SAFE_HREF
  safeImgSrc = document ? DOCUMENT_IMG_SRC : SAFE_IMG_SRC
  try {
    return marked.parse(source, { async: false, breaks })
  } finally {
    safeHref = SAFE_HREF
    safeImgSrc = SAFE_IMG_SRC
  }
}
