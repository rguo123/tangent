import { readdirSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Storage } from '../../src/main/db/init'
import { importUrlDocument } from '../../src/main/documents/import'
import { clearDocumentTextCache, readDocumentText } from '../../src/main/documents/text'
import type { FetchBytes } from '../../src/main/documents/webAssets'
import type { FetchPage } from '../../src/main/documents/webFetch'
import { tempStorage } from '../storage/helpers'
import { articlePage, PROSE } from './helpers'

let storage: Storage
let cleanup: () => void

beforeEach(() => {
  ;({ storage, cleanup } = tempStorage())
  clearDocumentTextCache()
})

afterEach(() => cleanup())

const URL_UNDER_TEST = 'https://example.com/posts/raft'

function pageHtml(extra = ''): string {
  return articlePage(`<h1>Raft</h1>${PROSE}${extra}`)
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9])

function deps(html = pageHtml(), finalUrl = URL_UNDER_TEST) {
  const fetched: string[] = []
  const fetchPage: FetchPage = async () => ({ html, finalUrl })
  const fetchBytes: FetchBytes = async (url) => {
    fetched.push(url)
    return { bytes: PNG_BYTES, contentType: 'image/png' }
  }
  return { fetchPage, fetchBytes, fetched }
}

describe('importUrlDocument', () => {
  it('creates a markdown document and its first thread, tagged with the URL', async () => {
    const { document, thread } = await importUrlDocument(storage, URL_UNDER_TEST, deps())

    expect(document.sourceType).toBe('markdown')
    expect(document.title).toBe('Raft')
    expect(document.sourceUrl).toBe(URL_UNDER_TEST)
    expect(document.contentRef).toContain('Paragraph 0')
    expect(document.contentRef).not.toContain('Home')

    const field = storage.repos.fields.getDefault()
    expect(document.fieldId).toBe(field.id)
    expect(thread.documentId).toBe(document.id)
    expect(thread.title).toBe('Raft')
    expect(thread.status).toBe('active')
  })

  it('records where a redirect actually landed, not where it was pointed', async () => {
    const landed = 'https://example.com/posts/raft-consensus'
    const { document } = await importUrlDocument(storage, URL_UNDER_TEST, deps(pageHtml(), landed))
    expect(document.sourceUrl).toBe(landed)
  })

  it('downloads images and points the stored markdown at local copies', async () => {
    const { document } = await importUrlDocument(
      storage,
      URL_UNDER_TEST,
      deps(pageHtml('<p><img src="/img/diagram.png" alt="Diagram"></p>')),
    )

    expect(document.contentRef).toMatch(
      new RegExp(`!\\[Diagram\\]\\(tangent://assets/${document.id}/[0-9a-f]{64}\\.png\\)`),
    )
    expect(readdirSync(join(storage.documentsDir, document.id))).toHaveLength(1)
  })

  it('degrades an image it could not fetch to its alt text', async () => {
    const base = deps(pageHtml('<p><img src="/img/gone.png" alt="Missing figure"></p>'))
    const failing: FetchBytes = async () => {
      throw new Error('404')
    }
    const { document } = await importUrlDocument(storage, URL_UNDER_TEST, {
      ...base,
      fetchBytes: failing,
    })

    expect(document.contentRef).toContain('Missing figure')
    expect(document.contentRef).not.toContain('tangent://')
    expect(document.contentRef).not.toContain('/img/gone.png')
  })

  it('gives the agent the article without the asset URLs', async () => {
    const { document } = await importUrlDocument(
      storage,
      URL_UNDER_TEST,
      deps(pageHtml('<p><img src="/img/diagram.png" alt="Diagram"></p>')),
    )

    const text = await readDocumentText(storage, document.id, 10_000)
    expect(text).toContain('Paragraph 0')
    expect(text).toContain('Diagram')
    expect(text).not.toContain('tangent://')
  })

  it('leaves no document behind when there is no article to import', async () => {
    const empty = '<!doctype html><html><body><nav><a href="/a">a</a></nav></body></html>'
    await expect(importUrlDocument(storage, URL_UNDER_TEST, deps(empty))).rejects.toThrow(
      /No readable article/,
    )

    const field = storage.repos.fields.getDefault()
    expect(storage.repos.documents.listByField(field.id)).toEqual([])
    expect(readdirSync(storage.documentsDir)).toEqual([])
  })

  it('propagates a fetch failure without writing anything', async () => {
    const failing: FetchPage = async () => {
      throw new Error('Timed out loading the page')
    }
    await expect(
      importUrlDocument(storage, URL_UNDER_TEST, { ...deps(), fetchPage: failing }),
    ).rejects.toThrow(/Timed out/)

    const field = storage.repos.fields.getDefault()
    expect(storage.repos.documents.listByField(field.id)).toEqual([])
  })

  it('imports the same URL twice as two independent documents', async () => {
    const a = await importUrlDocument(storage, URL_UNDER_TEST, deps())
    const b = await importUrlDocument(storage, URL_UNDER_TEST, deps())
    expect(a.document.id).not.toBe(b.document.id)
    expect(a.thread.id).not.toBe(b.thread.id)
  })
})
