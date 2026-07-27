import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { clipArticle, NoArticleError } from '../../src/main/documents/webClip'
import { articlePage as page, PROSE } from './helpers'

const PAGE_URL = 'https://example.com/posts/raft'

describe('clipArticle', () => {
  it('extracts the article and drops nav, ads and footer', () => {
    const result = clipArticle(page(`<h1>Raft</h1>${PROSE}`), PAGE_URL)

    expect(result.title).toBe('Raft')
    expect(result.markdown).toContain('Paragraph 0 of the article body')
    expect(result.markdown).not.toContain('Buy something')
    expect(result.markdown).not.toContain('Copyright notice')
    expect(result.markdown).not.toContain('About')
  })

  it('throws NoArticleError when there is no article to find', () => {
    const bare = '<!doctype html><html><body><nav><a href="/a">a</a></nav></body></html>'
    expect(() => clipArticle(bare, PAGE_URL)).toThrow(NoArticleError)
  })

  it('refuses a page too large to parse on the main thread', () => {
    const huge = `<html><body>${'x'.repeat(8_000_001)}</body></html>`
    expect(() => clipArticle(huge, PAGE_URL)).toThrow(/too large/)
  })

  describe('links', () => {
    it('keeps external links absolute and resolves relative ones', () => {
      const result = clipArticle(
        page(`${PROSE}<p><a href="https://other.test/x">out</a> <a href="/deep/link">rel</a></p>`),
        PAGE_URL,
      )
      expect(result.markdown).toContain('[out](https://other.test/x)')
      expect(result.markdown).toContain('[rel](https://example.com/deep/link)')
    })

    it('keeps a fragment that names a surviving heading, as its slug', () => {
      const result = clipArticle(
        page(`${PROSE}<p><a href="#leader-election">jump</a></p>
              <h2 id="leader-election">Leader Election</h2>${PROSE}`),
        PAGE_URL,
      )
      expect(result.markdown).toContain('[jump](#leader-election)')
    })

    it('re-slugs a fragment whose heading id differs from its text', () => {
      const result = clipArticle(
        page(`${PROSE}<p><a href="#sec3">jump</a></p>
              <h2 id="sec3">Log Replication</h2>${PROSE}`),
        PAGE_URL,
      )
      expect(result.markdown).toContain('[jump](#log-replication)')
    })

    it('absolutizes a fragment whose target did not survive extraction', () => {
      const result = clipArticle(
        page(`${PROSE}<p><a href="#cite_note-3">citation</a></p>`),
        PAGE_URL,
      )
      expect(result.markdown).toContain('[citation](https://example.com/posts/raft#cite_note-3)')
    })

    it('strips a javascript: href but keeps its text', () => {
      const result = clipArticle(
        page(`${PROSE}<p><a href="javascript:steal()">click me</a></p>`),
        PAGE_URL,
      )
      expect(result.markdown).toContain('click me')
      expect(result.markdown).not.toContain('javascript:')
      expect(result.markdown).not.toContain('[click me]')
    })
  })

  describe('images', () => {
    it('resolves and deduplicates images behind placeholders', () => {
      const result = clipArticle(
        page(`${PROSE}<p><img src="/img/a.png" alt="A"><img src="/img/a.png" alt="A again">
              <img src="https://cdn.test/b.jpg" alt="B"></p>`),
        PAGE_URL,
      )
      expect(result.images).toEqual([
        { url: 'https://example.com/img/a.png', placeholder: 'tangent-asset:0' },
        { url: 'https://cdn.test/b.jpg', placeholder: 'tangent-asset:1' },
      ])
      expect(result.markdown).toContain('![A](tangent-asset:0)')
      expect(result.markdown).toContain('![A again](tangent-asset:0)')
      expect(result.markdown).toContain('![B](tangent-asset:1)')
    })

    it('promotes a lazy-loaded src', () => {
      const result = clipArticle(
        page(`${PROSE}<p><img data-src="/img/lazy.png" alt="L"></p>`),
        PAGE_URL,
      )
      expect(result.images.map((i) => i.url)).toEqual(['https://example.com/img/lazy.png'])
    })

    it('takes the largest candidate from srcset', () => {
      const result = clipArticle(
        page(`${PROSE}<p><img srcset="/s.png 400w, /l.png 1200w" alt="S"></p>`),
        PAGE_URL,
      )
      expect(result.images.map((i) => i.url)).toEqual(['https://example.com/l.png'])
      expect(result.markdown).not.toContain('srcset')
    })

    it('drops images that are not http(s)', () => {
      const result = clipArticle(
        page(`${PROSE}<p><img src="data:image/png;base64,AAAA" alt="D"></p>`),
        PAGE_URL,
      )
      expect(result.images).toEqual([])
      expect(result.markdown).not.toContain('data:image')
    })
  })

  it('flattens a table it cannot express rather than emitting raw HTML', () => {
    // No header row, which is what makes turndown's gfm plugin keep the table
    // as HTML — Wikipedia's infoboxes are all like this.
    const result = clipArticle(
      page(`${PROSE}<table class="infobox"><tr><td>Designed by</td><td>Ongaro</td></tr>
            <tr><td><img src="/img/logo.png" alt="Logo"></td></tr></table>`),
      PAGE_URL,
    )

    expect(result.markdown).not.toContain('<table')
    expect(result.markdown).not.toContain('<td')
    expect(result.markdown).toContain('Ongaro')
    // The image inside it is a real markdown image, so its placeholder gets
    // substituted like any other.
    expect(result.markdown).toContain('![Logo](tangent-asset:0)')
    expect(result.markdown).not.toMatch(/<img/)
  })

  it('leaves no unsubstituted asset placeholder outside markdown image syntax', () => {
    const result = clipArticle(
      page(`${PROSE}<table><tr><td><img src="/a.png" alt="A"></td></tr></table>
            <p><img src="/b.png" alt="B"></p>`),
      PAGE_URL,
    )
    const placeholders = [...result.markdown.matchAll(/tangent-asset:\d+/g)].length
    const asImages = [...result.markdown.matchAll(/!\[[^\]]*\]\(tangent-asset:\d+\)/g)].length
    expect(placeholders).toBe(asImages)
  })

  describe('code blocks', () => {
    it('reads the fence language off the code element', () => {
      const result = clipArticle(
        page(`${PROSE}<pre><code class="language-ts">const x: number = 1</code></pre>`),
        PAGE_URL,
      )
      expect(result.markdown).toContain('```ts\nconst x: number = 1\n```')
    })

    it('reads it off the pre element too', () => {
      const result = clipArticle(
        page(`${PROSE}<pre class="highlight-rust"><code>fn main() {}</code></pre>`),
        PAGE_URL,
      )
      expect(result.markdown).toContain('```rust\nfn main() {}\n```')
    })

    it('lengthens the fence when the code contains backticks', () => {
      const result = clipArticle(
        page(`${PROSE}<pre><code>markdown uses \`\`\` for fences</code></pre>`),
        PAGE_URL,
      )
      expect(result.markdown).toContain('````\nmarkdown uses ``` for fences\n````')
    })
  })

  describe('a real captured page', () => {
    const html = readFileSync(join(__dirname, '../fixtures/martinfowler-patterns.html'), 'utf8')
    const url = 'https://martinfowler.com/articles/patterns-of-distributed-systems/'
    // One extraction: these assertions are about the same result, and it is a
    // 26KB fixture.
    const result = clipArticle(html, url)

    it('extracts title, byline and body', () => {
      expect(result.title).toBe('Catalog of Patterns of Distributed Systems')
      expect(result.byline).toContain('Unmesh Joshi')
      expect(result.siteName).toBe('martinfowler.com')
      expect(result.markdown.length).toBeGreaterThan(3000)
    })

    it('leaves no relative or unresolved URLs behind', () => {
      // `(?!!)` skips a linked image — `[![alt](asset)](href)` — whose inner
      // URL is a placeholder by design and is asserted on separately.
      const hrefs = [...result.markdown.matchAll(/(?<!!)\[(?!!)[^\]]*\]\(([^)\s]+)\)/g)].map(
        (m) => m[1],
      )
      expect(hrefs.length).toBeGreaterThan(10)
      for (const href of hrefs) {
        expect(href).toMatch(/^(https?:|#)/)
      }
      for (const image of result.images) {
        expect(image.url).toMatch(/^https?:/)
      }
      expect(result.markdown).not.toContain('](/')
    })
  })
})
