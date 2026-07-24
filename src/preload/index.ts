import { contextBridge, ipcRenderer } from 'electron'
import type { ThreadStatus } from '@shared/entities'
import type { CreateEntryRequest, IpcChannel, IpcRequest, IpcResponse } from '@shared/ipc'

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
  documents: {
    import: () => invoke('documents:import'),
    content: (documentId: string) => invoke('documents:content', { documentId }),
  },
  threads: {
    list: () => invoke('threads:list'),
    setStatus: (threadId: string, status: ThreadStatus) =>
      invoke('threads:setStatus', { threadId, status }),
  },
  timeline: {
    get: (threadId: string) => invoke('timeline:get', { threadId }),
  },
  entries: {
    create: (req: CreateEntryRequest) => invoke('entries:create', req),
    updateBody: (entryId: string, body: string) => invoke('entries:updateBody', { entryId, body }),
  },
  debug: {
    versions: () => invoke('debug:versions'),
    dbStats: () => invoke('debug:dbStats'),
  },
}

export type TangentApi = typeof api

contextBridge.exposeInMainWorld('tangent', api)
