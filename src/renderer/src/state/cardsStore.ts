import { create } from 'zustand'
import type { Flashcard, ReviewRating } from '@shared/entities'
import { reportError } from './appStore'

/**
 * The Artifacts pane's state: the cull queue, the review queue, and the one
 * review that can still be taken back.
 *
 * Same philosophy as the other stores — main owns the truth, so every verb
 * re-pulls rather than patching a local copy. That matters more here than
 * elsewhere: accepting a draft moves a card *between* the two queues (an
 * accepted card is due immediately), and a local patch would have to know that.
 * Re-pulling means the queues are whatever main says they are, and it costs one
 * round trip because `cards:state` returns the whole view.
 *
 * `revealed` and `lastReview` are the only genuinely local state: one is a
 * property of the current glance at a card, the other is an offer that expires
 * when you move on.
 */

/** The undo offer standing after a grade. Carries the card's front so the
 *  offer can name what it would take back. */
export interface LastReview {
  cardId: string
  front: string
  /** Days until the card's next due date, as the scheduler set it. */
  intervalDays: number | null
}

interface CardsState {
  drafts: Flashcard[]
  due: Flashcard[]
  /** Cards in scheduling, due or not — the deck the queue is a slice of. */
  activeCount: number
  loaded: boolean
  /** The current review card's back is showing. Resets on every card change. */
  revealed: boolean
  lastReview: LastReview | null

  refresh: () => Promise<void>
  accept: (cardId: string) => Promise<void>
  edit: (cardId: string, front: string, back: string) => Promise<void>
  discard: (cardId: string) => Promise<void>
  suspend: (cardId: string) => Promise<void>
  reveal: () => void
  review: (rating: ReviewRating) => Promise<void>
  undoLastReview: () => Promise<void>
  /** Reload when main writes or removes cards on its own. Returns an unsubscribe. */
  subscribe: () => () => void
}

export const useCardsStore = create<CardsState>((set, get) => {
  /**
   * Every verb has the same shape: ask main to do it, then re-pull. The local
   * bookkeeping each one needs happens inside `call`, so it lands only when the
   * IPC succeeded — a failed grade must not leave an undo offer behind.
   */
  async function commit(call: () => Promise<unknown>): Promise<void> {
    try {
      await call()
      await get().refresh()
    } catch (err) {
      reportError(err)
    }
  }

  return {
    drafts: [],
    due: [],
    activeCount: 0,
    loaded: false,
    revealed: false,
    lastReview: null,

    refresh: async () => {
      try {
        const { drafts, due, activeCount } = await window.tangent.cards.state()
        set((s) => ({
          drafts,
          due,
          activeCount,
          loaded: true,
          // A different card in front of you is a card you haven't seen the
          // back of — otherwise the next review opens pre-revealed.
          revealed: s.revealed && s.due[0]?.id === due[0]?.id,
        }))
      } catch (err) {
        reportError(err)
      }
    },

    accept: (cardId) => commit(() => window.tangent.cards.accept(cardId)),

    edit: (cardId, front, back) => commit(() => window.tangent.cards.edit(cardId, front, back)),

    discard: (cardId) => commit(() => window.tangent.cards.discard(cardId)),

    suspend: (cardId) =>
      commit(async () => {
        await window.tangent.cards.setLifecycle(cardId, 'suspended')
        // Suspending is done from the review screen, so the offer to undo the
        // *previous* card's grade is no longer what the undo key should mean.
        set({ lastReview: null })
      }),

    reveal: () => set({ revealed: true }),

    review: (rating) => {
      const card = get().due[0]
      if (!card) return Promise.resolve()
      return commit(async () => {
        const { log } = await window.tangent.cards.review(card.id, rating)
        set({
          revealed: false,
          lastReview: { cardId: card.id, front: card.front, intervalDays: log.scheduledInterval },
        })
      })
    },

    undoLastReview: () => {
      const { lastReview } = get()
      if (!lastReview) return Promise.resolve()
      return commit(async () => {
        await window.tangent.cards.undoReview(lastReview.cardId)
        // One offer per grade: the restored card is due again, and undoing
        // twice would reach past it into a review from another session.
        set({ lastReview: null, revealed: false })
      })
    },

    subscribe: () => window.tangent.cards.onChanged(() => void get().refresh()),
  }
})
