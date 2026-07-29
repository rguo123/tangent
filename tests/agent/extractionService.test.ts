import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcEventChannel, IpcEventPayload } from '@shared/ipc'
import {
  createExtractionService,
  type ExtractionService,
} from '../../src/main/agent/extractionService'
import { createMockProvider, type MockProvider } from '../../src/main/agent/provider'
import type { Storage } from '../../src/main/db/init'
import type { Repos } from '../../src/main/db/repos'
import type { RendererEmit } from '../../src/main/ipc/emit'
import { acceptCard } from '../../src/main/review'
import { seedThread, testStorage } from '../storage/helpers'
import { callsTo, queueCards, queueConcepts } from './helpers'

/**
 * When extraction fires, and what the renderer hears about it. The pipeline
 * itself is covered in extraction.test.ts — these are the triggers.
 */

const IDLE_MS = 1_000

interface Emitted {
  channel: IpcEventChannel
  payload: unknown
}

let repos: Repos
let storage: Storage
let provider: MockProvider
let service: ExtractionService
let emitted: Emitted[]
let threadId: string
let otherThreadId: string

/** Events on one channel. A run can report on more than one — a commit that
 *  also drafted cards says so on `cards:changed` — so a test asserting about
 *  extraction names the channel it means. */
function on(channel: IpcEventChannel): unknown[] {
  return emitted.filter((e) => e.channel === channel).map((e) => e.payload)
}

/**
 * The trigger paths are fire-and-forget, so a test has to let the run they
 * started finish. `vi.waitFor` polls until the assertion holds rather than
 * guessing how many microtasks the pipeline is deep — adding an `await`
 * upstream must not break these.
 */
function expectEmitted(count: number): Promise<void> {
  return vi.waitFor(() => expect(on('extraction:committed')).toHaveLength(count))
}

/** For asserting nothing happened: there's no state to wait for, so one turn
 *  is as meaningful as a hundred. */
async function tick(): Promise<void> {
  await Promise.resolve()
}

/** A full run's worth of model responses: the extraction call, then the cardgen
 *  call its new concept triggers. */
function queueOneConcept(text = 'attention is quadratic in sequence length'): void {
  queueConcepts(provider, text)
  queueCards(provider, `What does ${text} cost?`)
}

beforeEach(() => {
  vi.useFakeTimers()
  storage = testStorage()
  repos = storage.repos
  const seeded = seedThread(repos)
  threadId = seeded.thread.id
  otherThreadId = repos.threads.create({
    fieldId: seeded.field.id,
    documentId: seeded.document.id,
    title: 'Other',
  }).id
  provider = createMockProvider()
  emitted = []
  const emit: RendererEmit = <C extends IpcEventChannel>(
    channel: C,
    payload: IpcEventPayload<C>,
  ) => {
    emitted.push({ channel, payload })
  }
  service = createExtractionService(storage, provider, emit, { idleMs: IDLE_MS })
})

afterEach(() => {
  service.dispose()
  vi.useRealTimers()
})

describe('triggers', () => {
  it('extracts after the thread goes idle, not while it is being written in', async () => {
    repos.entries.create({ threadId, kind: 'note', body: 'Attention is quadratic.' })
    queueOneConcept()

    service.touch(threadId)
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(repos.concepts.listActiveByField(repos.fields.getDefault().id)).toHaveLength(0)

    // Each new entry pushes the window out — extraction is never per-keystroke,
    // and never mid-thought either.
    service.touch(threadId)
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(emitted).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    await expectEmitted(1)

    expect(on('extraction:committed')[0]).toMatchObject({ threadId, conceptsAdded: 1 })
    expect(on('extraction:failed')).toHaveLength(0)
  })

  it('extracts the thread you just left, and leaves the one you arrived in alone', async () => {
    repos.entries.create({ threadId, kind: 'note', body: 'Attention is quadratic.' })
    repos.entries.create({ threadId: otherThreadId, kind: 'note', body: 'Something else.' })
    queueOneConcept()

    service.setActiveThread(threadId)
    await tick()
    expect(emitted).toHaveLength(0)

    service.setActiveThread(otherThreadId)
    await expectEmitted(1)

    expect(on('extraction:committed')[0]).toMatchObject({ threadId })
  })

  it('stays quiet when there is nothing engaged to extract', async () => {
    service.setActiveThread(threadId)
    service.setActiveThread(null)
    await tick()

    // No model call, no event: the common case for a trigger is one query.
    expect(provider.structuredCalls).toHaveLength(0)
    expect(emitted).toHaveLength(0)
  })

  it('reports a failed background run instead of swallowing it', async () => {
    repos.entries.create({ threadId, kind: 'note', body: 'Attention is quadratic.' })
    provider.failNext('Set VOYAGE_API_KEY to generate embeddings.')

    service.setActiveThread(threadId)
    service.setActiveThread(null)
    await vi.waitFor(() => expect(on('extraction:failed')).toHaveLength(1))

    expect(emitted).toEqual([
      {
        channel: 'extraction:failed',
        payload: { threadId, error: 'Set VOYAGE_API_KEY to generate embeddings.' },
      },
    ])
    // Nothing was written, so the note is still due next time.
    expect(
      repos.entries.getById(repos.entries.listByThread(threadId)[0].id)!.extractedAt,
    ).toBeNull()
  })

  it('shares one run between a switch and a manual click on the same thread', async () => {
    repos.entries.create({ threadId, kind: 'note', body: 'Attention is quadratic.' })
    queueOneConcept()

    service.setActiveThread(threadId)
    service.setActiveThread(null)
    const summary = await service.run(threadId)

    // A second run would find the queue empty and throw — one run happened.
    expect(summary.conceptsAdded).toBe(1)
    expect(callsTo(provider, 'extracted_concepts')).toBe(1)
  })

  it('does not fire a cancelled idle timer after a manual run', async () => {
    repos.entries.create({ threadId, kind: 'note', body: 'Attention is quadratic.' })
    queueOneConcept()

    service.touch(threadId)
    await service.run(threadId)
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2)
    await tick()

    expect(callsTo(provider, 'extracted_concepts')).toBe(1)
  })
})

describe('manual run', () => {
  it('reports the nothing-to-do case that background runs stay silent about', async () => {
    expect(await service.run(threadId)).toEqual({
      threadId,
      batchId: null,
      conceptsAdded: 0,
      mentionsAdded: 0,
      cardsAdded: 0,
    })
    expect(emitted).toHaveLength(0)
  })
})

describe('card generation', () => {
  function drafts() {
    return repos.flashcards.listByField(repos.fields.getDefault().id, 'draft')
  }

  it('drafts a card for each concept the run created', async () => {
    repos.entries.create({ threadId, kind: 'note', body: 'Attention is quadratic.' })
    queueConcepts(provider, 'attention is quadratic in sequence length')
    queueCards(provider, 'What is the cost of attention in sequence length?')

    const summary = await service.run(threadId)

    expect(summary.cardsAdded).toBe(1)
    // The cull queue reloads off this, not off the extraction event — undo
    // needs to say the same thing, and only main knows what went.
    expect(on('cards:changed')).toEqual([{ reason: 'generated' }])
    const [card] = drafts()
    expect(card.front).toBe('What is the cost of attention in sequence length?')
    expect(card.lifecycle).toBe('draft')
    expect(card.scheduling).toBeNull()
    // The card cites the concept it came from, which is what a later merge
    // re-points and what undo has to take into account.
    expect(card.conceptIds).toEqual([
      repos.concepts.listActiveByField(repos.fields.getDefault().id)[0].id,
    ])
  })

  it('never regenerates for a concept that already existed', async () => {
    const text = 'attention is quadratic in sequence length'
    repos.entries.create({ threadId, kind: 'note', body: 'Attention is quadratic.' })
    queueConcepts(provider, text)
    queueCards(provider, 'What is the cost of attention?')
    await service.run(threadId)

    // Same idea, said again in a second note: it dedupes onto the existing
    // concept, so there is nothing new to write a card for (spec §2).
    repos.entries.create({ threadId, kind: 'note', body: 'Attention is quadratic, again.' })
    queueConcepts(provider, text)

    const summary = await service.run(threadId)

    expect(summary).toMatchObject({ conceptsAdded: 0, mentionsAdded: 1, cardsAdded: 0 })
    expect(callsTo(provider, 'flashcard_drafts')).toBe(1)
    expect(drafts()).toHaveLength(1)
  })

  it('keeps the extraction when card generation fails', async () => {
    repos.entries.create({ threadId, kind: 'note', body: 'Attention is quadratic.' })
    // Concepts queued, cards not — the second model call has nothing to return.
    queueConcepts(provider, 'attention is quadratic in sequence length')

    const summary = await service.run(threadId)

    expect(summary).toMatchObject({ conceptsAdded: 1, cardsAdded: 0 })
    expect(repos.concepts.listActiveByField(repos.fields.getDefault().id)).toHaveLength(1)
    expect(drafts()).toHaveLength(0)
    // The concepts were committed, so the note stays extracted.
    expect(repos.entries.listByThread(threadId)[0].extractedAt).not.toBeNull()
  })
})

describe('undo', () => {
  it('reverses the batch the chip is offering', async () => {
    const entry = repos.entries.create({ threadId, kind: 'note', body: 'Attention is quadratic.' })
    queueOneConcept()

    const summary = await service.run(threadId)
    expect(summary.batchId).not.toBeNull()
    expect(repos.concepts.listActiveByField(repos.fields.getDefault().id)).toHaveLength(1)
    expect(summary.cardsAdded).toBe(1)

    service.undo(summary.batchId!)

    expect(repos.concepts.listActiveByField(repos.fields.getDefault().id)).toHaveLength(0)
    expect(repos.entries.getById(entry.id)!.extractedAt).toBeNull()
    // The drafts go with the concepts — a card cannot outlive the concept it
    // cites, so undo takes both or neither.
    expect(repos.flashcards.listByField(repos.fields.getDefault().id)).toHaveLength(0)
    expect(on('cards:changed')).toEqual([{ reason: 'generated' }, { reason: 'undone' }])
  })

  it('refuses once a card from the batch has been accepted', async () => {
    repos.entries.create({ threadId, kind: 'note', body: 'Attention is quadratic.' })
    queueOneConcept()
    const summary = await service.run(threadId)
    const [card] = repos.flashcards.listByField(repos.fields.getDefault().id, 'draft')

    acceptCard(storage, card.id)

    expect(() => service.undo(summary.batchId!)).toThrow(/already in review/)
    // Refused whole: the concept and its card are both still there.
    expect(repos.concepts.listActiveByField(repos.fields.getDefault().id)).toHaveLength(1)
    expect(repos.flashcards.getById(card.id)?.lifecycle).toBe('active')
  })

  it('refuses a batch it no longer holds, rather than half-undoing one', async () => {
    repos.entries.create({ threadId, kind: 'note', body: 'Attention is quadratic.' })
    queueOneConcept()
    const summary = await service.run(threadId)

    service.undo(summary.batchId!)

    expect(() => service.undo(summary.batchId!)).toThrow(/no longer be undone/)
  })
})
