import { writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Storage } from '../../src/main/db/init'
import { buildAskContext } from '../../src/main/agent/context'
import { importDocument } from '../../src/main/documents/import'
import { clearDocumentTextCache } from '../../src/main/documents/text'
import { tempStorage } from '../storage/helpers'
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

/** field → markdown document → thread, using the real import path. */
function seedMarkdownThread(body: string) {
  const source = join(dataDir, 'paper.md')
  writeFileSync(source, body)
  return importDocument(storage, source)
}

describe('buildAskContext', () => {
  it('puts the document text in the system prompt and the question last', async () => {
    const { thread } = seedMarkdownThread('# Attention\n\nSection 3 argues that attention scales.')
    const question = storage.repos.entries.create({
      threadId: thread.id,
      kind: 'question',
      body: 'What does section 3 argue?',
    })

    const context = await buildAskContext(storage, question, null)

    expect(context.system).toContain('Section 3 argues that attention scales.')
    expect(context.system).toContain('# Document: paper')
    expect(context.messages).toEqual([{ role: 'user', content: 'What does section 3 argue?' }])
  })

  it('carries the anchored quote into the question turn', async () => {
    const { document, thread } = seedMarkdownThread('body text')
    const anchor = storage.repos.anchors.create({
      threadId: thread.id,
      documentId: document.id,
      selector: {
        type: 'text-quote',
        exact: 'attention scales',
        prefix: '',
        suffix: '',
        pageNumber: 4,
      },
    })
    const question = storage.repos.entries.create({
      threadId: thread.id,
      kind: 'question',
      body: 'Why?',
      anchorId: anchor.id,
    })

    const context = await buildAskContext(storage, question, anchor)

    const last = context.messages.at(-1)!
    expect(last.content).toContain('> attention scales')
    expect(last.content).toContain('page 4')
    expect(last.content).toContain('Why?')
  })

  it('replays the thread as conversation, with AI responses as assistant turns', async () => {
    const { thread } = seedMarkdownThread('body')
    const { entries } = storage.repos
    const firstQuestion = entries.create({ threadId: thread.id, kind: 'question', body: 'Q1' })
    entries.create({
      threadId: thread.id,
      kind: 'ai_response',
      body: 'A1',
      parentEntryId: firstQuestion.id,
    })
    entries.create({ threadId: thread.id, kind: 'note', body: 'my note' })
    const question = entries.create({ threadId: thread.id, kind: 'question', body: 'Q2' })

    const context = await buildAskContext(storage, question, null)

    expect(context.messages).toEqual([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'my note' },
      { role: 'user', content: 'Q2' },
    ])
  })

  it('skips failed answers and never opens on an assistant turn', async () => {
    const { thread } = seedMarkdownThread('body')
    const { entries } = storage.repos
    // A completed answer with no preceding question in range, then a failed one.
    entries.create({ threadId: thread.id, kind: 'ai_response', body: 'orphan answer' })
    entries.create({ threadId: thread.id, kind: 'ai_response', body: '' })
    const question = entries.create({ threadId: thread.id, kind: 'question', body: 'Q' })

    const context = await buildAskContext(storage, question, null)

    expect(context.messages).toEqual([{ role: 'user', content: 'Q' }])
  })

  it('extracts text from an imported PDF', async () => {
    const source = join(dataDir, 'scan.pdf')
    writeFileSync(source, minimalPdf('Section 3 argues that attention scales.'))
    const { thread } = importDocument(storage, source)
    const question = storage.repos.entries.create({
      threadId: thread.id,
      kind: 'question',
      body: 'What does section 3 argue?',
    })

    const context = await buildAskContext(storage, question, null)

    expect(context.system).toContain('Section 3 argues that attention scales.')
  })

  it('still answers when a PDF yields no text', async () => {
    const source = join(dataDir, 'broken.pdf')
    writeFileSync(source, Buffer.from('%PDF-1.4 not really a pdf'))
    const { thread } = importDocument(storage, source)
    const question = storage.repos.entries.create({
      threadId: thread.id,
      kind: 'question',
      body: 'What is this?',
    })

    const context = await buildAskContext(storage, question, null)

    expect(context.system).toContain('No extractable text')
    expect(context.messages.at(-1)!.content).toBe('What is this?')
  })
})
