import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Storage } from '../../src/main/db/init'
import { clearDocumentTextCache, readDocumentText } from '../../src/main/documents/text'
import { seedMarkdownDocument, tempStorage } from '../storage/helpers'

let storage: Storage
let dataDir: string
let cleanup: () => void

beforeEach(() => {
  ;({ storage, dataDir, cleanup } = tempStorage())
  clearDocumentTextCache()
})

afterEach(() => {
  cleanup()
})

const seed = (body: string) => seedMarkdownDocument(storage, dataDir, body)

describe('readDocumentText', () => {
  it('bounds the result to the requested budget', async () => {
    const { document } = seed('x'.repeat(500))

    const text = await readDocumentText(storage, document.id, 100)

    expect(text.startsWith('x'.repeat(100))).toBe(true)
    expect(text).toContain('[...truncated]')
  })

  it('serves a larger budget in full rather than a cached shorter read', async () => {
    const { document } = seed('x'.repeat(500))

    // The narrow read populates the cache first. Keying on the document alone
    // would hand this 100-char prefix back to the 400-char caller.
    await readDocumentText(storage, document.id, 100)
    const wide = await readDocumentText(storage, document.id, 400)

    expect(wide.startsWith('x'.repeat(400))).toBe(true)
  })

  it('replaces images with their alt text', async () => {
    const { document } = seed('before ![a diagram](tangent://assets/abc/def.png) after')

    const text = await readDocumentText(storage, document.id, 10_000)

    expect(text).toBe('before a diagram after')
  })
})
