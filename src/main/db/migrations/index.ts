import type { Database } from 'better-sqlite3'
import { nowIso } from '../util'
import { sql as initialSchema } from './001_initial_schema'
import { sql as anchorWatermark } from './002_anchor_watermark'
import { sql as documentSourceUrl } from './003_document_source_url'

interface Migration {
  id: number
  name: string
  sql: string
}

/** Ordered, append-only. New migrations get the next id; applied ones never change. */
const migrations: Migration[] = [
  { id: 1, name: 'initial_schema', sql: initialSchema },
  { id: 2, name: 'anchor_watermark', sql: anchorWatermark },
  { id: 3, name: 'document_source_url', sql: documentSourceUrl },
]

/** Apply all pending migrations, each in its own transaction. Idempotent. */
export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `)
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id),
  )
  const record = db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
  const apply = db.transaction((m: Migration) => {
    db.exec(m.sql)
    record.run(m.id, m.name, nowIso())
  })
  for (const m of migrations) {
    if (!applied.has(m.id)) apply(m)
  }
}
