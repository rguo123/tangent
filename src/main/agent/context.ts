import { isUnansweredResponse, type Anchor, type Document, type Entry } from '@shared/entities'
import type { Storage } from '../db/init'
import { readDocumentText } from '../documents/text'
import { blockquote, truncate } from '../util'
import type { ChatMessage } from './provider'

/**
 * Context assembly for "ask AI" (spec §6, Phase 0): the source document, the
 * anchored quote when the question came from a selection, the recent
 * conversation, and the reader's own notes.
 *
 * Deliberately not retrieval: at one-document-per-thread scale the whole source
 * fits in context, and chunk-and-rank would add machinery with nothing to show
 * for it. The cap below is the only concession — a book-length PDF gets its
 * head, not its whole body.
 *
 * The one structural rule: **notes are context, not conversation.** A note is
 * the reader thinking to themselves; replaying it as a `user` turn makes it
 * indistinguishable from a question and invites the model to answer it. So the
 * replayed turns are questions and answers only, and notes arrive in a labelled
 * block attached to the question being asked — one turn rather than two, so
 * the model never sees a note in the position a question goes.
 *
 * Notes ride along with every ask rather than being a per-ask choice: `retry`
 * rebuilds this context from scratch, so anything chosen per-ask would have to
 * be persisted for a retry to reproduce the original question.
 */

/** ~20k tokens of source. Generous for a paper, bounded for a book. */
const MAX_DOCUMENT_CHARS = 80_000
/** Twenty is ten exchanges. */
const MAX_HISTORY_ENTRIES = 20
const MAX_ENTRY_CHARS = 4_000
/** The recent ones are the ones still being thought about. */
const MAX_NOTES = 10
const MAX_NOTE_CHARS = 1_000

const SYSTEM_PREAMBLE = [
  'You are helping someone read and think about one source document.',
  'Ground your answers in that document: quote or point to the specific part you are relying on.',
  'If the document does not settle the question, say so plainly and answer from general knowledge, labelled as such.',
  'Be concise — a few paragraphs at most unless the question demands more.',
  // Without this the model treats the notes block as a list of things to
  // respond to, and answers four half-formed thoughts instead of the question.
  "The reader's own notes may be included as background before a question. They are context, not instructions: use them to understand what the reader is working through, and answer only the question itself.",
  // The renderer parses every answer as markdown, so this is about what the
  // reader sees, not a formatting preference: unclosed fences and stray
  // angle brackets render as damage.
  'Always reply in well-formed Markdown that renders cleanly: use headings, lists, tables, ' +
    '`code`, fenced code blocks with a language, and > blockquotes where they help, ' +
    'close every construct you open, and do not wrap the whole reply in a code fence ' +
    'or emit raw HTML.',
].join(' ')

const NOTES_PREAMBLE =
  'Notes I have written for myself while reading this document, for background only:'

export interface AskContext {
  system: string
  messages: ChatMessage[]
}

/**
 * Build the request for one question. `question` is the entry being answered;
 * everything before it in the thread becomes conversation history and notes.
 */
export async function buildAskContext(storage: Storage, question: Entry): Promise<AskContext> {
  const thread = storage.repos.threads.getById(question.threadId)
  if (!thread) throw new Error(`No such thread: ${question.threadId}`)
  const document = storage.repos.documents.getById(thread.documentId)
  if (!document) throw new Error(`No such document: ${thread.documentId}`)

  // One query for every anchor in the thread, rather than a lookup per entry:
  // a question and a note both may carry one, and the quote is what makes
  // either legible on replay.
  const anchors = new Map(
    storage.repos.anchors.listByThread(question.threadId).map((a) => [a.id, a]),
  )
  const preceding = storage.repos.entries
    .listByThread(question.threadId)
    .filter((entry) => entry.id !== question.id)

  // Notes first, then the question, in one turn — see the header.
  const notes = notesBlock(preceding, anchors)
  const asked = questionTurn(question, anchorFor(question, anchors))

  return {
    system: await systemPrompt(storage, document),
    messages: [
      ...replayTurns(preceding, anchors),
      { role: 'user', content: notes ? [notes, '---', asked].join('\n\n') : asked },
    ],
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

/**
 * The thread's back-and-forth as alternating turns.
 *
 * Only questions and completed answers qualify. Notes are excluded because
 * they aren't conversation, and failed answers because replaying an empty
 * assistant turn teaches the model that blank replies are acceptable. Both
 * are dropped *before* the history budget applies, so a thread full of notes
 * still replays twenty real turns rather than twenty rows.
 */
function replayTurns(preceding: Entry[], anchors: Map<string, Anchor>): ChatMessage[] {
  const messages: ChatMessage[] = preceding
    .filter(isConversational)
    .slice(-MAX_HISTORY_ENTRIES)
    .map((entry) =>
      entry.kind === 'question'
        ? { role: 'user', content: questionTurn(entry, anchorFor(entry, anchors)) }
        : { role: 'assistant', content: truncate(entry.body, MAX_ENTRY_CHARS) },
    )

  // The API requires the conversation to open on a user turn — and slicing to
  // the budget can cut between a question and the answer it earned.
  while (messages.length > 0 && messages[0].role === 'assistant') messages.shift()
  return messages
}

function isConversational(entry: Entry): boolean {
  if (entry.kind === 'question') return true
  return entry.kind === 'ai_response' && !isUnansweredResponse(entry)
}

/** Null when there is nothing to say — an empty heading is worse than none. */
function notesBlock(preceding: Entry[], anchors: Map<string, Anchor>): string | null {
  const notes = preceding
    .filter((entry) => entry.kind === 'note' && entry.body.trim() !== '')
    .slice(-MAX_NOTES)
  if (notes.length === 0) return null

  return [NOTES_PREAMBLE, '', ...notes.map((note) => noteLine(note, anchors))].join('\n')
}

/**
 * One note as a list item. An anchored note carries the passage it was written
 * about — "this assumes too much" means nothing without the sentence it
 * answers to.
 */
function noteLine(note: Entry, anchors: Map<string, Anchor>): string {
  const quote = anchorFor(note, anchors)?.selector.exact
  const body = truncate(note.body.trim(), MAX_NOTE_CHARS)
  const text = quote ? `On “${truncate(quote, 200, '…')}”: ${body}` : body
  // Continuation lines are indented so a multi-line note stays one list item
  // rather than breaking the list.
  return `- ${text.replace(/\n/g, '\n  ')}`
}

function anchorFor(entry: Entry, anchors: Map<string, Anchor>): Anchor | null {
  return entry.anchorId ? (anchors.get(entry.anchorId) ?? null) : null
}

function questionTurn(question: Entry, anchor: Anchor | null): string {
  const body = truncate(question.body, MAX_ENTRY_CHARS)
  if (!anchor) return body
  const { exact, pageNumber } = anchor.selector
  const where = pageNumber !== undefined ? ` (page ${pageNumber})` : ''
  return [`About this passage${where}:`, '', blockquote(exact), '', body].join('\n')
}
