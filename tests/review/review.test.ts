import { beforeEach, describe, expect, it } from 'vitest'
import type { Storage } from '../../src/main/db/init'
import {
  acceptCard,
  discardCard,
  editCard,
  reviewCard,
  setCardLifecycle,
  undoLastReview,
} from '../../src/main/review'
import type { Flashcard, ReviewRating } from '../../src/shared/entities'
import { seedThread, testStorage } from '../storage/helpers'

/**
 * The review loop: accepting a draft into scheduling, grading it, and taking a
 * grade back. `ts-fsrs` owns the intervals, so nothing here asserts a specific
 * number of days — what's tested is that the state we persist is the state the
 * scheduler gets back, which is the part this app can get wrong.
 */

const NOW = new Date('2026-07-01T09:00:00.000Z')

let storage: Storage
let fieldId: string

function makeDraft(front = 'How does attention scale?'): Flashcard {
  const concept = storage.repos.concepts.create({ fieldId, canonicalText: 'attention cost' })
  return storage.repos.flashcards.create({
    fieldId,
    conceptIds: [concept.id],
    front,
    back: 'Quadratically in sequence length.',
    cardType: 'recall',
  })
}

function dueAfter(card: Flashcard, rating: ReviewRating, now = NOW): number {
  const { card: graded } = reviewCard(storage, card.id, rating, now)
  return new Date(graded.scheduling!.dueAt).getTime()
}

beforeEach(() => {
  storage = testStorage()
  fieldId = seedThread(storage.repos).field.id
})

describe('accepting a draft', () => {
  it('puts the card into FSRS as a new card, due immediately', () => {
    const draft = makeDraft()
    expect(storage.repos.flashcards.listDue(fieldId)).toHaveLength(0)

    const accepted = acceptCard(storage, draft.id, NOW)

    expect(accepted.lifecycle).toBe('active')
    expect(accepted.scheduling).toMatchObject({ state: 0, lastReviewedAt: null })
    expect(accepted.scheduling!.dueAt).toBe(NOW.toISOString())
    expect(storage.repos.flashcards.listDue(fieldId).map((c) => c.id)).toEqual([draft.id])
  })

  it('refuses a card that is already accepted', () => {
    const card = acceptCard(storage, makeDraft().id, NOW)
    expect(() => acceptCard(storage, card.id, NOW)).toThrow(/already been accepted/)
  })

  it('refuses to review a draft — the cull pass is a real gate', () => {
    const draft = makeDraft()
    expect(() => reviewCard(storage, draft.id, 3, NOW)).toThrow(/Accept that card/)
  })
})

describe('grading', () => {
  it('spreads due dates by rating, hardest soonest', () => {
    const dues = ([1, 2, 3, 4] as ReviewRating[]).map((rating) =>
      dueAfter(acceptCard(storage, makeDraft(`card ${rating}`).id, NOW), rating),
    )

    expect(dues).toEqual([...dues].sort((a, b) => a - b))
    expect(new Set(dues).size).toBe(4)
    expect(dues[0]).toBeGreaterThan(NOW.getTime())
  })

  it('logs the pre-review state and what the scheduler decided', () => {
    const card = acceptCard(storage, makeDraft().id, NOW)

    const { card: graded, log } = reviewCard(storage, card.id, 3, NOW)

    expect(log.rating).toBe(3)
    expect(log.reviewedAt).toBe(NOW.toISOString())
    expect(log.undone).toBe(false)
    // Pre-review state, which is the only thing undo needs.
    expect(log.prevScheduling).toEqual(card.scheduling)
    // Interval is fractional days, so a same-day learning step is legible.
    const expected = (new Date(graded.scheduling!.dueAt).getTime() - NOW.getTime()) / 86_400_000
    expect(log.scheduledInterval).toBeCloseTo(expected, 3)
    expect(graded.scheduling!.lastReviewedAt).toBe(NOW.toISOString())
  })

  it('graduates a card through its learning steps across reloads', () => {
    // The regression test for migration 004: every read here comes back off
    // disk, so a card whose step index didn't persist would sit on the same
    // 10-minute step forever instead of reaching Review.
    const card = acceptCard(storage, makeDraft().id, NOW)

    let at = NOW
    let state = card.scheduling!.state
    for (let i = 0; i < 3 && state !== 2; i++) {
      const { card: graded } = reviewCard(storage, card.id, 3, at)
      state = storage.repos.flashcards.getById(graded.id)!.scheduling!.state
      at = new Date(graded.scheduling!.dueAt)
    }

    expect(state).toBe(2)
  })

  it('keeps every review in the log, append-only', () => {
    const card = acceptCard(storage, makeDraft().id, NOW)
    reviewCard(storage, card.id, 3, NOW)
    const later = new Date(NOW.getTime() + 3 * 86_400_000)
    reviewCard(storage, card.id, 1, later)

    expect(storage.repos.reviewLogs.listFor(card.id).map((l) => l.rating)).toEqual([3, 1])
  })
})

describe('undo', () => {
  it('restores the card to the state before the last grade', () => {
    const card = acceptCard(storage, makeDraft().id, NOW)
    const before = card.scheduling
    const { card: graded } = reviewCard(storage, card.id, 4, NOW)
    expect(graded.scheduling).not.toEqual(before)

    const restored = undoLastReview(storage, card.id)

    expect(restored.scheduling).toEqual(before)
    // Append-only: the row stays, flagged.
    const [log] = storage.repos.reviewLogs.listFor(card.id)
    expect(log.undone).toBe(true)
    expect(storage.repos.reviewLogs.latestFor(card.id)).toBeNull()
  })

  it('reaches back only to reviews that have not been undone', () => {
    const card = acceptCard(storage, makeDraft().id, NOW)
    reviewCard(storage, card.id, 3, NOW)
    undoLastReview(storage, card.id)

    expect(() => undoLastReview(storage, card.id)).toThrow(/no review to undo/)
  })

  it('steps back through consecutive reviews one at a time', () => {
    const card = acceptCard(storage, makeDraft().id, NOW)
    const { card: once } = reviewCard(storage, card.id, 3, NOW)
    const later = new Date(NOW.getTime() + 86_400_000)
    reviewCard(storage, card.id, 1, later)

    expect(undoLastReview(storage, card.id).scheduling).toEqual(once.scheduling)
    expect(undoLastReview(storage, card.id).scheduling).toEqual(card.scheduling)
  })
})

describe('lifecycle', () => {
  it('suspends an active card out of the due queue without losing its schedule', () => {
    const card = acceptCard(storage, makeDraft().id, NOW)
    reviewCard(storage, card.id, 3, NOW)
    const scheduled = storage.repos.flashcards.getById(card.id)!.scheduling

    const suspended = setCardLifecycle(storage, card.id, 'suspended')
    expect(suspended.scheduling).toEqual(scheduled)

    const farFuture = new Date(NOW.getTime() + 365 * 86_400_000).toISOString()
    expect(storage.repos.flashcards.listDue(fieldId, farFuture)).toHaveLength(0)

    // Unsuspending returns it to the queue where it left off, not as new.
    const resumed = setCardLifecycle(storage, card.id, 'active')
    expect(resumed.scheduling).toEqual(scheduled)
    expect(storage.repos.flashcards.listDue(fieldId, farFuture).map((c) => c.id)).toEqual([card.id])
  })

  it('discards drafts and refuses accepted cards', () => {
    const draft = makeDraft()
    const accepted = acceptCard(storage, makeDraft('another').id, NOW)

    discardCard(storage, draft.id)
    expect(storage.repos.flashcards.getById(draft.id)).toBeNull()

    expect(() => discardCard(storage, accepted.id)).toThrow(/Suspend that card/)
  })

  it('an edit shields the card from regeneration for good', () => {
    const draft = makeDraft()

    const edited = editCard(storage, draft.id, 'My own question', 'My own answer')

    expect(edited).toMatchObject({ front: 'My own question', userEdited: true })
    expect(storage.repos.flashcards.replaceContent(draft.id, 'regen', 'regen')).toBe(false)
    expect(storage.repos.flashcards.getById(draft.id)?.front).toBe('My own question')
  })
})
