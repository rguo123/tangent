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

  it('keeps a same-document fragment as an in-app link, for documents', () => {
    const html = renderMarkdown('[jump](#leader-election)', { document: true })
    expect(html).toContain('href="#leader-election"')
    // No target: this one is handled in the document view, not the browser.
    expect(html).not.toContain('target="_blank"')
  })

  it('allows a tangent:// image but never a tangent:// link', () => {
    const image = renderMarkdown('![Diagram](tangent://assets/doc-id/abc.png)', { document: true })
    expect(image).toContain('<img src="tangent://assets/doc-id/abc.png"')

    const link = renderMarkdown('[nav](tangent://assets/doc-id/abc.png)', { document: true })
    expect(link).not.toContain('tangent://')
    expect(link).toContain('nav')
  })

  it('grants neither capability to entry bodies, which is the default', () => {
    // Notes and model output go through the same renderer. Neither may mint a
    // fragment link nor reach a document's local assets.
    const fragment = renderMarkdown('[jump](#leader-election)')
    expect(fragment).not.toContain('href=')
    expect(fragment).toContain('jump')

    const asset = renderMarkdown('![x](tangent://assets/doc-id/abc.png)')
    expect(asset).not.toContain('tangent://')
    expect(asset).not.toContain('<img')
  })

  it('does not leak a document render into the next entry render', () => {
    renderMarkdown('[a](#x)', { document: true })
    expect(renderMarkdown('[b](#y)')).not.toContain('href=')
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
