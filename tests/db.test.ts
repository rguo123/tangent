import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

describe('better-sqlite3 toolchain proof', () => {
  let dir: string
  let db: Database.Database

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tangent-test-'))
    db = new Database(join(dir, 'test.db'))
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a table, inserts, and reads back', () => {
    db.exec(`
      CREATE TABLE note (
        id INTEGER PRIMARY KEY,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
    const insert = db.prepare('INSERT INTO note (body) VALUES (?)')
    insert.run('hello tangent')
    insert.run('second note')

    const rows = db.prepare('SELECT body FROM note ORDER BY id').all() as { body: string }[]
    expect(rows.map((r) => r.body)).toEqual(['hello tangent', 'second note'])
  })

  it('enforces CHECK constraints', () => {
    db.exec(`
      CREATE TABLE mention (
        id INTEGER PRIMARY KEY,
        entry_id INTEGER,
        anchor_id INTEGER,
        CHECK (entry_id IS NOT NULL OR anchor_id IS NOT NULL)
      )
    `)
    expect(() => db.prepare('INSERT INTO mention (entry_id, anchor_id) VALUES (NULL, NULL)').run()).toThrow()
    expect(() => db.prepare('INSERT INTO mention (entry_id) VALUES (1)').run()).not.toThrow()
  })

  it('persists across connections', () => {
    db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)')
    db.prepare('INSERT INTO kv VALUES (?, ?)').run('key', 'value')
    db.close()

    db = new Database(join(dir, 'test.db'))
    const row = db.prepare('SELECT v FROM kv WHERE k = ?').get('key') as { v: string }
    expect(row.v).toBe('value')
  })
})
