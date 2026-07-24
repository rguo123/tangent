import type { Storage } from '../db/init'
import { handle } from './handle'

export function registerThreadIpc(storage: Storage): void {
  const { fields, threads } = storage.repos

  handle('threads:list', () => threads.listByFieldWithDocument(fields.getDefault().id))

  handle('threads:setStatus', ({ threadId, status }) => {
    threads.setStatus(threadId, status)
  })
}
