import { describe, expect, it } from 'vitest'
import { seedThread, testDb } from './helpers'

describe('conceptRepo', () => {
  it('round-trips embeddings through the BLOB column', () => {
    const { repos } = testDb()
    const { field } = seedThread(repos)
    const embedding = new Float32Array([0.25, -1.5, 3.125, 0])
    const c = repos.concepts.create({
      fieldId: field.id,
      canonicalText: 'CAP theorem',
      embedding,
      embeddingModel: 'voyage-3.5',
    })

    const loaded = repos.concepts.getById(c.id)
    expect(loaded?.embedding).toEqual(embedding)
    expect(loaded?.embeddingModel).toBe('voyage-3.5')
  })

  it('mentions require an entry or an anchor (CHECK)', () => {
    const { db, repos } = testDb()
    const { field, thread, document } = seedThread(repos)
    const c = repos.concepts.create({ fieldId: field.id, canonicalText: 'x' })

    expect(() =>
      db
        .prepare(
          `INSERT INTO concept_mention (id, concept_id, entry_id, anchor_id, created_at)
           VALUES ('m1', ?, NULL, NULL, '2026-01-01T00:00:00.000Z')`,
        )
        .run(c.id),
    ).toThrow(/CHECK/)

    const entry = repos.entries.create({ threadId: thread.id, kind: 'note', body: 'n' })
    const anchor = repos.anchors.create({
      threadId: thread.id,
      documentId: document.id,
      selector: { type: 'text-quote', exact: 'q', prefix: '', suffix: '' },
    })
    repos.concepts.addMention({ conceptId: c.id, entryId: entry.id })
    repos.concepts.addMention({ conceptId: c.id, anchorId: anchor.id })

    const mentions = repos.concepts.mentionsFor(c.id)
    expect(mentions).toHaveLength(2)
    expect(mentions.map((m) => [m.entryId, m.anchorId])).toEqual([
      [entry.id, null],
      [null, anchor.id],
    ])
  })

  it('merged status and merged_into_id are set together (CHECK)', () => {
    const { db, repos } = testDb()
    const { field } = seedThread(repos)
    const c = repos.concepts.create({ fieldId: field.id, canonicalText: 'x' })

    expect(() => db.prepare(`UPDATE concept SET status = 'merged' WHERE id = ?`).run(c.id)).toThrow(
      /CHECK/,
    )
    expect(() =>
      db.prepare(`UPDATE concept SET merged_into_id = ? WHERE id = ?`).run(c.id, c.id),
    ).toThrow(/CHECK/)
  })

  it('merge re-points flashcards to the survivor without touching card content', () => {
    const { repos } = testDb()
    const { field } = seedThread(repos)
    const loser = repos.concepts.create({ fieldId: field.id, canonicalText: 'CAP thm' })
    const survivor = repos.concepts.create({ fieldId: field.id, canonicalText: 'CAP theorem' })

    // one card only on the loser; one already on both (the PK-conflict case)
    const cardA = repos.flashcards.create({
      fieldId: field.id,
      conceptIds: [loser.id],
      front: 'What does CAP stand for?',
      back: 'Consistency, Availability, Partition tolerance',
      cardType: 'recall',
    })
    const cardB = repos.flashcards.create({
      fieldId: field.id,
      conceptIds: [loser.id, survivor.id],
      front: 'relationship card',
      back: 'b',
      cardType: 'relationship',
    })

    repos.concepts.merge(loser.id, survivor.id)

    const merged = repos.concepts.getById(loser.id)
    expect(merged?.status).toBe('merged')
    expect(merged?.mergedIntoId).toBe(survivor.id)
    // active listing excludes merged concepts
    expect(repos.concepts.listActiveByField(field.id).map((c) => c.id)).toEqual([survivor.id])

    const a = repos.flashcards.getById(cardA.id)
    expect(a?.conceptIds).toEqual([survivor.id])
    expect(a?.front).toBe('What does CAP stand for?')
    expect(repos.flashcards.getById(cardB.id)?.conceptIds).toEqual([survivor.id])
  })
})
