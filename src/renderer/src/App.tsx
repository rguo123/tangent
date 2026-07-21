import { useEffect, useState } from 'react'
import type { DebugVersions } from '@shared/ipc'

export default function App() {
  const [versions, setVersions] = useState<DebugVersions | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.tangent.debug
      .versions()
      .then(setVersions)
      .catch((err: unknown) => setError(String(err)))
  }, [])

  return (
    <div className="app">
      <h1>Tangent</h1>
      <p className="subtitle">Phase 0 — toolchain proof</p>
      {error && <p className="error">IPC error: {error}</p>}
      {versions ? (
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
      ) : (
        !error && <p>Loading…</p>
      )}
    </div>
  )
}
