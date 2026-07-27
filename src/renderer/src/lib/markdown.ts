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
 *  - links and images keep only http(s)/mailto hrefs, so `javascript:` and
 *    `file:` degrade to plain text.
 *
 * That covers what markdown can smuggle without pulling in a DOM sanitizer.
 */

const SAFE_HREF = /^(?:https?:|mailto:)/i

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const marked = new Marked({ gfm: true })

marked.use({
  renderer: {
    html({ text }) {
      return escapeHtml(text)
    },

    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens)
      if (!SAFE_HREF.test(href)) return text
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
      // Electron's window-open handler sends these to the OS browser; without
      // the target they would navigate the app itself away.
      return `<a href="${escapeHtml(href)}"${titleAttr} target="_blank" rel="noreferrer noopener">${text}</a>`
    },

    image({ href, title, text }) {
      if (!SAFE_HREF.test(href)) return escapeHtml(text)
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
 */
export function renderMarkdown(source: string, { breaks = true } = {}): string {
  return marked.parse(source, { async: false, breaks })
}
