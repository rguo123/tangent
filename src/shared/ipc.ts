/**
 * IPC contract shared between main, preload, and renderer.
 *
 * Every channel is a key in `IpcContract`, mapping to its request/response
 * types. Main registers handlers through `handle()` (src/main/ipc) and the
 * renderer calls through `invoke()` (src/preload) — both derive their
 * signatures from this one map, so the two sides cannot drift.
 */

export interface DebugVersions {
  electron: string
  chrome: string
  node: string
  sqlite: string
}

/** Row counts per table — dev-only visibility into the DB. */
export interface DbStats {
  tables: Record<string, number>
}

export interface IpcContract {
  'debug:versions': { request: void; response: DebugVersions }
  'debug:dbStats': { request: void; response: DbStats }
}

export type IpcChannel = keyof IpcContract
export type IpcRequest<C extends IpcChannel> = IpcContract[C]['request']
export type IpcResponse<C extends IpcChannel> = IpcContract[C]['response']
