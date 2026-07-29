import { writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Storage } from '../../src/main/db/init'
import { buildAskContext } from '../../src/main/agent/context'
import { importDocument } from '../../src/main/documents/import'
import { clearDocumentTextCache } from '../../src/main/documents/text'
import { seedMarkdownDocument, tempStorage } from '../storage/helpers'
import { minimalPdf } from './helpers'

let storage: Storage
let dataDir: string
let cleanup: () => void

beforeEach(() => {
  ;({ storage, dataDir, cleanup } = tempStorage())
  clearDocumentTextCache()
})

afterEach(() => {
  cleanup()
})

const seed = (body: string) => seedMarkdownDocument(storage, dataDir, body)

/** The entry constructors the cases below are actually about, minus the
 *  threadId/kind ceremony that would otherwise bury the difference between
 *  one test and the next. */
const question = (threadId: string, body: string, anchorId?: string) =>
  storage.repos.entries.create({ threadId, kind: 'question', body, anchorId })

const answer = (threadId: string, body: string, parentEntryId?: string) =>
  storage.repos.entries.create({ threadId, kind: 'ai_response', body, parentEntryId })

const note = (threadId: string, body: string, anchorId?: string) =>
  storage.repos.entries.create({ threadId, kind: 'note', body, anchorId })

const anchorOn = (thread: { id: string }, documentId: string, exact: string, pageNumber?: number) =>
  storage.repos.anchors.create({
    threadId: thread.id,
    documentId,
    selector: { type: 'text-quote', exact, prefix: '', suffix: '', pageNumber },
  })

describe('buildAskContext', () => {
  it('puts the document text in the system prompt and the question last', async () => {
    const { thread } = seed('# Attention\n\nSection 3 argues that attention scales.')

    const context = await buildAskContext(
      storage,
      question(thread.id, 'What does section 3 argue?'),
    )

    expect(context.system).toContain('Section 3 argues that attention scales.')
    expect(context.system).toContain('# Document: paper')
    expect(context.messages).toEqual([{ role: 'user', content: 'What does section 3 argue?' }])
  })

  it('carries the anchored quote into the question turn', async () => {
    const { document, thread } = seed('body text')
    const anchor = anchorOn(thread, document.id, 'attention scales', 4)

    const context = await buildAskContext(storage, question(thread.id, 'Why?', anchor.id))

    const last = context.messages.at(-1)!
    expect(last.content).toContain('> attention scales')
    expect(last.content).toContain('page 4')
    expect(last.content).toContain('Why?')
  })

  it('replays the thread as conversation, with AI responses as assistant turns', async () => {
    const { thread } = seed('body')
    answer(thread.id, 'A1', question(thread.id, 'Q1').id)

    const context = await buildAskContext(storage, question(thread.id, 'Q2'))

    expect(context.messages).toEqual([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
    ])
  })

  it('keeps notes out of the conversation and puts them in the question turn', async () => {
    const { thread } = seed('body')
    note(thread.id, 'attention is quadratic')

    const context = await buildAskContext(storage, question(thread.id, 'Q'))

    // One turn, not two: the note never becomes a message of its own.
    expect(context.messages).toHaveLength(1)
    const [turn] = context.messages
    expect(turn.role).toBe('user')
    expect(turn.content).toContain('Notes I have written for myself')
    expect(turn.content).toContain('- attention is quadratic')
    // The question still lands last, after the notes block.
    expect(turn.content.indexOf('attention is quadratic')).toBeLessThan(turn.content.indexOf('Q'))
  })

  it('carries the passage into an anchored note', async () => {
    const { document, thread } = seed('body text')
    note(thread.id, 'only for fixed d_k', anchorOn(thread, document.id, 'attention scales').id)

    const context = await buildAskContext(storage, question(thread.id, 'Q'))

    expect(context.messages.at(-1)!.content).toContain('On “attention scales”: only for fixed d_k')
  })

  it('omits the notes block entirely when there are no notes', async () => {
    const { thread } = seed('body')

    const context = await buildAskContext(storage, question(thread.id, 'Q'))

    expect(context.messages).toEqual([{ role: 'user', content: 'Q' }])
  })

  it('carries the anchored quote into replayed history questions', async () => {
    const { document, thread } = seed('body text')
    const anchor = anchorOn(thread, document.id, 'attention scales')
    answer(thread.id, 'Because d_k is fixed.', question(thread.id, 'Why?', anchor.id).id)

    const context = await buildAskContext(storage, question(thread.id, 'Q2'))

    // Without the quote, the replayed turn is the bare word "Why?".
    expect(context.messages[0].content).toContain('> attention scales')
    expect(context.messages[0].content).toContain('Why?')
  })

  it('spends the history budget on turns, not on notes', async () => {
    const { thread } = seed('body')
    // Comfortably more notes than the whole history budget.
    for (let i = 0; i < 40; i++) note(thread.id, `note ${i}`)
    answer(thread.id, 'A1', question(thread.id, 'Q1').id)

    const context = await buildAskContext(storage, question(thread.id, 'Q2'))

    expect(context.messages.slice(0, 2)).toEqual([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
    ])
  })

  it('spends the history budget on turns, not on failed answers', async () => {
    const { thread } = seed('body')
    answer(thread.id, 'A1', question(thread.id, 'Q1').id)
    // A run of failed asks — empty bodies, which used to consume history slots.
    for (let i = 0; i < 30; i++) answer(thread.id, '')

    const context = await buildAskContext(storage, question(thread.id, 'Q2'))

    expect(context.messages).toEqual([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
    ])
  })

  it('skips failed answers and never opens on an assistant turn', async () => {
    const { thread } = seed('body')
    // A completed answer with no preceding question in range, then a failed one.
    answer(thread.id, 'orphan answer')
    answer(thread.id, '')

    const context = await buildAskContext(storage, question(thread.id, 'Q'))

    expect(context.messages).toEqual([{ role: 'user', content: 'Q' }])
  })

  it('extracts text from an imported PDF', async () => {
    const source = join(dataDir, 'scan.pdf')
    writeFileSync(source, minimalPdf('Section 3 argues that attention scales.'))
    const { thread } = importDocument(storage, source)

    const context = await buildAskContext(
      storage,
      question(thread.id, 'What does section 3 argue?'),
    )

    expect(context.system).toContain('Section 3 argues that attention scales.')
  })

  it('still answers when a PDF yields no text', async () => {
    const source = join(dataDir, 'broken.pdf')
    writeFileSync(source, Buffer.from('%PDF-1.4 not really a pdf'))
    const { thread } = importDocument(storage, source)

    const context = await buildAskContext(storage, question(thread.id, 'What is this?'))

    expect(context.system).toContain('No extractable text')
    expect(context.messages.at(-1)!.content).toBe('What is this?')
  })
})
