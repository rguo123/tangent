import type { Database } from 'better-sqlite3'
import type { Entry, TextQuoteSelector } from '@shared/entities'
import type { CreateEntryResult } from '@shared/ipc'
import type { Repos } from './repos'

/**
 * Cross-entity timeline writes. Repos stay single-table; anything that has to
 * commit more than one row at once composes them here, so there is exactly one
 * definition of "how an anchored entry lands".
 */

export interface CreateTimelineEntryInput {
  threadId: string
  /** `ai_response` never comes through here — it's created as the second half
   *  of an ask (below), always with a parent. */
  kind: 'note' | 'question'
  body: string
  anchor?: { documentId: string; selector: TextQuoteSelector }
}

/**
 * Create an entry, plus its anchor when the request carries one, as a single
 * transaction — an anchored entry must never half-commit.
 */
export function createTimelineEntry(
  db: Database,
  repos: Repos,
  input: CreateTimelineEntryInput,
): CreateEntryResult {
  const run = db.transaction((): CreateEntryResult => {
    const anchor = input.anchor
      ? repos.anchors.create({
          threadId: input.threadId,
          documentId: input.anchor.documentId,
          selector: input.anchor.selector,
        })
      : null
    const entry = repos.entries.create({
      threadId: input.threadId,
      kind: input.kind,
      body: input.body,
      anchorId: anchor?.id,
    })
    return { entry, anchor }
  })
  return run()
}

export interface AskPair {
  question: Entry
  /** Empty until the answer streams in; linked to its question by parentEntryId
   *  so replies stay attributable with two questions in flight. */
  response: Entry
  anchor: ReturnType<typeof createTimelineEntry>['anchor']
}

/**
 * The two entries an ask produces, committed together — a half-written pair
 * would strand either side in the timeline. The question is created the same
 * way a note is, so anchoring behaves identically whichever one you pick from
 * a selection.
 */
export function createAskPair(
  db: Database,
  repos: Repos,
  input: Omit<CreateTimelineEntryInput, 'kind'>,
): AskPair {
  const run = db.transaction((): AskPair => {
    const { entry: question, anchor } = createTimelineEntry(db, repos, {
      ...input,
      kind: 'question',
    })
    const response = repos.entries.create({
      threadId: input.threadId,
      kind: 'ai_response',
      body: '',
      parentEntryId: question.id,
    })
    return { question, response, anchor }
  })
  return run()
}
