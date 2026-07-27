import { beforeEach, describe, expect, it } from 'vitest'
import type { Entry } from '@shared/entities'
import { collectInputs, planExtraction } from '../../src/main/agent/extraction'
import { createMockProvider, type MockProvider } from '../../src/main/agent/provider'
import {
  commitExtraction,
  undoExtraction,
  type ExtractionBatch,
} from '../../src/main/db/extraction'
import type { Repos } from '../../src/main/db/repos'
import { seedThread, testStorage } from '../storage/helpers'
import type { Storage } from '../../src/main/db/init'
import type { Database } from 'better-sqlite3'
import { queueConcepts } from './helpers'

/**
 * Extraction mechanics against MockProvider: what gets read, what dedups, what
 * an undo puts back. The *quality* of the concepts is a prompt-and-threshold
 * matter that only real data can settle — these lock the machinery so tuning
 * never has to touch it.
 */

let db: Database
let repos: Repos
let storage: Storage
let provider: MockProvider
let fieldId: string
let threadId: string
let documentId: string

beforeEach(() => {
  storage = testStorage()
  ;({ db, repos } = storage)
  const seeded = seedThread(repos)
  fieldId = seeded.field.id
  threadId = seeded.thread.id
  documentId = seeded.document.id
  provider = createMockProvider()
})

/** One proposal, concept N citing input N. */
function propose(...canonicalTexts: string[]): void {
  queueConcepts(provider, ...canonicalTexts)
}

function note(body: string, anchorId?: string): Entry {
  return repos.entries.create({ threadId, kind: 'note', body, anchorId })
}

function anchor(exact: string) {
  return repos.anchors.create({
    threadId,
    documentId,
    selector: { type: 'text-quote', exact, prefix: '', suffix: '' },
  })
}

/**
 * Edit an entry with a timestamp guaranteed to sit *after* its last extraction
 * and before now. The watermark compares ISO strings, and a test that writes
 * both stamps inside one millisecond would read as already-extracted — which is
 * why `updateBody` takes an injectable `at` in the first place.
 */
function edit(entryId: string, body: string): void {
  const entry = repos.entries.getById(entryId)!
  const at = new Date(Date.parse(entry.extractedAt ?? entry.updatedAt) + 1).toISOString()
  repos.entries.updateBody(entryId, body, at)
}

interface Extracted extends ExtractionBatch {
  conceptsAdded: number
  mentionsAdded: number
}

async function extract(): Promise<Extracted> {
  const plan = await planExtraction(storage, provider, threadId)
  if (!plan) throw new Error('expected a plan')
  const batch = commitExtraction(db, repos, plan)
  return {
    ...batch,
    conceptsAdded: batch.createdConceptIds.length,
    mentionsAdded: batch.createdMentionIds.length,
  }
}

describe('input assembly', () => {
  it('reads engagement, not everything the thread contains', () => {
    const kept = note('Attention lets a token look at every other token.')
    const question = repos.entries.create({
      threadId,
      kind: 'question',
      body: 'Why is that quadratic?',
    })
    const pinned = repos.entries.create({
      threadId,
      kind: 'ai_response',
      body: 'Because every pair is scored.',
      parentEntryId: question.id,
    })
    repos.entries.setPinned(pinned.id, true)
    // The model talking, unpinned, is not the user learning.
    repos.entries.create({
      threadId,
      kind: 'ai_response',
      body: 'A long unpinned digression.',
      parentEntryId: question.id,
    })

    const inputs = collectInputs(storage, threadId)

    expect(inputs.map((i) => i.source.entryId)).toEqual([kept.id, question.id, pinned.id])
    expect(inputs.map((i) => i.kind)).toEqual(['note', 'question', 'answer'])
  })

  it('honours the watermark: extracted entries drop out, edited ones come back', async () => {
    const first = note('Positional encoding injects order.')
    propose('positional encoding')
    await extract()

    expect(collectInputs(storage, threadId)).toHaveLength(0)

    const second = note('Residual connections keep gradients alive.')
    edit(first.id, 'Positional encoding injects order — sinusoidal or learned.')

    expect(collectInputs(storage, threadId).map((i) => i.source.entryId)).toEqual([
      first.id,
      second.id,
    ])
  })

  it('counts a highlight with no note, and pairs an anchored note with its passage', () => {
    const orphan = anchor('softmax over the whole sequence')
    const noted = anchor('layer normalisation is applied before the sublayer')
    const entry = note('So this is pre-LN, not post-LN.', noted.id)

    const inputs = collectInputs(storage, threadId)

    expect(inputs).toHaveLength(2)
    // The note and the passage it is about are one act of engagement, so the
    // mention will trace back to both.
    expect(inputs[0]).toMatchObject({
      kind: 'note',
      quote: 'layer normalisation is applied before the sublayer',
      source: { entryId: entry.id, anchorId: noted.id },
    })
    expect(inputs[1]).toMatchObject({
      kind: 'highlight',
      source: { entryId: null, anchorId: orphan.id },
    })
  })

  it('sends the quotes and the writing to the model, and nothing else', async () => {
    const a = anchor('scaled dot-product attention')
    note('Why the scaling by sqrt(d_k)?', a.id)
    propose('scaled dot-product')

    const plan = await planExtraction(storage, provider, threadId)

    expect(plan).not.toBeNull()
    const { prompt } = provider.structuredCalls[0]
    expect(prompt).toContain('scaled dot-product attention')
    expect(prompt).toContain('Why the scaling by sqrt(d_k)?')
    // The document itself never reaches the model here (spec §5.1: engagement,
    // not the source) — the seeded document body is '# hello'.
    expect(prompt).not.toContain('hello')
    // Embedding the canonical text is the only other call.
    expect(provider.embedCalls).toEqual([['scaled dot-product']])
  })
})

describe('nothing to do', () => {
  it('does not call the model when no entry is due', async () => {
    expect(await planExtraction(storage, provider, threadId)).toBeNull()
    expect(provider.embedCalls).toHaveLength(0)
  })

  it('drops concepts the model could not trace back to an input', async () => {
    note('Attention is all you need.')
    // A ref that was never sent — the model citing a source that doesn't exist.
    provider.queueStructured({ concepts: [{ canonicalText: 'invented', sourceRefs: ['i9'] }] })

    expect(await planExtraction(storage, provider, threadId)).toBeNull()
  })
})

describe('dedup', () => {
  it('gives a near-duplicate a new mention rather than a second concept', async () => {
    note('Self-attention scales quadratically with sequence length.')
    propose('self-attention scales quadratically with sequence length')
    const first = await extract()
    expect(first.conceptsAdded).toBe(1)

    const second = note('Again: attention cost is quadratic in the sequence length.')
    propose('self-attention scales quadratically with sequence length')
    const again = await extract()

    expect(again.conceptsAdded).toBe(0)
    expect(again.mentionsAdded).toBe(1)
    const concepts = repos.concepts.listActiveByField(fieldId)
    expect(concepts).toHaveLength(1)
    expect(repos.concepts.mentionsFor(concepts[0].id).map((m) => m.entryId)).toContain(second.id)
  })

  it('keeps an unrelated concept separate', async () => {
    note('a')
    note('b')
    propose(
      'positional encoding injects sequence order',
      'residual connections preserve gradient flow',
    )

    const result = await extract()

    expect(result.conceptsAdded).toBe(2)
  })

  it('folds two restatements in the same run into one concept with both sources', async () => {
    const a = note('a')
    const b = note('b')
    propose(
      'attention is quadratic in sequence length',
      'attention is quadratic in sequence length',
    )

    const result = await extract()

    expect(result.conceptsAdded).toBe(1)
    const concept = repos.concepts.listActiveByField(fieldId)[0]
    expect(
      repos.concepts
        .mentionsFor(concept.id)
        .map((m) => m.entryId)
        .sort(),
    ).toEqual([a.id, b.id].sort())
  })

  it('does not stack an identical mention when the same entry is re-extracted', async () => {
    const entry = note('Attention is quadratic.')
    propose('attention is quadratic in sequence length')
    await extract()

    edit(entry.id, 'Attention is quadratic — that is the whole cost story.')
    propose('attention is quadratic in sequence length')
    const again = await extract()

    expect(again.conceptsAdded).toBe(0)
    expect(again.mentionsAdded).toBe(0)
    const concept = repos.concepts.listActiveByField(fieldId)[0]
    expect(repos.concepts.mentionsFor(concept.id)).toHaveLength(1)
  })

  it('treats concepts embedded by a different model as incomparable', async () => {
    repos.concepts.create({
      fieldId,
      canonicalText: 'attention is quadratic in sequence length',
      embedding: new Float32Array([1, 0, 0]),
      embeddingModel: 'some-other-model',
    })
    note('Attention is quadratic.')
    propose('attention is quadratic in sequence length')

    const result = await extract()

    // A stale vector can't be compared, so the concept is written fresh rather
    // than matched against a number that means something else.
    expect(result.conceptsAdded).toBe(1)
  })
})

describe('commit and undo', () => {
  it('stamps only the entries it consumed', async () => {
    const consumed = note('Attention is quadratic.')
    const question = repos.entries.create({ threadId, kind: 'question', body: 'why?' })
    const unpinned = repos.entries.create({
      threadId,
      kind: 'ai_response',
      body: 'because pairs',
      parentEntryId: question.id,
    })
    propose('quadratic attention cost')

    await extract()

    expect(repos.entries.getById(consumed.id)!.extractedAt).not.toBeNull()
    expect(repos.entries.getById(question.id)!.extractedAt).not.toBeNull()
    // Left due on purpose: pinning doesn't bump updated_at, so an unpinned
    // answer that gets pinned later would never come back if it were stamped.
    expect(repos.entries.getById(unpinned.id)!.extractedAt).toBeNull()
  })

  it('records mentions against the passage as well as the note', async () => {
    const a = anchor('scaled dot-product attention')
    const entry = note('Why divide by sqrt(d_k)?', a.id)
    propose('scaling stabilises attention gradients')

    await extract()

    const concept = repos.concepts.listActiveByField(fieldId)[0]
    expect(repos.concepts.mentionsFor(concept.id)).toEqual([
      expect.objectContaining({ entryId: entry.id, anchorId: a.id }),
    ])
  })

  it('undo restores exactly the prior state', async () => {
    const first = note('Attention is quadratic.')
    propose('quadratic attention cost')
    const plan = await planExtraction(storage, provider, threadId)
    const committed = commitExtraction(db, repos, plan!)
    const survivingConcept = repos.concepts.listActiveByField(fieldId)[0]

    // A second run, on a new note, resolving onto the same concept.
    const second = note('Still quadratic, still the bottleneck.')
    propose('quadratic attention cost')
    const secondPlan = await planExtraction(storage, provider, threadId)
    const secondCommit = commitExtraction(db, repos, secondPlan!)
    expect(secondCommit.createdMentionIds).toHaveLength(1)

    undoExtraction(db, repos, secondCommit)

    // The mention it added is gone, the concept it did not create survives.
    expect(repos.concepts.listActiveByField(fieldId).map((c) => c.id)).toEqual([
      survivingConcept.id,
    ])
    expect(repos.concepts.mentionsFor(survivingConcept.id).map((m) => m.entryId)).toEqual([
      first.id,
    ])
    // And the undone entry is due again — undo means "you read that wrong".
    expect(repos.entries.getById(second.id)!.extractedAt).toBeNull()
    expect(collectInputs(storage, threadId).map((i) => i.source.entryId)).toEqual([second.id])

    undoExtraction(db, repos, committed)
    expect(repos.concepts.listActiveByField(fieldId)).toHaveLength(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM concept_mention').get()).toEqual({ n: 0 })
    expect(repos.entries.getById(first.id)!.extractedAt).toBeNull()
  })

  it('undo puts back a re-extraction watermark rather than clearing it', async () => {
    const entry = note('Attention is quadratic.')
    propose('quadratic attention cost')
    await extract()
    const firstStamp = repos.entries.getById(entry.id)!.extractedAt

    edit(entry.id, 'Attention is quadratic — the bottleneck.')
    propose('a genuinely different idea about tokenisation')
    const plan = await planExtraction(storage, provider, threadId)
    const second = commitExtraction(db, repos, plan!)

    undoExtraction(db, repos, second)

    expect(repos.entries.getById(entry.id)!.extractedAt).toBe(firstStamp)
    expect(repos.concepts.listActiveByField(fieldId)).toHaveLength(1)
  })

  it('stamps a highlight it read, even when nothing came of it', async () => {
    const highlight = anchor('softmax over the whole sequence')
    // The model declines to propose anything from it.
    provider.queueStructured({ concepts: [] })
    const plan = await planExtraction(storage, provider, threadId)
    expect(plan).toBeNull()
    // Still due: a run that never reached a commit stamps nothing.
    expect(collectInputs(storage, threadId)).toHaveLength(1)

    propose('softmax normalises attention weights')
    const batch = await extract()

    expect(repos.anchors.getById(highlight.id)!.extractedAt).not.toBeNull()
    expect(collectInputs(storage, threadId)).toHaveLength(0)

    // And undo makes the highlight due again, exactly like an entry.
    undoExtraction(db, repos, batch)
    expect(repos.anchors.getById(highlight.id)!.extractedAt).toBeNull()
    expect(collectInputs(storage, threadId).map((i) => i.source.anchorId)).toEqual([highlight.id])
  })
})
