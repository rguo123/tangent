import { useEffect, useState } from 'react'
import type { DbStats, DebugVersions } from '@shared/ipc'

export default function App() {
  const [versions, setVersions] = useState<DebugVersions | null>(null)
  const [stats, setStats] = useState<DbStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refreshStats = () => {
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
    refreshStats()
  }, [])

  return (
    <div className="app">
      <h1>Tangent</h1>
      <p className="subtitle">Phase 1 — storage layer</p>
      {error && <p className="error">IPC error: {error}</p>}
      {versions && (
        <table>
          <tbody>
            <tr>
              <td>Electron</td>
              <td>{versions.electron}</td>
            </tr>
            <tr>
              <td>Chrome</td>
              <td>{versions.chrome}</td>
            </tr>
            <tr>
              <td>Node</td>
              <td>{versions.node}</td>
            </tr>
            <tr>
              <td>SQLite (native, via IPC)</td>
              <td>{versions.sqlite}</td>
            </tr>
          </tbody>
        </table>
      )}
      <h2>
        DB stats <button onClick={refreshStats}>refresh</button>
      </h2>
      {stats ? (
        <table>
          <tbody>
            {Object.entries(stats.tables).map(([table, count]) => (
              <tr key={table}>
                <td>{table}</td>
                <td>{count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        !error && <p>Loading…</p>
      )}
    </div>
  )
}
