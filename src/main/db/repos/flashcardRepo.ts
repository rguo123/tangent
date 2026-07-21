import type { Database } from 'better-sqlite3'
import type { CardLifecycle, CardType, Flashcard, FsrsScheduling, FsrsState } from '@shared/entities'
import { newId, nowIso, schedulingFrom } from '../util'

interface FlashcardRow {
  id: string
  field_id: string
  front: string
  back: string
  card_type: CardType
  lifecycle: CardLifecycle
  user_edited: number
  stability: number | null
  difficulty: number | null
  due_at: string | null
  last_reviewed_at: string | null
  state: FsrsState | null
  created_at: string
  updated_at: string
}

export interface CreateFlashcardInput {
  fieldId: string
  conceptIds: string[]
  front: string
  back: string
  cardType: CardType
}

export function createFlashcardRepo(db: Database) {
  const insert = db.prepare(
    `INSERT INTO flashcard (id, field_id, front, back, card_type, lifecycle, user_edited, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', 0, ?, ?)`,
  )
  const insertLink = db.prepare(
    'INSERT INTO flashcard_concept (flashcard_id, concept_id) VALUES (?, ?)',
  )
  const byId = db.prepare('SELECT * FROM flashcard WHERE id = ?')
  const byField = db.prepare('SELECT * FROM flashcard WHERE field_id = ? ORDER BY created_at, rowid')
  const byFieldAndLifecycle = db.prepare(
    'SELECT * FROM flashcard WHERE field_id = ? AND lifecycle = ? ORDER BY created_at, rowid',
  )
  const dueByField = db.prepare(
    `SELECT * FROM flashcard
     WHERE field_id = ? AND lifecycle = 'active' AND due_at <= ?
     ORDER BY due_at, rowid`,
  )
  const conceptIdsFor = db.prepare(
    'SELECT concept_id FROM flashcard_concept WHERE flashcard_id = ? ORDER BY concept_id',
  )
  const linksByField = db.prepare(
    `SELECT fc.flashcard_id, fc.concept_id
     FROM flashcard_concept fc JOIN flashcard f ON f.id = fc.flashcard_id
     WHERE f.field_id = ?
     ORDER BY fc.concept_id`,
  )
  // MAX keeps an existing user_edited flag when the third param is 0.
  const updateContentStmt = db.prepare(
    'UPDATE flashcard SET front = ?, back = ?, user_edited = MAX(user_edited, ?), updated_at = ? WHERE id = ?',
  )
  const updateLifecycle = db.prepare(
    'UPDATE flashcard SET lifecycle = ?, updated_at = ? WHERE id = ?',
  )
  const updateSchedulingStmt = db.prepare(
    `UPDATE flashcard
     SET stability = ?, difficulty = ?, due_at = ?, last_reviewed_at = ?, state = ?, updated_at = ?
     WHERE id = ?`,
  )
  const deleteLinks = db.prepare('DELETE FROM flashcard_concept WHERE flashcard_id = ?')
  const deleteCard = db.prepare('DELETE FROM flashcard WHERE id = ?')
  const createTx = db.transaction((input: CreateFlashcardInput, id: string, now: string) => {
    insert.run(id, input.fieldId, input.front, input.back, input.cardType, now, now)
    for (const conceptId of input.conceptIds) insertLink.run(id, conceptId)
  })
  const removeTx = db.transaction((id: string) => {
    deleteLinks.run(id)
    deleteCard.run(id)
  })

  function toFlashcard(r: FlashcardRow, conceptIds: string[]): Flashcard {
    return {
      id: r.id,
      fieldId: r.field_id,
      conceptIds,
      front: r.front,
      back: r.back,
      cardType: r.card_type,
      lifecycle: r.lifecycle,
      userEdited: r.user_edited !== 0,
      scheduling: schedulingFrom(r.stability, r.difficulty, r.due_at, r.last_reviewed_at, r.state),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  }

  function get(id: string): Flashcard | null {
    const row = byId.get(id) as FlashcardRow | undefined
    if (!row) return null
    const conceptIds = (conceptIdsFor.all(id) as { concept_id: string }[]).map((x) => x.concept_id)
    return toFlashcard(row, conceptIds)
  }

  /** Map a list with one field-wide links query instead of a per-card lookup. */
  function mapAll(rows: FlashcardRow[], fieldId: string): Flashcard[] {
    const byCard = new Map<string, string[]>()
    for (const l of linksByField.all(fieldId) as { flashcard_id: string; concept_id: string }[]) {
      const ids = byCard.get(l.flashcard_id)
      if (ids) ids.push(l.concept_id)
      else byCard.set(l.flashcard_id, [l.concept_id])
    }
    return rows.map((r) => toFlashcard(r, byCard.get(r.id) ?? []))
  }

  return {
    /** Cards are born draft (spec §5.2) with no FSRS state. */
    create(input: CreateFlashcardInput): Flashcard {
      const id = newId()
      createTx(input, id, nowIso())
      return get(id)!
    },

    getById: get,

    listByField(fieldId: string, lifecycle?: CardLifecycle): Flashcard[] {
      const rows = lifecycle ? byFieldAndLifecycle.all(fieldId, lifecycle) : byField.all(fieldId)
      return mapAll(rows as FlashcardRow[], fieldId)
    },

    /** The Field-wide review queue (spec §4: whole Field, not current thread). */
    listDue(fieldId: string, now: string = nowIso()): Flashcard[] {
      return mapAll(dueByField.all(fieldId, now) as FlashcardRow[], fieldId)
    },

    /** A user edit to front/back — marks the card user_edited, permanently
     *  shielding it from regeneration (spec §2). */
    updateContent(id: string, front: string, back: string): void {
      updateContentStmt.run(front, back, 1, nowIso(), id)
    },

    /** A machine rewrite (regeneration) — leaves user_edited untouched, so
     *  regenerating a pristine card doesn't fake a user edit. Callers must
     *  still skip user-edited cards per spec; the flag survives either way. */
    replaceContent(id: string, front: string, back: string): void {
      updateContentStmt.run(front, back, 0, nowIso(), id)
    },

    setLifecycle(id: string, lifecycle: CardLifecycle): void {
      updateLifecycle.run(lifecycle, nowIso(), id)
    },

    /** Pass null to clear scheduling — undoing the first-ever review restores
     *  the pre-FSRS state. */
    updateScheduling(id: string, s: FsrsScheduling | null): void {
      updateSchedulingStmt.run(
        s?.stability ?? null,
        s?.difficulty ?? null,
        s?.dueAt ?? null,
        s?.lastReviewedAt ?? null,
        s?.state ?? null,
        nowIso(),
        id,
      )
    },

    /** Discard (cull pass): removes the card and its concept links. Reviewed
     *  cards are protected by the review_log FK — only unreviewed cards can go. */
    remove(id: string): void {
      removeTx(id)
    },
  }
}

export type FlashcardRepo = ReturnType<typeof createFlashcardRepo>
