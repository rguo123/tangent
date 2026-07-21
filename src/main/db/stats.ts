import type { Database } from 'better-sqlite3'
import type { DbStats } from '@shared/ipc'

export function sqliteVersion(db: Database): string {
  return (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v
}

/**
 * Build a row-count reader over every table in the migrated schema. The table
 * list comes from sqlite_master at construction (after migrations have run),
 * so new tables show up without touching this file; the counts run as one
 * statement prepared once.
 */
export function createDbStatsReader(db: Database): () => DbStats {
  const tables = (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name <> 'schema_migrations'
         ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name)
  const counts = db.prepare(
    tables.map((t) => `SELECT '${t}' AS tbl, COUNT(*) AS n FROM "${t}"`).join(' UNION ALL '),
  )
  return () => {
    const out: Record<string, number> = {}
    for (const row of counts.all() as { tbl: string; n: number }[]) out[row.tbl] = row.n
    return { tables: out }
  }
}
