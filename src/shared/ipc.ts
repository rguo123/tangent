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

export interface IpcContract {
  'debug:versions': { request: void; response: DebugVersions }
}

export type IpcChannel = keyof IpcContract
export type IpcRequest<C extends IpcChannel> = IpcContract[C]['request']
export type IpcResponse<C extends IpcChannel> = IpcContract[C]['response']
