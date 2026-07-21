import { ipcMain } from 'electron'
import type { IpcChannel, IpcRequest, IpcResponse } from '@shared/ipc'

/** Typed wrapper over ipcMain.handle — the handler's signature is derived
 *  from the IpcContract entry for the channel. */
export function handle<C extends IpcChannel>(
  channel: C,
  fn: (req: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
): void {
  ipcMain.handle(channel, (_event, req: IpcRequest<C>) => fn(req))
}
