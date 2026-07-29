import { describe, expect, it } from 'vitest'
import type { FsrsScheduling } from '../../src/shared/entities'
import { seedCard, testDb } from './helpers'

const PREV: FsrsScheduling = {
  stability: 2.5,
  difficulty: 4.2,
  dueAt: '2026-01-05T00:00:00.000Z',
  lastReviewedAt: '2026-01-01T00:00:00.000Z',
  state: 2,
  learningSteps: 0,
}

describe('reviewLogRepo', () => {
  it('appends reviews with pre-review state and finds the undo target', () => {
    const { repos } = testDb()
    const { card } = seedCard(repos)

    const first = repos.reviewLogs.append({
      flashcardId: card.id,
      rating: 3,
      scheduledInterval: 1,
      prevScheduling: null, // first-ever review of a just-accepted card
      reviewedAt: '2026-01-01T10:00:00.000Z',
    })
    const second = repos.reviewLogs.append({
      flashcardId: card.id,
      rating: 4,
      scheduledInterval: 4,
      prevScheduling: PREV,
      reviewedAt: '2026-01-02T10:00:00.000Z',
    })

    expect(repos.reviewLogs.listFor(card.id).map((l) => l.id)).toEqual([first.id, second.id])

    // undo target is the latest not-undone review, carrying its pre-state
    const target = repos.reviewLogs.latestFor(card.id)
    expect(target?.id).toBe(second.id)
    expect(target?.prevScheduling).toEqual(PREV)

    // undo flags the row (append-only — the row survives) and exposes the previous one
    repos.reviewLogs.markUndone(second.id)
    expect(repos.reviewLogs.latestFor(card.id)?.id).toBe(first.id)
    expect(repos.reviewLogs.listFor(card.id)).toHaveLength(2)
    expect(repos.reviewLogs.listFor(card.id)[1].undone).toBe(true)
  })
})
