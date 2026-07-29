/**
 * IPC contract shared between main, preload, and renderer.
 *
 * Every channel is a key in `IpcContract`, mapping to its request/response
 * types. Main registers handlers through `handle()` (src/main/ipc) and the
 * renderer calls through `invoke()` (src/preload) — both derive their
 * signatures from this one map, so the two sides cannot drift.
 */

import type {
  Anchor,
  CardLifecycle,
  Document,
  Entry,
  Flashcard,
  ReviewLog,
  ReviewRating,
  TextQuoteSelector,
  Thread,
  ThreadStatus,
} from './entities'

/** A thread joined with its document — what the sidebar renders. */
export interface ThreadListItem {
  thread: Thread
  document: Document
}

export interface ImportResult {
  document: Document
  thread: Thread
}

/** What the document pane renders. PDFs cross the bridge as bytes; text
 *  sources as their content string. chat_transcript never reaches here —
 *  its content is the thread's entry timeline. */
export type DocumentContent =
  | { sourceType: 'pdf'; data: Uint8Array }
  | { sourceType: 'markdown' | 'generated'; content: string }

/** Everything the notes pane renders for one thread, in one round trip. */
export interface TimelineData {
  entries: Entry[]
  anchors: Anchor[]
}

export interface CreateEntryRequest {
  threadId: string
  /** Notes only. A question always comes with the `ai_response` that answers
   *  it, so `entries:ask` is the only way to create one — narrowing the type
   *  here is what keeps a second caller from minting an orphan question. */
  kind: 'note'
  body: string
  /** Present when the entry is anchored to a document selection — the anchor
   *  and entry are created in one transaction. */
  anchor?: { documentId: string; selector: TextQuoteSelector }
}

export interface CreateEntryResult {
  entry: Entry
  anchor: Anchor | null
}

/** Same shape as a `question` CreateEntryRequest — asking is "create a question
 *  entry, then answer it", so the request carries the same optional anchor. */
export type AskRequest = Omit<CreateEntryRequest, 'kind'>

/** Returned as soon as both rows exist; the reply arrives over `agent:delta`
 *  and lands in `response.body` by the time `agent:end` fires. */
export interface AskResult {
  question: Entry
  /** The ai_response entry the answer streams into. Body starts empty. */
  response: Entry
  anchor: Anchor | null
}

/** What the composer needs to know before the user asks anything. */
export interface AgentStatus {
  provider: string
  model: string
  /** The endpoint serving `model` — the same model id means different things
   *  on different hosts, so the UI shows which one is in play. */
  baseUrl: string
  embeddingProvider: string
  embeddingModel: string
  /** Null when the provider can be called; a human-readable reason (missing
   *  API key) otherwise, so the UI can warn before the first ask fails. */
  unavailable: string | null
}

/** What one extraction run did. `batchId` is null when nothing was written —
 *  which is most runs, since the trigger is a timer, not a change. */
export interface ExtractionSummary {
  threadId: string
  /** The handle undo needs; null when there was nothing to commit. */
  batchId: string | null
  conceptsAdded: number
  /** Existing concepts that gained a new source. A run that adds only mentions
   *  found nothing new, but did learn where else the idea shows up. */
  mentionsAdded: number
  /** Draft cards written for the new concepts. Fewer than `conceptsAdded` when
   *  cardgen skipped a concept, and zero when it failed — which costs the cards
   *  and not the extraction. */
  cardsAdded: number
}

/**
 * Everything the Artifacts pane renders, in one round trip.
 *
 * Both queues come back whole rather than as counts plus a lazy fetch: they are
 * a handful of rows, and a count that can disagree with the list under it is a
 * header that lies. `activeCount` is the one number no list here implies — the
 * size of the deck the due queue is a slice of.
 */
export interface CardsData {
  /** The cull queue: drafts for the Field, oldest first. */
  drafts: Flashcard[]
  /** The review queue: active cards due now, for the whole Field (spec §4 —
   *  not just the open thread). */
  due: Flashcard[]
  activeCount: number
}

/** A graded card plus the log row that can take the grade back. */
export interface ReviewOutcome {
  card: Flashcard
  log: ReviewLog
}

export interface DebugVersions {
  electron: string
  chrome: string
  node: string
  sqlite: string
}

/** Row counts per table — dev-only visibility into the DB. */
export interface DbStats {
  tables: Record<string, number>
}

export interface IpcContract {
  /** Opens a native file picker in main; null when the user cancels. */
  'documents:import': { request: void; response: ImportResult | null }
  /** Clip an article from the web. Takes seconds — a real browser loads the
   *  page — so the renderer shows a pending state rather than blocking. */
  'documents:importUrl': { request: { url: string }; response: ImportResult }
  'documents:content': { request: { documentId: string }; response: DocumentContent }
  /** All threads (active and archived) for the default Field, newest first. */
  'threads:list': { request: void; response: ThreadListItem[] }
  'threads:setStatus': { request: { threadId: string; status: ThreadStatus }; response: void }
  'timeline:get': { request: { threadId: string }; response: TimelineData }
  'entries:create': { request: CreateEntryRequest; response: CreateEntryResult }
  /** Bumps updated_at — the extraction watermark (spec §5.1) depends on it. */
  'entries:updateBody': { request: { entryId: string; body: string }; response: Entry }
  /** Pinning an ai_response is the curation gesture that makes it extraction
   *  fodder (spec §5.1). */
  'entries:setPinned': { request: { entryId: string; pinned: boolean }; response: Entry }
  /** Creates the question + ai_response pair and starts streaming. Resolves
   *  once the rows exist — not once the answer is done. */
  'entries:ask': { request: AskRequest; response: AskResult }
  /** Re-runs the answer for an existing ai_response entry (failed or partial).
   *  The new text arrives over `agent:delta`, so there's nothing to return. */
  'entries:retryAsk': { request: { entryId: string }; response: void }
  'agent:status': { request: void; response: AgentStatus }
  /** Which thread the user is looking at. Main extracts the one they left —
   *  the renderer is the only side that knows a switch happened. */
  'extraction:setActiveThread': { request: { threadId: string | null }; response: void }
  /** Extract now, and wait for the verdict (the dev "extract now" button).
   *  Background runs report over `extraction:committed` instead. */
  'extraction:run': { request: { threadId: string }; response: ExtractionSummary }
  /** Reverse a committed batch — the chip's undo. Throws once the batch has
   *  aged out of main's undo window. */
  'extraction:undo': { request: { batchId: string }; response: void }
  /** Both queues and the deck size, together — the pane re-pulls all of it
   *  after every verb, so splitting it up would only buy extra round trips. */
  'cards:state': { request: void; response: CardsData }
  /** Cull accept: draft → active, with FSRS state initialized. */
  'cards:accept': { request: { cardId: string }; response: Flashcard }
  /** Cull edit. Sets `user_edited`, which shields the card from regeneration. */
  'cards:edit': { request: { cardId: string; front: string; back: string }; response: Flashcard }
  /** Cull discard. Drafts only — an accepted card is suspended, not deleted. */
  'cards:discard': { request: { cardId: string }; response: void }
  'cards:setLifecycle': {
    request: { cardId: string; lifecycle: Exclude<CardLifecycle, 'draft'> }
    response: Flashcard
  }
  'cards:review': { request: { cardId: string; rating: ReviewRating }; response: ReviewOutcome }
  /** Undo the last (not-yet-undone) review of one card. */
  'cards:undoReview': { request: { cardId: string }; response: Flashcard }
  'debug:versions': { request: void; response: DebugVersions }
  'debug:dbStats': { request: void; response: DbStats }
}

export type IpcChannel = keyof IpcContract
export type IpcRequest<C extends IpcChannel> = IpcContract[C]['request']
export type IpcResponse<C extends IpcChannel> = IpcContract[C]['response']

/**
 * Main → renderer pushes. Everything else in this file is request/response;
 * streaming needs the other direction, so it gets its own map. Same rule
 * applies: payload types are declared once and both sides derive from them.
 */
export interface IpcEvents {
  /** An answer started generating. Emitted before the provider is called, so
   *  in-flight state is driven purely by events — the renderer never has to
   *  race a delta against the `entries:ask` response. */
  'agent:start': { entryId: string }
  /** A chunk of an in-flight answer, to append to `entryId`'s live text. */
  'agent:delta': { entryId: string; text: string }
  /** The stream finished. `error` is null on success; on failure the entry
   *  keeps whatever partial body arrived and the ask is retryable. */
  'agent:end': { entryId: string; error: string | null }
  /** A background extraction wrote something. The renderer's cue for the
   *  transient chip (spec §7) — the write itself is silent. */
  'extraction:committed': ExtractionSummary
  /** A triggered run failed. Nothing was written and the entries stay due, so
   *  this is information rather than an error to act on. */
  'extraction:failed': { threadId: string; error: string }
  /**
   * Main wrote or removed cards without being asked to by the pane — cardgen
   * after an extraction, or the undo that takes those drafts back. One event
   * for both, so the cull queue has a single reason to reload rather than one
   * per producer (regeneration and concept merge are the next two).
   */
  'cards:changed': { reason: 'generated' | 'undone' }
}

export type IpcEventChannel = keyof IpcEvents
export type IpcEventPayload<C extends IpcEventChannel> = IpcEvents[C]
