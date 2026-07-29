import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Flashcard, ReviewRating } from '@shared/entities'
import Markdown from '../../Markdown'
import { useCardsStore } from '../../state/cardsStore'
import CardEditor from './CardEditor'
import { formatInterval } from './interval'

/**
 * The Artifacts pane: where extraction's output becomes something you actually
 * do. Two queues, in the order they matter — the cull pass on top while drafts
 * exist, the review queue below it.
 *
 * Keyboard-first, because both are volume gestures: culling a card should cost
 * one key and a second of judgement, and grading one should cost one key. The
 * two key sets are disjoint (a/e/d for the cull, space and 1–4 for review), so
 * both queues stay live at once and neither needs a mode to switch into.
 */

const RATINGS: { rating: ReviewRating; label: string; hint: string }[] = [
  { rating: 1, label: 'Again', hint: '1' },
  { rating: 2, label: 'Hard', hint: '2' },
  { rating: 3, label: 'Good', hint: '3' },
  { rating: 4, label: 'Easy', hint: '4' },
]

export default function ArtifactsPane() {
  const drafts = useCardsStore((s) => s.drafts)
  const due = useCardsStore((s) => s.due)
  const activeCount = useCardsStore((s) => s.activeCount)
  const loaded = useCardsStore((s) => s.loaded)
  const revealed = useCardsStore((s) => s.revealed)
  const lastReview = useCardsStore((s) => s.lastReview)
  const [editing, setEditing] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  const draft = drafts[0] ?? null
  const reviewing = due[0] ?? null

  // The shortcuts live on the pane, so they only fire while it has focus — a
  // pane full of single-letter keys must never eat a keystroke meant for the
  // composer in the pane next door. Opening the pane is a deliberate act, so it
  // takes focus outright.
  useEffect(() => {
    bodyRef.current?.focus({ preventScroll: true })
    void useCardsStore.getState().refresh()
    return useCardsStore.getState().subscribe()
  }, [])

  // Afterwards it only ever takes focus back from itself: finishing one card
  // should leave you on the next, but a draft landing mid-sentence must not
  // pull the cursor out of a note being written.
  useEffect(() => {
    const body = bodyRef.current
    if (editing || !body || (!draft && !reviewing)) return
    const focused = document.activeElement
    if (focused && focused !== document.body && !body.contains(focused)) return
    body.focus({ preventScroll: true })
  }, [editing, draft?.id, reviewing?.id])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const store = useCardsStore.getState()
    const key = event.key.toLowerCase()

    // Cull keys, only while there is something to cull.
    if (draft && !editing) {
      if (key === 'a') return run(event, () => store.accept(draft.id))
      if (key === 'e') return run(event, () => setEditing(true))
      if (key === 'd') return run(event, () => store.discard(draft.id))
    }

    if (key === 'u' && lastReview) return run(event, () => store.undoLastReview())
    if (!reviewing) return

    if (!revealed && (key === ' ' || key === 'enter')) return run(event, () => store.reveal())
    if (key === 's') return run(event, () => store.suspend(reviewing.id))
    const rating = RATINGS.find((r) => r.hint === key)
    if (rating && revealed) return run(event, () => store.review(rating.rating))
  }

  return (
    <section className="pane artifacts-pane">
      <header className="pane-header">
        <span className="pane-title">Cards</span>
        <span className="pane-counts">
          {drafts.length > 0 && <span className="pane-count drafts">{drafts.length} draft</span>}
          <span className="pane-count">{due.length} due</span>
          <span className="pane-count">{activeCount} active</span>
        </span>
      </header>
      {/* Focusable so the shortcuts have somewhere to land; clicking anywhere
          in the pane is what gives it focus back. */}
      <div className="pane-body artifacts-body" tabIndex={0} ref={bodyRef} onKeyDown={onKeyDown}>
        {!loaded && <p className="pane-status">Loading…</p>}

        {draft && (
          <section className="cull">
            <h2 className="artifacts-heading">
              Cull <span className="artifacts-remaining">{drafts.length} to go</span>
            </h2>
            {editing ? (
              <CardEditor
                card={draft}
                onSave={(front, back) => {
                  setEditing(false)
                  void useCardsStore.getState().edit(draft.id, front, back)
                }}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <DraftCard card={draft} onEdit={() => setEditing(true)} />
            )}
          </section>
        )}

        <section className="review">
          <h2 className="artifacts-heading">Review</h2>
          {lastReview && (
            <div className="review-undo">
              {/* Clipped by CSS, like every other quote in the app. */}
              <span>
                “{lastReview.front}” · next in {formatInterval(lastReview.intervalDays)}
              </span>
              <button onClick={() => void useCardsStore.getState().undoLastReview()}>
                undo <kbd>u</kbd>
              </button>
            </div>
          )}
          {reviewing ? (
            <ReviewCard card={reviewing} revealed={revealed} />
          ) : (
            <p className="pane-status">
              {loaded && activeCount === 0
                ? 'No cards yet. Read, note, and extraction will draft some.'
                : 'Nothing due right now.'}
            </p>
          )}
        </section>
      </div>
    </section>
  )
}

/** Run a shortcut's action and stop the key doing anything else — space would
 *  otherwise scroll the pane out from under the card it just revealed. */
function run(event: KeyboardEvent<HTMLDivElement>, action: () => void | Promise<void>): void {
  event.preventDefault()
  void action()
}

/** A draft, both sides showing: the cull decision is about whether the card is
 *  worth keeping, which you can't judge from the front alone. */
function DraftCard({ card, onEdit }: { card: Flashcard; onEdit: () => void }) {
  const cards = useCardsStore.getState
  return (
    <article className="card card-draft">
      <Markdown source={card.front} className="card-front" />
      <hr className="card-rule" />
      <Markdown source={card.back} className="card-back" />
      <div className="card-actions">
        <button className="card-action primary" onClick={() => void cards().accept(card.id)}>
          Accept <kbd>a</kbd>
        </button>
        <button className="card-action" onClick={onEdit}>
          Edit <kbd>e</kbd>
        </button>
        <button className="card-action" onClick={() => void cards().discard(card.id)}>
          Discard <kbd>d</kbd>
        </button>
      </div>
    </article>
  )
}

/** A due card. The back stays hidden until you've committed to an answer —
 *  that gap is the entire point of the exercise. */
function ReviewCard({ card, revealed }: { card: Flashcard; revealed: boolean }) {
  const cards = useCardsStore.getState
  return (
    <article className="card card-review">
      <Markdown source={card.front} className="card-front" />
      {revealed ? (
        <>
          <hr className="card-rule" />
          <Markdown source={card.back} className="card-back" />
          <div className="card-actions">
            {RATINGS.map(({ rating, label, hint }) => (
              <button
                key={rating}
                className={`card-action rating rating-${rating}`}
                onClick={() => void cards().review(rating)}
              >
                {label} <kbd>{hint}</kbd>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="card-actions">
          <button className="card-action primary" onClick={() => cards().reveal()}>
            Show answer <kbd>space</kbd>
          </button>
        </div>
      )}
      <div className="card-footer">
        <button className="card-action subtle" onClick={() => void cards().suspend(card.id)}>
          Suspend <kbd>s</kbd>
        </button>
      </div>
    </article>
  )
}
