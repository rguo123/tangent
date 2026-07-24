import type { Database } from 'better-sqlite3'
import type { CreateEntryRequest, CreateEntryResult } from '@shared/ipc'
import type { Repos } from './repos'

/**
 * Create an entry, plus its anchor when the request carries one, as a single
 * transaction — an anchored entry must never half-commit. Repos stay
 * single-table; cross-entity writes compose them here.
 */
export function createTimelineEntry(
  db: Database,
  repos: Repos,
  input: CreateEntryRequest,
): CreateEntryResult {
  const run = db.transaction((): CreateEntryResult => {
    const anchor = input.anchor
      ? repos.anchors.create({
          threadId: input.threadId,
          documentId: input.anchor.documentId,
          selector: input.anchor.selector,
        })
      : null
    const entry = repos.entries.create({
      threadId: input.threadId,
      kind: input.kind,
      body: input.body,
      anchorId: anchor?.id,
    })
    return { entry, anchor }
  })
  return run()
}
