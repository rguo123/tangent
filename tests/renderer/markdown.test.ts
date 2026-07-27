import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../../src/renderer/src/lib/markdown'

describe('renderMarkdown', () => {
  it('renders the usual markdown constructs', () => {
    const html = renderMarkdown('# Title\n\n- one\n- two\n\n`code` and **bold**')
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<strong>bold</strong>')
  })

  it('renders gfm tables and fenced code', () => {
    const html = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst x = 1\n```')
    expect(html).toContain('<table>')
    expect(html).toContain('<td>1</td>')
    expect(html).toContain('language-ts')
  })

  it('treats a lone newline as a break, unless breaks are off', () => {
    expect(renderMarkdown('one\ntwo')).toContain('<br>')
    expect(renderMarkdown('one\ntwo', { breaks: false })).not.toContain('<br>')
  })

  it('escapes raw html instead of passing it through', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\nhi <img src=x onerror=alert(1)>')
    // The attribute text survives as text — what matters is that no tag does.
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('drops links and images with an unsafe scheme, keeping their text', () => {
    const html = renderMarkdown('[click](javascript:alert(1)) ![alt](file:///etc/passwd)')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('file:///')
    expect(html).toContain('click')
    expect(html).toContain('alt')
  })

  it('opens safe links externally', () => {
    const html = renderMarkdown('[docs](https://example.com)')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer noopener"')
  })

  it('renders partial markdown mid-stream without dropping text', () => {
    // Every prefix of a streaming answer gets parsed; none may lose content.
    const answer = '## Result\n\nThe **key** point is:\n\n```ts\nconst x = 1\n```\n'
    for (let i = 1; i <= answer.length; i++) {
      expect(() => renderMarkdown(answer.slice(0, i))).not.toThrow()
    }
    expect(renderMarkdown('## Result\n\nThe **ke')).toContain('Result')
  })
})
