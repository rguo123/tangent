import { describe, expect, it } from 'vitest'
import type { CreateEntryRequest } from '../../src/shared/ipc'
import { createTimelineEntry } from '../../src/main/db/timeline'
import { seedThread, testDb } from './helpers'

const SELECTOR = {
  type: 'text-quote' as const,
  exact: 'the quick brown fox',
  prefix: 'over ',
  suffix: ' jumps',
  pageNumber: 3,
}

describe('createTimelineEntry', () => {
  it('creates an unanchored entry', () => {
    const { repos, db } = testDb()
    const { thread } = seedThread(repos)

    const result = createTimelineEntry(db, repos, {
      threadId: thread.id,
      kind: 'note',
      body: 'a plain note',
    })

    expect(result.anchor).toBeNull()
    expect(result.entry.anchorId).toBeNull()
    expect(repos.entries.listByThread(thread.id)).toEqual([result.entry])
  })

  it('creates anchor and entry together, linked', () => {
    const { repos, db } = testDb()
    const { thread, document } = seedThread(repos)

    const result = createTimelineEntry(db, repos, {
      threadId: thread.id,
      kind: 'question',
      body: 'what does this passage mean?',
      anchor: { documentId: document.id, selector: SELECTOR },
    })

    expect(result.anchor).not.toBeNull()
    expect(result.entry.anchorId).toBe(result.anchor!.id)
    expect(result.anchor!.selector).toEqual(SELECTOR)
    expect(repos.anchors.listByThread(thread.id)).toEqual([result.anchor])
  })

  it('rolls the anchor back when the entry insert fails', () => {
    const { repos, db } = testDb()
    const { thread, document } = seedThread(repos)

    const bad = {
      threadId: thread.id,
      kind: 'bogus', // violates the entry.kind CHECK after the anchor insert succeeds
      body: 'never lands',
      anchor: { documentId: document.id, selector: SELECTOR },
    } as unknown as CreateEntryRequest

    expect(() => createTimelineEntry(db, repos, bad)).toThrow()
    expect(repos.anchors.listByThread(thread.id)).toEqual([])
    expect(repos.entries.listByThread(thread.id)).toEqual([])
  })
})
