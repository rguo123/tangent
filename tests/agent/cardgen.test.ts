import { beforeEach, describe, expect, it } from 'vitest'
import { planCards } from '../../src/main/agent/cardgen'
import { createMockProvider, type MockProvider } from '../../src/main/agent/provider'
import type { Storage } from '../../src/main/db/init'
import type { Concept } from '../../src/shared/entities'
import { seedThread, testStorage } from '../storage/helpers'

/**
 * What card generation sends the model, and what it keeps from the answer.
 * The trigger (only new concepts, after an extraction commit) lives in
 * extractionService.test.ts.
 */

let storage: Storage
let provider: MockProvider
let fieldId: string
let threadId: string
let documentId: string

function makeConcept(canonicalText: string): Concept {
  return storage.repos.concepts.create({ fieldId, canonicalText })
}

beforeEach(() => {
  storage = testStorage()
  const seeded = seedThread(storage.repos)
  fieldId = seeded.field.id
  threadId = seeded.thread.id
  documentId = seeded.document.id
  provider = createMockProvider()
})

describe('prompt', () => {
  it('sends each concept with the notes and passages it came from', async () => {
    const concept = makeConcept('quadratic attention cost')
    const entry = storage.repos.entries.create({
      threadId,
      kind: 'note',
      body: 'So doubling the context quadruples the compute.',
    })
    const anchor = storage.repos.anchors.create({
      threadId,
      documentId,
      selector: { type: 'text-quote', exact: 'attention is O(n^2)', prefix: '', suffix: '' },
    })
    storage.repos.concepts.addMention({
      conceptId: concept.id,
      entryId: entry.id,
      anchorId: anchor.id,
    })
    provider.queueStructured({
      cards: [{ conceptRef: 'c1', front: 'How does attention scale?', back: 'Quadratically.' }],
    })

    const drafts = await planCards(storage, provider, [concept.id])

    const [call] = provider.structuredCalls
    expect(call.schemaName).toBe('flashcard_drafts')
    expect(call.prompt).toContain('quadratic attention cost')
    // Both halves of one act of engagement: the passage and the sentence about it.
    expect(call.prompt).toContain('> attention is O(n^2)')
    expect(call.prompt).toContain('doubling the context quadruples the compute')
    expect(drafts).toEqual([
      { conceptId: concept.id, front: 'How does attention scale?', back: 'Quadratically.' },
    ])
  })

  it('writes from the concept alone when its sources are gone', async () => {
    const concept = makeConcept('quadratic attention cost')
    provider.queueStructured({
      cards: [{ conceptRef: 'c1', front: 'How does attention scale?', back: 'Quadratically.' }],
    })

    const drafts = await planCards(storage, provider, [concept.id])

    expect(provider.structuredCalls[0].prompt).toContain('no sources')
    expect(drafts).toHaveLength(1)
  })

  it('does not call the model when there is nothing to write cards for', async () => {
    expect(await planCards(storage, provider, [])).toEqual([])
    expect(provider.structuredCalls).toHaveLength(0)
  })
})

describe('resolving the answer', () => {
  it('drops a card whose concept ref was invented', async () => {
    const concept = makeConcept('quadratic attention cost')
    provider.queueStructured({
      cards: [
        { conceptRef: 'c1', front: 'Real', back: 'Real' },
        { conceptRef: 'c9', front: 'Invented', back: 'Invented' },
      ],
    })

    const drafts = await planCards(storage, provider, [concept.id])

    // A card with no concept falls out of merges and provenance both — better
    // never written than pinned to an arbitrary concept.
    expect(drafts.map((d) => d.front)).toEqual(['Real'])
  })

  it('keeps one card per concept and drops blank sides', async () => {
    const first = makeConcept('quadratic attention cost')
    const second = makeConcept('linear attention approximations')
    provider.queueStructured({
      cards: [
        { conceptRef: 'c1', front: 'First', back: 'First back' },
        { conceptRef: 'c1', front: 'Second try at the same concept', back: 'Also' },
        { conceptRef: 'c2', front: '  ', back: 'No question' },
      ],
    })

    const drafts = await planCards(storage, provider, [first.id, second.id])

    expect(drafts).toEqual([{ conceptId: first.id, front: 'First', back: 'First back' }])
    expect(second.id).not.toBe(drafts[0].conceptId)
  })
})

describe('offline', () => {
  it('falls back to a grounded stand-in card when there is no model', async () => {
    const offline = createMockProvider({ offlineFallbacks: true })
    const concept = makeConcept('quadratic attention cost')
    const entry = storage.repos.entries.create({
      threadId,
      kind: 'note',
      body: 'Doubling the context quadruples the compute.',
    })
    storage.repos.concepts.addMention({ conceptId: concept.id, entryId: entry.id })

    const drafts = await planCards(storage, offline, [concept.id])

    expect(drafts).toHaveLength(1)
    expect(drafts[0].conceptId).toBe(concept.id)
    expect(drafts[0].front).toContain('quadratic attention cost')
    expect(drafts[0].back).toContain('Doubling the context')
  })
})
