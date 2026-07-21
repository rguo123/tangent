import type { Database } from 'better-sqlite3'
import type { FsrsScheduling, FsrsState, ReviewLog, ReviewRating } from '@shared/entities'
import { newId, nowIso, schedulingFrom } from '../util'

interface ReviewLogRow {
  id: string
  flashcard_id: string
  rating: ReviewRating
  reviewed_at: string
  scheduled_interval: number | null
  prev_stability: number | null
  prev_difficulty: number | null
  prev_due_at: string | null
  prev_last_reviewed_at: string | null
  prev_state: FsrsState | null
  undone: number
}

function toReviewLog(r: ReviewLogRow): ReviewLog {
  return {
    id: r.id,
    flashcardId: r.flashcard_id,
    rating: r.rating,
    reviewedAt: r.reviewed_at,
    scheduledInterval: r.scheduled_interval,
    prevScheduling: schedulingFrom(
      r.prev_stability,
      r.prev_difficulty,
      r.prev_due_at,
      r.prev_last_reviewed_at,
      r.prev_state,
    ),
    undone: r.undone !== 0,
  }
}

export interface AppendReviewInput {
  flashcardId: string
  rating: ReviewRating
  scheduledInterval?: number
  /** The card's FSRS state *before* this review — what undo restores. */
  prevScheduling: FsrsScheduling | null
  reviewedAt?: string
}

export function createReviewLogRepo(db: Database) {
  const insert = db.prepare(
    `INSERT INTO review_log
       (id, flashcard_id, rating, reviewed_at, scheduled_interval,
        prev_stability, prev_difficulty, prev_due_at, prev_last_reviewed_at, prev_state, undone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  )
  const byFlashcard = db.prepare(
    'SELECT * FROM review_log WHERE flashcard_id = ? ORDER BY reviewed_at, rowid',
  )
  const latest = db.prepare(
    `SELECT * FROM review_log WHERE flashcard_id = ? AND undone = 0
     ORDER BY reviewed_at DESC, rowid DESC LIMIT 1`,
  )
  // Append-only table: undo flags the row, never deletes it.
  const flagUndone = db.prepare('UPDATE review_log SET undone = 1 WHERE id = ?')

  const byIdStmt = db.prepare('SELECT * FROM review_log WHERE id = ?')

  return {
    append(input: AppendReviewInput): ReviewLog {
      const id = newId()
      const p = input.prevScheduling
      insert.run(
        id,
        input.flashcardId,
        input.rating,
        input.reviewedAt ?? nowIso(),
        input.scheduledInterval ?? null,
        p?.stability ?? null,
        p?.difficulty ?? null,
        p?.dueAt ?? null,
        p?.lastReviewedAt ?? null,
        p?.state ?? null,
      )
      return toReviewLog(byIdStmt.get(id) as ReviewLogRow)
    },

    listFor(flashcardId: string): ReviewLog[] {
      return (byFlashcard.all(flashcardId) as ReviewLogRow[]).map(toReviewLog)
    },

    /** Most recent not-yet-undone review — the target of undo-last-review. */
    latestFor(flashcardId: string): ReviewLog | null {
      const row = latest.get(flashcardId) as ReviewLogRow | undefined
      return row ? toReviewLog(row) : null
    },

    markUndone(id: string): void {
      flagUndone.run(id)
    },
  }
}

export type ReviewLogRepo = ReturnType<typeof createReviewLogRepo>
