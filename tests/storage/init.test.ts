import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initStorage, type Storage } from '../../src/main/db/init'

describe('initStorage', () => {
  let dir: string
  let storage: Storage | null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tangent-test-'))
    storage = null
  })

  afterEach(() => {
    storage?.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the app-data layout and seeds a default Field', () => {
    storage = initStorage(dir)
    expect(existsSync(join(dir, 'tangent.db'))).toBe(true)
    expect(storage.documentsDir).toBe(join(dir, 'documents'))
    expect(existsSync(storage.documentsDir)).toBe(true)

    const fields = storage.repos.fields.list()
    expect(fields).toHaveLength(1)
    expect(fields[0].name).toBe('My Field')
  })

  it('is idempotent across relaunches and persists data', () => {
    storage = initStorage(dir)
    const seeded = storage.repos.fields.list()[0]
    const doc = storage.repos.documents.create({
      fieldId: seeded.id,
      title: 'Persisted',
      sourceType: 'markdown',
      contentRef: '# body',
    })
    storage.db.close()

    storage = initStorage(dir)
    expect(storage.repos.fields.list()).toHaveLength(1)
    expect(storage.repos.documents.getById(doc.id)?.title).toBe('Persisted')
  })
})
