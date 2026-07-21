import { mkdirSync } from 'fs'
import { join } from 'path'
import type { Database } from 'better-sqlite3'
import { openDatabase } from './connection'
import { migrate } from './migrations'
import { createRepos, type Repos } from './repos'

/** The MVP is single-Field; a default Field is seeded on first launch. */
const DEFAULT_FIELD_NAME = 'My Field'

export interface Storage {
  db: Database
  repos: Repos
  /** Imported documents are copied here (spec: one folder = whole backup). */
  documentsDir: string
}

/**
 * Bring the app-data directory to a ready state: create the layout, open the
 * DB (WAL + foreign_keys), apply pending migrations, seed the default Field.
 * Idempotent — safe to call on every launch. `dataDir` is app.getPath('userData')
 * in production and a temp dir in tests.
 */
export function initStorage(dataDir: string): Storage {
  const documentsDir = join(dataDir, 'documents')
  mkdirSync(documentsDir, { recursive: true })

  const db = openDatabase(join(dataDir, 'tangent.db'))
  migrate(db)

  const repos = createRepos(db)
  if (repos.fields.list().length === 0) {
    repos.fields.create(DEFAULT_FIELD_NAME)
  }

  return { db, repos, documentsDir }
}
