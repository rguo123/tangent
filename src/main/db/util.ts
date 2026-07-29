import { randomUUID } from 'crypto'
import type { FsrsScheduling, FsrsState } from '@shared/entities'

export function newId(): string {
  return randomUUID()
}

/** ISO-8601 with millisecond precision — lexicographic order = chronological order. */
export function nowIso(): string {
  return new Date().toISOString()
}

/** The scheduling columns as they come off a row — `flashcard`'s, or the
 *  `prev_*` copy a review_log row carries for undo. */
export interface SchedulingColumns {
  stability: number | null
  difficulty: number | null
  dueAt: string | null
  lastReviewedAt: string | null
  state: FsrsState | null
  learningSteps: number | null
}

/** Rebuild FsrsScheduling from its columns. `state` is the null sentinel for
 *  "never scheduled"; the schema CHECK keeps the rest coherent with it, so the
 *  non-null assertions here are backed by the DB. `learning_steps` arrived a
 *  migration later than the others and defaults to 0 — a card mid-way through
 *  its learning steps when the app was upgraded restarts them, which is the
 *  cheapest possible one-time cost. */
export function schedulingFrom(columns: SchedulingColumns): FsrsScheduling | null {
  if (columns.state === null) return null
  return {
    stability: columns.stability!,
    difficulty: columns.difficulty!,
    dueAt: columns.dueAt!,
    lastReviewedAt: columns.lastReviewedAt,
    state: columns.state,
    learningSteps: columns.learningSteps ?? 0,
  }
}
