import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initStorage, type Storage } from '../../src/main/db/init'
import { importDocument, readDocumentContent } from '../../src/main/documents/import'

/** Real temp-dir storage (not in-memory): import copies files, so the
 *  documents dir has to exist on disk. */
let dataDir: string
let sourceDir: string
let storage: Storage

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tangent-data-'))
  sourceDir = mkdtempSync(join(tmpdir(), 'tangent-src-'))
  storage = initStorage(dataDir)
})

afterEach(() => {
  storage.db.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(sourceDir, { recursive: true, force: true })
})

const FAKE_PDF = Buffer.from('%PDF-1.4 fake body for copy tests')

function writeSource(name: string, content: Buffer | string): string {
  const path = join(sourceDir, name)
  writeFileSync(path, content)
  return path
}

describe('importDocument', () => {
  it('imports a PDF: copies the file in, creates document + thread in the default field', () => {
    const src = writeSource('attention.pdf', FAKE_PDF)
    const { document, thread } = importDocument(storage, src)

    expect(document.sourceType).toBe('pdf')
    expect(document.title).toBe('attention')
    expect(document.contentRef).toBe(`${document.id}.pdf`)
    expect(readdirSync(storage.documentsDir)).toEqual([`${document.id}.pdf`])

    const field = storage.repos.fields.getDefault()
    expect(document.fieldId).toBe(field.id)
    expect(thread.fieldId).toBe(field.id)
    expect(thread.documentId).toBe(document.id)
    expect(thread.title).toBe('attention')
    expect(thread.status).toBe('active')
  })

  it('survives the original file moving — copy semantics, not a path reference', () => {
    const src = writeSource('paper.pdf', FAKE_PDF)
    const { document } = importDocument(storage, src)
    rmSync(src)

    const content = readDocumentContent(storage, document.id)
    expect(content.sourceType).toBe('pdf')
    if (content.sourceType !== 'pdf') throw new Error('unreachable')
    expect(Buffer.from(content.data).equals(FAKE_PDF)).toBe(true)
  })

  it('imports markdown: content is inlined into content_ref, no file copy', () => {
    const src = writeSource('notes.md', '# Raft\n\nLeader election.')
    const { document } = importDocument(storage, src)
    rmSync(src)

    expect(document.sourceType).toBe('markdown')
    expect(document.contentRef).toBe('# Raft\n\nLeader election.')
    expect(readdirSync(storage.documentsDir)).toEqual([])

    const content = readDocumentContent(storage, document.id)
    expect(content).toEqual({ sourceType: 'markdown', content: '# Raft\n\nLeader election.' })
  })

  it('accepts the .markdown extension', () => {
    const src = writeSource('a.markdown', 'body')
    expect(importDocument(storage, src).document.sourceType).toBe('markdown')
  })

  it('rejects unsupported file types', () => {
    const src = writeSource('image.png', 'not a doc')
    expect(() => importDocument(storage, src)).toThrow(/Unsupported file type/)
  })

  it('two imports of the same file make two independent documents', () => {
    const src = writeSource('twice.pdf', FAKE_PDF)
    const a = importDocument(storage, src)
    const b = importDocument(storage, src)
    expect(a.document.id).not.toBe(b.document.id)
    expect(readdirSync(storage.documentsDir).sort()).toEqual(
      [`${a.document.id}.pdf`, `${b.document.id}.pdf`].sort(),
    )
  })
})

describe('readDocumentContent', () => {
  it('throws for an unknown document id', () => {
    expect(() => readDocumentContent(storage, 'nope')).toThrow(/No such document/)
  })

  it('throws for chat_transcript documents (content lives in the thread)', () => {
    const field = storage.repos.fields.getDefault()
    const doc = storage.repos.documents.create({
      fieldId: field.id,
      title: 'Exploration',
      sourceType: 'chat_transcript',
      contentRef: null,
    })
    expect(() => readDocumentContent(storage, doc.id)).toThrow(/chat_transcript/)
  })
})
