import { writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IpcEventChannel, IpcEventPayload } from '@shared/ipc'
import { createAgentService, type AgentService } from '../../src/main/agent/ask'
import type { RendererEmit } from '../../src/main/ipc/emit'
import { MOCK_AGENT_CONFIG } from '../../src/main/agent/config'
import { createMockProvider, type MockProvider } from '../../src/main/agent/provider'
import type { Storage } from '../../src/main/db/init'
import { importDocument } from '../../src/main/documents/import'
import { clearDocumentTextCache } from '../../src/main/documents/text'
import { tempStorage } from '../storage/helpers'

/** Collects the main → renderer pushes and lets a test await one stream. */
function recorder() {
  const deltas = new Map<string, string>()
  const ended = new Map<string, string | null>()
  const waiting = new Map<string, (error: string | null) => void>()
  const order: string[] = []

  const emit: RendererEmit = <C extends IpcEventChannel>(
    channel: C,
    payload: IpcEventPayload<C>,
  ) => {
    order.push(channel)
    if (channel === 'agent:start') {
      // nothing to accumulate — presence in `order` is the assertion
    } else if (channel === 'agent:delta') {
      const { entryId, text } = payload as IpcEventPayload<'agent:delta'>
      deltas.set(entryId, (deltas.get(entryId) ?? '') + text)
    } else {
      const { entryId, error } = payload as IpcEventPayload<'agent:end'>
      const waiter = waiting.get(entryId)
      if (waiter) {
        waiting.delete(entryId)
        waiter(error)
      } else {
        ended.set(entryId, error)
      }
    }
  }

  return {
    emit,
    order,
    streamedText: (entryId: string) => deltas.get(entryId) ?? '',
    /** Consumes the verdict, so a retry on the same entry waits for the *next*
     *  stream rather than reading the previous one's result. */
    waitForEnd: (entryId: string): Promise<string | null> => {
      if (ended.has(entryId)) {
        const error = ended.get(entryId)!
        ended.delete(entryId)
        return Promise.resolve(error)
      }
      return new Promise((resolve) => waiting.set(entryId, resolve))
    },
  }
}

let storage: Storage
let dataDir: string
let cleanup: () => void
let provider: MockProvider
let events: ReturnType<typeof recorder>
let agent: AgentService
let threadId: string
let documentId: string

beforeEach(() => {
  ;({ storage, dataDir, cleanup } = tempStorage())
  clearDocumentTextCache()

  const source = join(dataDir, 'paper.md')
  writeFileSync(source, '# Paper\n\nSection 3 argues that attention scales.')
  const imported = importDocument(storage, source)
  threadId = imported.thread.id
  documentId = imported.document.id

  provider = createMockProvider()
  events = recorder()
  agent = createAgentService(storage, provider, MOCK_AGENT_CONFIG, events.emit)
})

afterEach(() => {
  agent.abortAll()
  cleanup()
})

describe('ask', () => {
  it('writes the question and its answer placeholder before any network call', async () => {
    const { question, response } = agent.ask({ threadId, body: 'What does section 3 argue?' })

    expect(question.kind).toBe('question')
    expect(response.kind).toBe('ai_response')
    expect(response.parentEntryId).toBe(question.id)
    expect(response.body).toBe('') // the answer hasn't arrived yet
    // The renderer knows the answer is in flight before `ask` even returns,
    // so a fast first delta can't be mistaken for a failed ask.
    expect(events.order[0]).toBe('agent:start')

    await events.waitForEnd(response.id)
  })

  it('streams the answer and persists it on completion', async () => {
    const { response } = agent.ask({ threadId, body: 'What does section 3 argue?' })

    expect(await events.waitForEnd(response.id)).toBeNull()

    const streamed = events.streamedText(response.id)
    expect(streamed).toContain('What does section 3 argue?')
    expect(storage.repos.entries.getById(response.id)!.body).toBe(streamed)
  })

  it('grounds the call in the document text and the anchored quote', async () => {
    const { response } = agent.ask({
      threadId,
      body: 'Why does that hold?',
      anchor: {
        documentId,
        selector: {
          type: 'text-quote',
          exact: 'attention scales',
          prefix: '',
          suffix: '',
          pageNumber: 2,
        },
      },
    })
    await events.waitForEnd(response.id)

    const call = provider.chatCalls[0]
    expect(call.system).toContain('Section 3 argues that attention scales.')
    expect(call.messages.at(-1)!.content).toContain('> attention scales')

    // The anchor is a real row, so the highlight survives a relaunch.
    expect(storage.repos.anchors.listByThread(threadId)).toHaveLength(1)
  })

  it('keeps the question and stays retryable when the provider fails', async () => {
    provider.failNext('network down')
    const { question, response } = agent.ask({ threadId, body: 'What does section 3 argue?' })

    expect(await events.waitForEnd(response.id)).toBe('network down')
    // Never a lost question: the asked text is intact, the answer is empty —
    // which is exactly what the UI reads as "failed, retry available".
    expect(storage.repos.entries.getById(question.id)!.body).toBe('What does section 3 argue?')
    expect(storage.repos.entries.getById(response.id)!.body).toBe('')

    agent.retry(response.id)
    expect(await events.waitForEnd(response.id)).toBeNull()
    expect(storage.repos.entries.getById(response.id)!.body).toContain('What does section 3 argue?')
  })

  it('attaches concurrent answers to the right questions', async () => {
    const first = agent.ask({ threadId, body: 'First question?' })
    const second = agent.ask({ threadId, body: 'Second question?' })

    await Promise.all([events.waitForEnd(first.response.id), events.waitForEnd(second.response.id)])

    expect(first.response.parentEntryId).toBe(first.question.id)
    expect(second.response.parentEntryId).toBe(second.question.id)
    expect(storage.repos.entries.getById(first.response.id)!.body).toContain('First question?')
    expect(storage.repos.entries.getById(second.response.id)!.body).toContain('Second question?')
  })

  it('refuses to retry anything but an AI response', async () => {
    const { question, response } = agent.ask({ threadId, body: 'Q' })
    expect(() => agent.retry(question.id)).toThrow(/Only AI responses/)
    await events.waitForEnd(response.id)
  })

  it('reports provider status for the composer', () => {
    expect(agent.status()).toEqual({
      provider: 'mock',
      model: 'mock-chat',
      baseUrl: '',
      embeddingProvider: 'mock',
      embeddingModel: 'mock-embed-64',
      unavailable: null,
    })
  })
})
