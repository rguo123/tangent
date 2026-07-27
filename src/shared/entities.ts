/**
 * Domain entity types — the spec's §2 data model, shared by main and renderer.
 *
 * These are the shapes the repo layer returns (camelCase, JS types). The
 * snake_case SQL rows they map from live entirely inside src/main/db.
 */

export type SourceType = 'pdf' | 'markdown' | 'generated' | 'chat_transcript'
export type ThreadStatus = 'active' | 'archived'
export type EntryKind = 'note' | 'question' | 'ai_response'
export type ConceptStatus = 'active' | 'merged'
export type CardType = 'recall' | 'relationship'
export type CardLifecycle = 'draft' | 'active' | 'suspended'

export interface Field {
  id: string
  name: string
  createdAt: string
}

export interface Document {
  id: string
  fieldId: string
  title: string
  sourceType: SourceType
  /** File path (pdf) or content blob (markdown/generated); null for chat_transcript. */
  contentRef: string | null
  createdAt: string
}

export interface Thread {
  id: string
  fieldId: string
  /** Never null (spec §3.3) — exploration threads get a chat_transcript Document. */
  documentId: string
  parentThreadId: string | null
  title: string
  status: ThreadStatus
  createdAt: string
}

/** W3C-style text-quote selector; page number for PDFs. For chat_transcript
 *  documents the selector is a message-id range instead (later phase). */
export interface TextQuoteSelector {
  type: 'text-quote'
  exact: string
  prefix: string
  suffix: string
  pageNumber?: number
}

export interface Anchor {
  id: string
  threadId: string
  /** Kept alongside threadId deliberately — the seam for multi-document threads. */
  documentId: string
  selector: TextQuoteSelector
  createdAt: string
  /** Extraction watermark (spec §5.1), for a highlight with no note. An anchor
   *  is immutable, so unlike an entry it has no `updatedAt` to outrun: set
   *  once, cleared only by an undo. */
  extractedAt: string | null
}

export interface Entry {
  id: string
  threadId: string
  anchorId: string | null
  /** Links an ai_response to the question it answers. */
  parentEntryId: string | null
  kind: EntryKind
  body: string
  pinned: boolean
  createdAt: string
  updatedAt: string
  /** Extraction watermark (spec §5.1): due when null or < updatedAt. */
  extractedAt: string | null
}

/**
 * An `ai_response` with an empty body is an ask that failed or hasn't landed
 * yet — the app's stand-in for a status column, and the one place that
 * convention is expressed as code. Main skips these when replaying a thread as
 * conversation; the renderer draws them as retryable.
 */
export function isUnansweredResponse(entry: Entry): boolean {
  return entry.kind === 'ai_response' && entry.body.trim() === ''
}

export interface Concept {
  id: string
  fieldId: string
  canonicalText: string
  embedding: Float32Array | null
  /** Which model produced the embedding — lets a model switch detect stale vectors. */
  embeddingModel: string | null
  status: ConceptStatus
  /** Set iff status = 'merged' (CHECK-enforced). */
  mergedIntoId: string | null
  createdAt: string
  updatedAt: string
}

export interface ConceptMention {
  id: string
  conceptId: string
  /** At least one of entryId/anchorId is non-null (CHECK-enforced). */
  entryId: string | null
  anchorId: string | null
  createdAt: string
}

/** ts-fsrs State enum values: 0=New, 1=Learning, 2=Review, 3=Relearning. */
export type FsrsState = 0 | 1 | 2 | 3

export interface FsrsScheduling {
  stability: number
  difficulty: number
  dueAt: string
  lastReviewedAt: string | null
  state: FsrsState
}

export interface Flashcard {
  id: string
  fieldId: string
  conceptIds: string[]
  front: string
  back: string
  cardType: CardType
  lifecycle: CardLifecycle
  /** Set once the user edits front/back; regeneration must never clobber these. */
  userEdited: boolean
  /** Null until the card is accepted into FSRS scheduling. */
  scheduling: FsrsScheduling | null
  createdAt: string
  updatedAt: string
}

/** FSRS ratings: 1=Again, 2=Hard, 3=Good, 4=Easy. */
export type ReviewRating = 1 | 2 | 3 | 4

export interface ReviewLog {
  id: string
  flashcardId: string
  rating: ReviewRating
  reviewedAt: string
  /** Days until the next due date the scheduler assigned. */
  scheduledInterval: number | null
  /** Pre-review FSRS state, for undo-last-review. */
  prevScheduling: FsrsScheduling | null
  undone: boolean
}
