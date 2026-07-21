import { describe, expect, it } from 'vitest'
import { seedThread, testDb } from './helpers'

// Extraction/edit timestamps must postdate entry creation (which stamps real
// time), so these live safely in the future.
const T0 = '2099-01-01T00:00:00.000Z'
const T1 = '2099-01-01T00:01:00.000Z'
const T2 = '2099-01-01T00:02:00.000Z'

describe('entryRepo', () => {
  it('creates and lists entries chronologically with anchors and parents', () => {
    const { repos } = testDb()
    const { thread, document } = seedThread(repos)
    const anchor = repos.anchors.create({
      threadId: thread.id,
      documentId: document.id,
      selector: { type: 'text-quote', exact: 'the quote', prefix: 'before ', suffix: ' after' },
    })

    const note = repos.entries.create({
      threadId: thread.id,
      kind: 'note',
      body: 'a note',
      anchorId: anchor.id,
    })
    const question = repos.entries.create({ threadId: thread.id, kind: 'question', body: 'why?' })
    const reply = repos.entries.create({
      threadId: thread.id,
      kind: 'ai_response',
      body: 'because',
      parentEntryId: question.id,
    })

    const list = repos.entries.listByThread(thread.id)
    expect(list.map((e) => e.id)).toEqual([note.id, question.id, reply.id])
    expect(list[0].anchorId).toBe(anchor.id)
    expect(list[2].parentEntryId).toBe(question.id)

    const roundTripped = repos.anchors.getById(anchor.id)
    expect(roundTripped?.selector).toEqual(anchor.selector)
  })

  it('toggles pinned', () => {
    const { repos } = testDb()
    const { thread } = seedThread(repos)
    const e = repos.entries.create({ threadId: thread.id, kind: 'ai_response', body: 'r' })
    expect(e.pinned).toBe(false)
    repos.entries.setPinned(e.id, true)
    expect(repos.entries.getById(e.id)?.pinned).toBe(true)
  })

  it('watermark: new entries are due, extracted ones are not, edited ones are due again', () => {
    const { repos } = testDb()
    const { thread } = seedThread(repos)
    const a = repos.entries.create({ threadId: thread.id, kind: 'note', body: 'a' })
    const b = repos.entries.create({ threadId: thread.id, kind: 'note', body: 'b' })

    // both never-extracted → due
    expect(repos.entries.dueForExtraction(thread.id).map((e) => e.id)).toEqual([a.id, b.id])

    // extract both → none due
    repos.entries.markExtracted([a.id, b.id], T0)
    expect(repos.entries.dueForExtraction(thread.id)).toEqual([])

    // edit one after extraction → only that one is due again
    repos.entries.updateBody(a.id, 'a edited', T1)
    expect(repos.entries.dueForExtraction(thread.id).map((e) => e.id)).toEqual([a.id])

    // re-extract at a later watermark → clean again
    repos.entries.markExtracted([a.id], T2)
    expect(repos.entries.dueForExtraction(thread.id)).toEqual([])
  })

  it('watermark is scoped per thread', () => {
    const { repos } = testDb()
    const { field, document, thread } = seedThread(repos)
    const other = repos.threads.create({
      fieldId: field.id,
      documentId: document.id,
      title: 'Other',
    })
    repos.entries.create({ threadId: thread.id, kind: 'note', body: 'mine' })
    const theirs = repos.entries.create({ threadId: other.id, kind: 'note', body: 'theirs' })

    expect(repos.entries.dueForExtraction(other.id).map((e) => e.id)).toEqual([theirs.id])
  })
})
