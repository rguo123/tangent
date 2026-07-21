import Database from 'better-sqlite3'
import type { DebugVersions } from '@shared/ipc'
import { handle } from './handle'

function getSqliteVersion(): string {
  const db = new Database(':memory:')
  try {
    const row = db.prepare('SELECT sqlite_version() AS version').get() as { version: string }
    return row.version
  } finally {
    db.close()
  }
}

export function registerDebugIpc(): void {
  // All values are constants for the life of the process — compute once.
  const versions: DebugVersions = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    sqlite: getSqliteVersion(),
  }
  handle('debug:versions', () => versions)
}
