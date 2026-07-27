import { contextBridge, ipcRenderer } from 'electron'
import type { ThreadStatus } from '@shared/entities'
import type {
  AskRequest,
  CreateEntryRequest,
  IpcChannel,
  IpcEventChannel,
  IpcEventPayload,
  IpcRequest,
  IpcResponse,
} from '@shared/ipc'

/** Typed wrapper over ipcRenderer.invoke — request/response types are derived
 *  from the IpcContract entry for the channel. Channels with `request: void`
 *  take no argument. */
function invoke<C extends IpcChannel>(
  channel: C,
  ...args: IpcRequest<C> extends void ? [] : [IpcRequest<C>]
): Promise<IpcResponse<C>> {
  return ipcRenderer.invoke(channel, ...args)
}

/** The push direction: subscribe to a main-process event, get an unsubscribe
 *  back. The raw IpcRendererEvent never crosses the bridge — only the payload. */
function subscribe<C extends IpcEventChannel>(
  channel: C,
  listener: (payload: IpcEventPayload<C>) => void,
): () => void {
  const wrapped = (_event: unknown, payload: IpcEventPayload<C>): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.off(channel, wrapped)
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
    setPinned: (entryId: string, pinned: boolean) =>
      invoke('entries:setPinned', { entryId, pinned }),
  },
  agent: {
    status: () => invoke('agent:status'),
    ask: (req: AskRequest) => invoke('entries:ask', req),
    retry: (entryId: string) => invoke('entries:retryAsk', { entryId }),
    onStart: (listener: (payload: IpcEventPayload<'agent:start'>) => void) =>
      subscribe('agent:start', listener),
    onDelta: (listener: (payload: IpcEventPayload<'agent:delta'>) => void) =>
      subscribe('agent:delta', listener),
    onEnd: (listener: (payload: IpcEventPayload<'agent:end'>) => void) =>
      subscribe('agent:end', listener),
  },
  extraction: {
    setActiveThread: (threadId: string | null) =>
      invoke('extraction:setActiveThread', { threadId }),
    run: (threadId: string) => invoke('extraction:run', { threadId }),
    undo: (batchId: string) => invoke('extraction:undo', { batchId }),
    onCommitted: (listener: (payload: IpcEventPayload<'extraction:committed'>) => void) =>
      subscribe('extraction:committed', listener),
    onFailed: (listener: (payload: IpcEventPayload<'extraction:failed'>) => void) =>
      subscribe('extraction:failed', listener),
  },
  debug: {
    versions: () => invoke('debug:versions'),
    dbStats: () => invoke('debug:dbStats'),
  },
}

export type TangentApi = typeof api

contextBridge.exposeInMainWorld('tangent', api)
