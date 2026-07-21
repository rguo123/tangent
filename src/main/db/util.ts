import { randomUUID } from 'crypto'
import type { FsrsScheduling, FsrsState } from '@shared/entities'

export function newId(): string {
  return randomUUID()
}

/** ISO-8601 with millisecond precision — lexicographic order = chronological order. */
export function nowIso(): string {
  return new Date().toISOString()
}

/** Rebuild FsrsScheduling from its five columns. `state` is the null sentinel
 *  for "never scheduled"; the schema CHECK keeps the columns coherent, so the
 *  non-null assertions here are backed by the DB. */
export function schedulingFrom(
  stability: number | null,
  difficulty: number | null,
  dueAt: string | null,
  lastReviewedAt: string | null,
  state: FsrsState | null,
): FsrsScheduling | null {
  if (state === null) return null
  return { stability: stability!, difficulty: difficulty!, dueAt: dueAt!, lastReviewedAt, state }
}
