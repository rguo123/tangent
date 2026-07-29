import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDatabase } from '../../src/main/db/connection'
import { initStorage, type Storage } from '../../src/main/db/init'
import { migrate } from '../../src/main/db/migrations'
import { createRepos, type Repos } from '../../src/main/db/repos'
import { importDocument } from '../../src/main/documents/import'
import type { Database } from 'better-sqlite3'

export interface TestDb {
  db: Database
  repos: Repos
}

/** Fresh in-memory DB with the full schema applied. */
export function testDb(): TestDb {
  const db = openDatabase(':memory:')
  migrate(db)
  return { db, repos: createRepos(db) }
}

/** `testDb` as a `Storage`, for the layers that take one but never touch the
 *  documents dir — the agent pipelines read the DB and the provider, nothing
 *  else. Use `tempStorage` when a real directory is needed. */
export function testStorage(): Storage {
  return { ...testDb(), documentsDir: '' }
}

/** Real on-disk storage, for anything that touches the documents dir (import,
 *  PDF text extraction) — an in-memory DB isn't enough there. Close the DB
 *  before removing the dir, which is what `cleanup` orders correctly. */
export function tempStorage(): { storage: Storage; dataDir: string; cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'tangent-test-'))
  const storage = initStorage(dataDir)
  return {
    storage,
    dataDir,
    cleanup: () => {
      storage.db.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/**
 * A markdown document imported through the real import path, for tests that
 * need a document with readable text on disk.
 *
 * Pair with `clearDocumentTextCache()` in `beforeEach`: `readDocumentText`
 * memoizes per process, so without it one test file's extraction leaks into
 * the next and the failure looks like a bug in the reader.
 */
export function seedMarkdownDocument(storage: Storage, dataDir: string, body: string) {
  const source = join(dataDir, 'paper.md')
  writeFileSync(source, body)
  return importDocument(storage, source)
}

/** field → concept → one draft recall card, for flashcard/review tests. */
export function seedCard(repos: Repos) {
  const { field } = seedThread(repos)
  const concept = repos.concepts.create({ fieldId: field.id, canonicalText: 'c' })
  const card = repos.flashcards.create({
    fieldId: field.id,
    conceptIds: [concept.id],
    front: 'f',
    back: 'b',
    cardType: 'recall',
  })
  return { field, concept, card }
}

/** The minimum FK chain most tests need: field → document → thread. */
export function seedThread(repos: Repos) {
  const field = repos.fields.create('Test Field')
  const document = repos.documents.create({
    fieldId: field.id,
    title: 'Test Paper',
    sourceType: 'markdown',
    contentRef: '# hello',
  })
  const thread = repos.threads.create({
    fieldId: field.id,
    documentId: document.id,
    title: 'Test Thread',
  })
  return { field, document, thread }
}
