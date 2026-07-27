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
import { seedThread, testStorage } from '../storage/helpers'
import { queueConcepts } from './helpers'

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

/**
 * The trigger paths are fire-and-forget, so a test has to let the run they
 * started finish. `vi.waitFor` polls until the assertion holds rather than
 * guessing how many microtasks the pipeline is deep — adding an `await`
 * upstream must not break these.
 */
function expectEmitted(count: number): Promise<void> {
  return vi.waitFor(() => expect(emitted).toHaveLength(count))
}

/** For asserting nothing happened: there's no state to wait for, so one turn
 *  is as meaningful as a hundred. */
async function tick(): Promise<void> {
  await Promise.resolve()
}

function queueOneConcept(text = 'attention is quadratic in sequence length'): void {
  queueConcepts(provider, text)
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

    expect(emitted.map((e) => e.channel)).toEqual(['extraction:committed'])
    expect(emitted[0].payload).toMatchObject({ threadId, conceptsAdded: 1 })
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

    expect(emitted[0].payload).toMatchObject({ threadId })
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
    await expectEmitted(1)

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
    expect(provider.structuredCalls).toHaveLength(1)
  })

  it('does not fire a cancelled idle timer after a manual run', async () => {
    repos.entries.create({ threadId, kind: 'note', body: 'Attention is quadratic.' })
    queueOneConcept()

    service.touch(threadId)
    await service.run(threadId)
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2)
    await tick()

    expect(provider.structuredCalls).toHaveLength(1)
  })
})

describe('manual run', () => {
  it('reports the nothing-to-do case that background runs stay silent about', async () => {
    expect(await service.run(threadId)).toEqual({
      threadId,
      batchId: null,
      conceptsAdded: 0,
      mentionsAdded: 0,
    })
    expect(emitted).toHaveLength(0)
  })
})

describe('undo', () => {
  it('reverses the batch the chip is offering', async () => {
    const entry = repos.entries.create({ threadId, kind: 'note', body: 'Attention is quadratic.' })
    queueOneConcept()

    const summary = await service.run(threadId)
    expect(summary.batchId).not.toBeNull()
    expect(repos.concepts.listActiveByField(repos.fields.getDefault().id)).toHaveLength(1)

    service.undo(summary.batchId!)

    expect(repos.concepts.listActiveByField(repos.fields.getDefault().id)).toHaveLength(0)
    expect(repos.entries.getById(entry.id)!.extractedAt).toBeNull()
  })

  it('refuses a batch it no longer holds, rather than half-undoing one', async () => {
    repos.entries.create({ threadId, kind: 'note', body: 'Attention is quadratic.' })
    queueOneConcept()
    const summary = await service.run(threadId)

    service.undo(summary.batchId!)

    expect(() => service.undo(summary.batchId!)).toThrow(/no longer be undone/)
  })
})
