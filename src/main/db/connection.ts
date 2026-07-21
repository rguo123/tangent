import Database from 'better-sqlite3'

/** Open (creating if needed) the DB at `dbPath` with the app's standard pragmas. */
export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}
