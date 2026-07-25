import type { Storage } from '../db/init'
import { createTimelineEntry } from '../db/timeline'
import { handle } from './handle'

export function registerEntryIpc(storage: Storage): void {
  const { entries, anchors } = storage.repos

  handle('timeline:get', ({ threadId }) => ({
    entries: entries.listByThread(threadId),
    anchors: anchors.listByThread(threadId),
  }))

  handle('entries:create', (req) => createTimelineEntry(storage.db, storage.repos, req))

  handle('entries:updateBody', ({ entryId, body }) => {
    entries.updateBody(entryId, body)
    return readEntry(entryId)
  })

  handle('entries:setPinned', ({ entryId, pinned }) => {
    entries.setPinned(entryId, pinned)
    return readEntry(entryId)
  })

  function readEntry(entryId: string) {
    const entry = entries.getById(entryId)
    if (!entry) throw new Error(`No entry ${entryId}`)
    return entry
  }
}
