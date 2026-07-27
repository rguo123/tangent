import { isUnansweredResponse, type Anchor, type Document, type Entry } from '@shared/entities'
import type { Storage } from '../db/init'
import { readDocumentText } from '../documents/text'
import { truncate } from '../util'
import type { ChatMessage } from './provider'

/**
 * Context assembly for "ask AI" (spec §6, Phase 0): the source document, the
 * anchored quote when the question came from a selection, and the recent
 * thread conversation.
 *
 * Deliberately not retrieval: at one-document-per-thread scale the whole source
 * fits in context, and chunk-and-rank would add machinery with nothing to show
 * for it. The cap below is the only concession — a book-length PDF gets its
 * head, not its whole body.
 */

/** ~20k tokens of source. Generous for a paper, bounded for a book. */
const MAX_DOCUMENT_CHARS = 80_000
/** How much of the thread's back-and-forth to replay as conversation. */
const MAX_HISTORY_ENTRIES = 20
const MAX_ENTRY_CHARS = 4_000

const SYSTEM_PREAMBLE = [
  'You are helping someone read and think about one source document.',
  'Ground your answers in that document: quote or point to the specific part you are relying on.',
  'If the document does not settle the question, say so plainly and answer from general knowledge, labelled as such.',
  'Be concise — a few paragraphs at most unless the question demands more.',
].join(' ')

export interface AskContext {
  system: string
  messages: ChatMessage[]
}

/**
 * Build the request for one question. `question` is the entry being answered;
 * everything before it in the thread becomes conversation history.
 */
export async function buildAskContext(
  storage: Storage,
  question: Entry,
  anchor: Anchor | null,
): Promise<AskContext> {
  const thread = storage.repos.threads.getById(question.threadId)
  if (!thread) throw new Error(`No such thread: ${question.threadId}`)
  const document = storage.repos.documents.getById(thread.documentId)
  if (!document) throw new Error(`No such document: ${thread.documentId}`)

  return {
    system: await systemPrompt(storage, document),
    messages: conversation(storage, question, anchor),
  }
}

async function systemPrompt(storage: Storage, document: Document): Promise<string> {
  const text = await readDocumentText(storage, document.id, MAX_DOCUMENT_CHARS)
  return [
    SYSTEM_PREAMBLE,
    '',
    `# Document: ${document.title}`,
    text || '(No extractable text for this document.)',
  ].join('\n')
}

function conversation(storage: Storage, question: Entry, anchor: Anchor | null): ChatMessage[] {
  const history = storage.repos.entries
    .listByThread(question.threadId)
    .filter((entry) => entry.id !== question.id)
    .slice(-MAX_HISTORY_ENTRIES)

  const messages: ChatMessage[] = []
  for (const entry of history) {
    // Replaying a failed ask as an empty assistant turn would just confuse the
    // model.
    if (isUnansweredResponse(entry)) continue
    messages.push({
      role: entry.kind === 'ai_response' ? 'assistant' : 'user',
      content: truncate(entry.body, MAX_ENTRY_CHARS),
    })
  }
  // The API requires the conversation to open on a user turn.
  while (messages.length > 0 && messages[0].role === 'assistant') messages.shift()

  messages.push({ role: 'user', content: questionTurn(question, anchor) })
  return messages
}

function questionTurn(question: Entry, anchor: Anchor | null): string {
  if (!anchor) return question.body
  const { exact, pageNumber } = anchor.selector
  const where = pageNumber !== undefined ? ` (page ${pageNumber})` : ''
  return [`About this passage${where}:`, '', `> ${exact}`, '', question.body].join('\n')
}
