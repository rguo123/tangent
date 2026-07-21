import type { Database } from 'better-sqlite3'
import type { DebugVersions } from '@shared/ipc'
import { createDbStatsReader, sqliteVersion } from '../db/stats'
import { handle } from './handle'

export function registerDebugIpc(db: Database): void {
  // All values are constants for the life of the process — compute once.
  const versions: DebugVersions = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    sqlite: sqliteVersion(db),
  }
  handle('debug:versions', () => versions)
  handle('debug:dbStats', createDbStatsReader(db))
}
