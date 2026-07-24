import { useEffect, useState } from 'react'
import type { DbStats, DebugVersions } from '@shared/ipc'

function KvTable({ rows }: { rows: object }) {
  return (
    <table>
      <tbody>
        {Object.entries(rows).map(([key, value]) => (
          <tr key={key}>
            <td>{key}</td>
            <td>{String(value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Dev-only corner: runtime versions + DB row counts (Phase 1's panel, now an
 *  overlay behind a header toggle). */
export default function DevStats({ onClose }: { onClose: () => void }) {
  const [versions, setVersions] = useState<DebugVersions | null>(null)
  const [stats, setStats] = useState<DbStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = () => {
    window.tangent.debug
      .dbStats()
      .then(setStats)
      .catch((err: unknown) => setError(String(err)))
  }

  useEffect(() => {
    window.tangent.debug
      .versions()
      .then(setVersions)
      .catch((err: unknown) => setError(String(err)))
    refresh()
  }, [])

  return (
    <div className="dev-stats">
      <header className="pane-header">
        <span className="pane-title">Dev stats</span>
        <button onClick={refresh}>refresh</button>
        <button onClick={onClose}>×</button>
      </header>
      {error && <p className="error">{error}</p>}
      {versions && <KvTable rows={versions} />}
      {stats && <KvTable rows={stats.tables} />}
    </div>
  )
}
