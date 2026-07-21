import { openDatabase } from '../../src/main/db/connection'
import { migrate } from '../../src/main/db/migrations'
import { createRepos, type Repos } from '../../src/main/db/repos'
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
