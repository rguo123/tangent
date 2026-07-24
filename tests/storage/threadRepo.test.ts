import { describe, expect, it } from 'vitest'
import { seedThread, testDb } from './helpers'

describe('threadRepo.listByFieldWithDocument', () => {
  it('joins each thread with its document, newest thread first', () => {
    const { repos } = testDb()
    const { field, document, thread } = seedThread(repos)
    const doc2 = repos.documents.create({
      fieldId: field.id,
      title: 'Second Paper',
      sourceType: 'markdown',
      contentRef: '# two',
    })
    const thread2 = repos.threads.create({
      fieldId: field.id,
      documentId: doc2.id,
      title: 'Second Thread',
    })

    const items = repos.threads.listByFieldWithDocument(field.id)
    expect(items.map((i) => i.thread.id)).toEqual([thread2.id, thread.id])
    expect(items[0].document).toEqual(doc2)
    expect(items[1].document).toEqual(document)
  })

  it('includes archived threads and scopes to the field', () => {
    const { repos } = testDb()
    const { field, thread } = seedThread(repos)
    repos.threads.setStatus(thread.id, 'archived')
    seedThread(repos) // a second field with its own thread

    const items = repos.threads.listByFieldWithDocument(field.id)
    expect(items.map((i) => i.thread.id)).toEqual([thread.id])
    expect(items[0].thread.status).toBe('archived')
  })
})

describe('fieldRepo.getDefault', () => {
  it('returns the oldest field', () => {
    const { repos } = testDb()
    const first = repos.fields.create('First')
    repos.fields.create('Second')
    expect(repos.fields.getDefault()).toEqual(first)
  })

  it('throws when no field exists', () => {
    const { repos } = testDb()
    expect(() => repos.fields.getDefault()).toThrow(/No Field/)
  })
})
