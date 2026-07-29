import { createEmptyCard, fsrs, type Card as FsrsCard } from 'ts-fsrs'
import type { CardLifecycle, Flashcard, FsrsScheduling, ReviewRating } from '@shared/entities'
import type { ReviewOutcome } from '@shared/ipc'
import type { Storage } from './db/init'

/**
 * The review half of the loop (spec §5): accepting a draft into scheduling,
 * grading a due card, and taking the last grade back.
 *
 * FSRS is a library here, not an agent (spec §5) — `ts-fsrs` owns every
 * interval decision and this module owns nothing but the translation between
 * its `Card` and our five-and-a-bit scheduling columns. Deliberately: the day
 * we want different intervals, the change is a parameter, not arithmetic
 * scattered through the app.
 *
 * Every write here pairs a card update with a `review_log` row, in one
 * transaction, because that log row is the only thing that can undo the update.
 * The log is append-only — undo flags a row rather than deleting it, so the
 * history of what was actually reviewed stays true even after it's reversed.
 */

/** Library defaults: FSRS-6 weights, 90% target retention, the 1m/10m learning
 *  steps. Tuning these is Phase 7's job, against real review data. */
const scheduler = fsrs()

/** The scheduler's card, rebuilt from what we store.
 *
 * The fields left at zero are ones it recomputes or never reads back:
 * `elapsed_days` comes from `last_review` and the review time, `scheduled_days`
 * is an output, and `reps`/`lapses` are counters no interval depends on. What
 * cannot be faked is `learning_steps` — see migration 004. */
function toFsrsCard(s: FsrsScheduling): FsrsCard {
  return {
    due: new Date(s.dueAt),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: s.learningSteps,
    reps: 0,
    lapses: 0,
    state: s.state as FsrsCard['state'],
    last_review: s.lastReviewedAt ? new Date(s.lastReviewedAt) : undefined,
  }
}

function toScheduling(card: FsrsCard): FsrsScheduling {
  return {
    stability: card.stability,
    difficulty: card.difficulty,
    dueAt: card.due.toISOString(),
    lastReviewedAt: card.last_review?.toISOString() ?? null,
    state: card.state as FsrsScheduling['state'],
    learningSteps: card.learning_steps,
  }
}

/** Days until the next due date, fractional — a 10-minute learning step and a
 *  same-day review are different answers, and whole days can't tell them apart. */
function intervalDays(from: Date, due: Date): number {
  return Math.round(((due.getTime() - from.getTime()) / 86_400_000) * 10_000) / 10_000
}

function requireCard(storage: Storage, cardId: string): Flashcard {
  const card = storage.repos.flashcards.getById(cardId)
  if (!card) throw new Error(`No such card: ${cardId}`)
  return card
}

/**
 * Accept a draft (the cull pass): it enters FSRS as a new card, due now.
 *
 * Accepting is the only way a card gets scheduling state, which is what makes
 * the draft queue a real gate — an unaccepted card is never in the review
 * queue, no matter how long it sits there.
 */
export function acceptCard(storage: Storage, cardId: string, now = new Date()): Flashcard {
  const card = requireCard(storage, cardId)
  if (card.lifecycle !== 'draft') throw new Error('That card has already been accepted.')

  const { flashcards } = storage.repos
  const accept = storage.db.transaction(() => {
    flashcards.updateScheduling(cardId, toScheduling(createEmptyCard(now)))
    flashcards.setLifecycle(cardId, 'active')
  })
  accept()
  return requireCard(storage, cardId)
}

/**
 * Grade a card. The scheduler decides the next state; we write it and log what
 * the state was beforehand, which is the entire mechanism behind undo.
 */
export function reviewCard(
  storage: Storage,
  cardId: string,
  rating: ReviewRating,
  now = new Date(),
): ReviewOutcome {
  const card = requireCard(storage, cardId)
  if (card.lifecycle === 'draft') throw new Error('Accept that card before reviewing it.')
  // Not an error: a card can only be suspended from the review screen, and
  // grading one is how a queue that was built a moment ago behaves. Reviewing
  // it is still meaningful — it just won't come back around.
  const current = card.scheduling ?? toScheduling(createEmptyCard(now))

  const { card: next } = scheduler.next(toFsrsCard(current), now, rating)
  const scheduling = toScheduling(next)

  const { flashcards, reviewLogs } = storage.repos
  const commit = storage.db.transaction(() => {
    flashcards.updateScheduling(cardId, scheduling)
    return reviewLogs.append({
      flashcardId: cardId,
      rating,
      scheduledInterval: intervalDays(now, next.due),
      prevScheduling: card.scheduling,
      reviewedAt: now.toISOString(),
    })
  })
  const log = commit()
  return { card: requireCard(storage, cardId), log }
}

/**
 * Take back the most recent grade on a card: the card goes back to the state
 * the log row recorded, and the row is flagged rather than removed.
 *
 * Restoring `null` is a real case — it's what undoing the first-ever review of
 * a just-accepted card means, and the schema allows a card with no scheduling
 * to exist for exactly this reason.
 */
export function undoLastReview(storage: Storage, cardId: string): Flashcard {
  const { flashcards, reviewLogs } = storage.repos
  const log = reviewLogs.latestFor(cardId)
  if (!log) throw new Error('There is no review to undo on that card.')

  const undo = storage.db.transaction(() => {
    flashcards.updateScheduling(cardId, log.prevScheduling)
    reviewLogs.markUndone(log.id)
  })
  undo()
  return requireCard(storage, cardId)
}

/** Suspend / unsuspend (spec lifecycle). Scheduling is left untouched, so an
 *  unsuspended card returns to the queue where it left off rather than as new. */
export function setCardLifecycle(
  storage: Storage,
  cardId: string,
  lifecycle: Exclude<CardLifecycle, 'draft'>,
): Flashcard {
  const card = requireCard(storage, cardId)
  if (card.lifecycle === 'draft') throw new Error('Accept or discard that draft first.')
  storage.repos.flashcards.setLifecycle(cardId, lifecycle)
  return requireCard(storage, cardId)
}

/** A cull-pass edit. Marks the card user-edited, which permanently shields it
 *  from regeneration (spec §2, enforced in `flashcardRepo.replaceContent`). */
export function editCard(storage: Storage, cardId: string, front: string, back: string): Flashcard {
  requireCard(storage, cardId)
  storage.repos.flashcards.updateContent(cardId, front.trim(), back.trim())
  return requireCard(storage, cardId)
}

/** Discard a dud (cull pass). Only ever a draft: once a card has been accepted
 *  it has review history, and deleting it would take that with it. */
export function discardCard(storage: Storage, cardId: string): void {
  const card = requireCard(storage, cardId)
  if (card.lifecycle !== 'draft') throw new Error('Suspend that card instead of discarding it.')
  storage.repos.flashcards.remove(cardId)
}
