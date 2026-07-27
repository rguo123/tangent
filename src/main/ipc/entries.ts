import type { OnThreadActivity } from '../agent/extractionService'
import type { Storage } from '../db/init'
import { createTimelineEntry } from '../db/timeline'
import { handle } from './handle'

/** Writes report activity so extraction's idle timer restarts from here rather
 *  than from the renderer: main already sees every committed entry, and a
 *  keystroke was never the right granularity anyway. */
export function registerEntryIpc(storage: Storage, onActivity: OnThreadActivity): void {
  const { entries, anchors } = storage.repos

  handle('timeline:get', ({ threadId }) => ({
    entries: entries.listByThread(threadId),
    anchors: anchors.listByThread(threadId),
  }))

  handle('entries:create', (req) => {
    const result = createTimelineEntry(storage.db, storage.repos, req)
    onActivity(req.threadId)
    return result
  })

  handle('entries:updateBody', ({ entryId, body }) => {
    entries.updateBody(entryId, body)
    const entry = readEntry(entryId)
    onActivity(entry.threadId)
    return entry
  })

  handle('entries:setPinned', ({ entryId, pinned }) => {
    entries.setPinned(entryId, pinned)
    // Pinning is the gesture that makes an answer extraction fodder (spec
    // §5.1), so it counts as activity in its own right.
    const entry = readEntry(entryId)
    onActivity(entry.threadId)
    return entry
  })

  function readEntry(entryId: string) {
    const entry = entries.getById(entryId)
    if (!entry) throw new Error(`No entry ${entryId}`)
    return entry
  }
}
