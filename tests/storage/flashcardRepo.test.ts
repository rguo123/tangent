import { describe, expect, it } from 'vitest'
import type { FsrsScheduling } from '../../src/shared/entities'
import { seedCard, testDb } from './helpers'

const SCHEDULING: FsrsScheduling = {
  stability: 1.2,
  difficulty: 5.0,
  dueAt: '2026-01-02T00:00:00.000Z',
  lastReviewedAt: null,
  state: 0,
  learningSteps: 1,
}

describe('flashcardRepo', () => {
  it('cards are born draft with no scheduling', () => {
    const { repos } = testDb()
    const { card, concept } = seedCard(repos)
    expect(card.lifecycle).toBe('draft')
    expect(card.scheduling).toBeNull()
    expect(card.userEdited).toBe(false)
    expect(repos.flashcards.getById(card.id)?.conceptIds).toEqual([concept.id])
  })

  it('user edits set user_edited; machine rewrites do not', () => {
    const { repos } = testDb()
    const { card } = seedCard(repos)

    expect(repos.flashcards.replaceContent(card.id, 'regen front', 'regen back')).toBe(true)
    let current = repos.flashcards.getById(card.id)
    expect(current?.front).toBe('regen front')
    expect(current?.userEdited).toBe(false)

    repos.flashcards.updateContent(card.id, 'my front', 'my back')
    current = repos.flashcards.getById(card.id)
    expect(current?.userEdited).toBe(true)

    // Regeneration is refused outright once the user has edited the card
    // (spec §2) — enforced here rather than trusted to the caller.
    expect(repos.flashcards.replaceContent(card.id, 'regen again', 'regen again')).toBe(false)
    current = repos.flashcards.getById(card.id)
    expect(current?.front).toBe('my front')
    expect(current?.userEdited).toBe(true)
  })

  it('lists the cards citing a concept, which is what a merge re-points', () => {
    const { repos } = testDb()
    const { field, concept, card } = seedCard(repos)
    const survivor = repos.concepts.create({ fieldId: field.id, canonicalText: 'survivor' })

    expect(repos.flashcards.listByConcept(concept.id).map((c) => c.id)).toEqual([card.id])

    // Merging moves the link without touching card content (spec §2).
    repos.concepts.merge(concept.id, survivor.id)

    expect(repos.flashcards.listByConcept(concept.id)).toEqual([])
    expect(repos.flashcards.listByConcept(survivor.id).map((c) => c.id)).toEqual([card.id])
    const merged = repos.flashcards.getById(card.id)
    expect(merged?.front).toBe('f')
    expect(merged?.conceptIds).toEqual([survivor.id])
  })

  it('lifecycle transitions and scheduling round-trip, including clearing', () => {
    const { repos } = testDb()
    const { card } = seedCard(repos)
    repos.flashcards.setLifecycle(card.id, 'active')
    repos.flashcards.updateScheduling(card.id, SCHEDULING)

    const active = repos.flashcards.getById(card.id)
    expect(active?.lifecycle).toBe('active')
    expect(active?.scheduling).toEqual(SCHEDULING)

    // undoing a first-ever review restores the never-scheduled state
    repos.flashcards.updateScheduling(card.id, null)
    expect(repos.flashcards.getById(card.id)?.scheduling).toBeNull()

    repos.flashcards.setLifecycle(card.id, 'suspended')
    expect(repos.flashcards.getById(card.id)?.lifecycle).toBe('suspended')
  })

  it('due queue returns only active cards due by now, in due order', () => {
    const { repos } = testDb()
    const { field, concept, card: draft } = seedCard(repos)
    const make = (front: string) =>
      repos.flashcards.create({
        fieldId: field.id,
        conceptIds: [concept.id],
        front,
        back: 'b',
        cardType: 'recall',
      })
    const dueLater = make('due later')
    const dueNow = make('due now')
    const suspended = make('suspended')

    for (const [card, dueAt] of [
      [dueLater, '2026-02-01T00:00:00.000Z'],
      [dueNow, '2026-01-01T00:00:00.000Z'],
      [suspended, '2026-01-01T00:00:00.000Z'],
    ] as const) {
      repos.flashcards.setLifecycle(card.id, 'active')
      repos.flashcards.updateScheduling(card.id, { ...SCHEDULING, dueAt })
    }
    repos.flashcards.setLifecycle(suspended.id, 'suspended')

    const due = repos.flashcards.listDue(field.id, '2026-01-15T00:00:00.000Z')
    expect(due.map((c) => c.id)).toEqual([dueNow.id])
    expect(due.map((c) => c.id)).not.toContain(draft.id)
    expect(due[0].conceptIds).toEqual([concept.id])

    const dueLaterToo = repos.flashcards.listDue(field.id, '2026-03-01T00:00:00.000Z')
    expect(dueLaterToo.map((c) => c.id)).toEqual([dueNow.id, dueLater.id])
  })

  it('filters by lifecycle', () => {
    const { repos } = testDb()
    const { field, card, concept } = seedCard(repos)
    const drafts = repos.flashcards.listByField(field.id, 'draft')
    expect(drafts.map((c) => c.id)).toEqual([card.id])
    expect(drafts[0].conceptIds).toEqual([concept.id])
    expect(repos.flashcards.listByField(field.id, 'active')).toEqual([])
  })

  it('remove deletes the card and its concept links', () => {
    const { db, repos } = testDb()
    const { field, card } = seedCard(repos)
    repos.flashcards.remove(card.id)
    expect(repos.flashcards.getById(card.id)).toBeNull()
    expect(repos.flashcards.listByField(field.id)).toEqual([])
    const links = db.prepare('SELECT COUNT(*) AS n FROM flashcard_concept').get() as { n: number }
    expect(links.n).toBe(0)
  })
})
