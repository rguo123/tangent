import { contextBridge, ipcRenderer } from 'electron'
import type { IpcChannel, IpcRequest, IpcResponse } from '@shared/ipc'

/** Typed wrapper over ipcRenderer.invoke — request/response types are derived
 *  from the IpcContract entry for the channel. Channels with `request: void`
 *  take no argument. */
function invoke<C extends IpcChannel>(
  channel: C,
  ...args: IpcRequest<C> extends void ? [] : [IpcRequest<C>]
): Promise<IpcResponse<C>> {
  return ipcRenderer.invoke(channel, ...args)
}

const api = {
  debug: {
    versions: () => invoke('debug:versions'),
  },
}

export type TangentApi = typeof api

contextBridge.exposeInMainWorld('tangent', api)
