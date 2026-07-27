import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  assetUrl,
  contentTypeFor,
  extensionFor,
  resolveAssetPath,
} from '../../src/main/documents/assetPaths'

const DOCS = '/data/documents'
const DOC_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const DIGEST = 'a'.repeat(64)

describe('contentTypeFor', () => {
  it('maps the image types we serve', () => {
    expect(contentTypeFor('png')).toBe('image/png')
    expect(contentTypeFor('.JPG')).toBe('image/jpeg')
    expect(contentTypeFor('svg')).toBe('image/svg+xml')
  })

  it('refuses anything that could be read as a document', () => {
    expect(contentTypeFor('html')).toBeNull()
    expect(contentTypeFor('js')).toBeNull()
    expect(contentTypeFor('pdf')).toBeNull()
    expect(contentTypeFor('')).toBeNull()
  })
})

describe('extensionFor', () => {
  it('prefers the content type', () => {
    expect(extensionFor('image/webp', 'https://cdn.test/photo?id=12')).toBe('webp')
    expect(extensionFor('image/png; charset=binary', 'https://cdn.test/x')).toBe('png')
  })

  it('falls back to the URL when the type is uninformative', () => {
    expect(extensionFor(null, 'https://cdn.test/a/b.gif')).toBe('gif')
    expect(extensionFor('application/octet-stream', 'https://cdn.test/a.png')).toBe('png')
  })

  it('refuses a response that announced itself as something else', () => {
    expect(extensionFor('text/html', 'https://cdn.test/page.png')).toBeNull()
    expect(extensionFor('application/json', 'https://cdn.test/a.png')).toBeNull()
  })

  it('refuses when neither source names an image', () => {
    expect(extensionFor(null, 'https://cdn.test/download')).toBeNull()
    expect(extensionFor(null, 'https://cdn.test/script.js')).toBeNull()
  })
})

describe('resolveAssetPath', () => {
  it('resolves a well-formed request, naming the type it will be served as', () => {
    expect(resolveAssetPath(DOCS, DOC_ID, `${DIGEST}.png`)).toEqual({
      path: join(DOCS, DOC_ID, `${DIGEST}.png`),
      contentType: 'image/png',
    })
  })

  it.each([
    ['..', `${DIGEST}.png`],
    ['../../etc', `${DIGEST}.png`],
    [DOC_ID, '../../../etc/passwd'],
    [DOC_ID, '..%2f..%2fpasswd'],
    [DOC_ID, `${DIGEST}.png/../../../etc/passwd`],
    ['not-a-uuid', `${DIGEST}.png`],
    [DOC_ID, 'tangent.db'],
    [DOC_ID, `${DIGEST}.html`],
    [DOC_ID, `${DIGEST}.svg.html`],
    [DOC_ID, `${'z'.repeat(64)}.png`],
    [DOC_ID, ''],
    ['', ''],
  ])('refuses documentId=%j filename=%j', (documentId, filename) => {
    expect(resolveAssetPath(DOCS, documentId, filename)).toBeNull()
  })

  it('refuses a sibling directory that shares a prefix', () => {
    // A documentsDir of /data/documents must not authorize /data/documents-evil
    expect(resolveAssetPath('/data/documents', `../documents-evil`, `${DIGEST}.png`)).toBeNull()
  })
})

describe('assetUrl', () => {
  it('builds the URL the renderer will request', () => {
    expect(assetUrl(DOC_ID, `${DIGEST}.png`)).toBe(`tangent://assets/${DOC_ID}/${DIGEST}.png`)
  })
})
