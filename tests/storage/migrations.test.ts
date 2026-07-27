import { describe, expect, it } from 'vitest'
import { migrate } from '../../src/main/db/migrations'
import { testDb } from './helpers'

const EXPECTED_TABLES = [
  'anchor',
  'concept',
  'concept_mention',
  'document',
  'entry',
  'field',
  'flashcard',
  'flashcard_concept',
  'review_log',
  'schema_migrations',
  'thread',
]

describe('migrations', () => {
  it('creates the full schema', () => {
    const { db } = testDb()
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as {
        name: string
      }[]
    ).map((r) => r.name)
    expect(tables).toEqual(EXPECTED_TABLES)
  })

  it('is idempotent', () => {
    const { db } = testDb()
    const count = (): number =>
      (db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n

    const applied = count()
    expect(applied).toBeGreaterThan(0)

    // Re-running applies nothing and re-creates nothing — the second call is
    // what every launch after the first one does.
    expect(() => migrate(db)).not.toThrow()
    expect(count()).toBe(applied)
  })

  it('enforces schema constraints on raw inserts', () => {
    const { db, repos } = testDb()
    const field = repos.fields.create('F')

    // thread.document_id is NOT NULL (spec §3.3 invariant)
    expect(() =>
      db
        .prepare(
          `INSERT INTO thread (id, field_id, document_id, title, status, created_at)
           VALUES ('t1', ?, NULL, 'no doc', 'active', '2026-01-01T00:00:00.000Z')`,
        )
        .run(field.id),
    ).toThrow(/NOT NULL/)

    // content_ref is NULL iff chat_transcript
    const insertDoc = db.prepare(
      `INSERT INTO document (id, field_id, title, source_type, content_ref, created_at)
       VALUES (?, ?, 'd', ?, ?, '2026-01-01T00:00:00.000Z')`,
    )
    expect(() => insertDoc.run('d1', field.id, 'pdf', null)).toThrow(/CHECK/)
    expect(() => insertDoc.run('d2', field.id, 'chat_transcript', 'oops')).toThrow(/CHECK/)
    expect(() => insertDoc.run('d3', field.id, 'chat_transcript', null)).not.toThrow()

    // flashcard scheduling columns must be all-set or all-null
    expect(() =>
      db
        .prepare(
          `INSERT INTO flashcard (id, field_id, front, back, card_type, lifecycle, user_edited, due_at, created_at, updated_at)
           VALUES ('fc1', ?, 'f', 'b', 'recall', 'active', 0, '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run(field.id),
    ).toThrow(/CHECK/)

    // foreign keys are actually on
    expect(() =>
      db
        .prepare(
          `INSERT INTO document (id, field_id, title, source_type, content_ref, created_at)
           VALUES ('d4', 'no-such-field', 'd', 'markdown', 'x', '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/)
  })
})
