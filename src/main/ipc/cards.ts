import type { Storage } from '../db/init'
import {
  acceptCard,
  discardCard,
  editCard,
  reviewCard,
  setCardLifecycle,
  undoLastReview,
} from '../review'
import { handle } from './handle'

/**
 * The Artifacts pane's channels: the two queues, and the verbs that move a card
 * between them.
 *
 * Both queues are Field-wide rather than thread-scoped (spec §4) — cards
 * outlive the reading session that produced them, and a queue that emptied
 * when you switched threads would be a queue about threads.
 */
export function registerCardIpc(storage: Storage): void {
  const { fields, flashcards } = storage.repos

  handle('cards:state', () => {
    const fieldId = fields.getDefault().id
    return {
      drafts: flashcards.listByField(fieldId, 'draft'),
      due: flashcards.listDue(fieldId),
      activeCount: flashcards.countByLifecycle(fieldId, 'active'),
    }
  })

  handle('cards:accept', ({ cardId }) => acceptCard(storage, cardId))
  handle('cards:edit', ({ cardId, front, back }) => editCard(storage, cardId, front, back))
  handle('cards:discard', ({ cardId }) => discardCard(storage, cardId))
  handle('cards:setLifecycle', ({ cardId, lifecycle }) =>
    setCardLifecycle(storage, cardId, lifecycle),
  )
  handle('cards:review', ({ cardId, rating }) => reviewCard(storage, cardId, rating))
  handle('cards:undoReview', ({ cardId }) => undoLastReview(storage, cardId))
}
