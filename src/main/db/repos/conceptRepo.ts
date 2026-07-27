import type { Database } from 'better-sqlite3'
import type { Concept, ConceptMention, ConceptStatus } from '@shared/entities'
import { newId, nowIso } from '../util'

interface ConceptRow {
  id: string
  field_id: string
  canonical_text: string
  embedding: Buffer | null
  embedding_model: string | null
  status: ConceptStatus
  merged_into_id: string | null
  created_at: string
  updated_at: string
}

interface MentionRow {
  id: string
  concept_id: string
  entry_id: string | null
  anchor_id: string | null
  created_at: string
}

function embeddingToBlob(e: Float32Array): Buffer {
  return Buffer.from(e.buffer, e.byteOffset, e.byteLength)
}

function blobToEmbedding(b: Buffer): Float32Array {
  // Copy: SQLite buffers aren't guaranteed 4-byte-aligned, which Float32Array requires.
  const bytes = new Uint8Array(b.byteLength)
  bytes.set(b)
  return new Float32Array(bytes.buffer)
}

function toConcept(r: ConceptRow): Concept {
  return {
    id: r.id,
    fieldId: r.field_id,
    canonicalText: r.canonical_text,
    embedding: r.embedding ? blobToEmbedding(r.embedding) : null,
    embeddingModel: r.embedding_model,
    status: r.status,
    mergedIntoId: r.merged_into_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function toMention(r: MentionRow): ConceptMention {
  return {
    id: r.id,
    conceptId: r.concept_id,
    entryId: r.entry_id,
    anchorId: r.anchor_id,
    createdAt: r.created_at,
  }
}

export interface CreateConceptInput {
  fieldId: string
  canonicalText: string
  embedding?: Float32Array
  embeddingModel?: string
}

export interface AddMentionInput {
  conceptId: string
  /** Nullable rather than optional, matching the columns — one of the two must
   *  be set (CHECK-enforced), but callers that carry both slots pass both. */
  entryId?: string | null
  anchorId?: string | null
}

export function createConceptRepo(db: Database) {
  const insert = db.prepare(
    `INSERT INTO concept (id, field_id, canonical_text, embedding, embedding_model, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
  )
  const byId = db.prepare('SELECT * FROM concept WHERE id = ?')
  const activeByField = db.prepare(
    `SELECT * FROM concept WHERE field_id = ? AND status = 'active' ORDER BY created_at, rowid`,
  )
  const insertMention = db.prepare(
    `INSERT INTO concept_mention (id, concept_id, entry_id, anchor_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
  const mentionById = db.prepare('SELECT * FROM concept_mention WHERE id = ?')
  const mentionsByConcept = db.prepare(
    'SELECT * FROM concept_mention WHERE concept_id = ? ORDER BY created_at, rowid',
  )
  // `IS` rather than `=`: either source column may be NULL, and NULL = NULL
  // isn't true in SQL.
  const mentionBySource = db.prepare(
    'SELECT * FROM concept_mention WHERE concept_id = ? AND entry_id IS ? AND anchor_id IS ?',
  )
  const deleteMentionStmt = db.prepare('DELETE FROM concept_mention WHERE id = ?')
  const deleteConceptStmt = db.prepare('DELETE FROM concept WHERE id = ?')
  const markMerged = db.prepare(
    `UPDATE concept SET status = 'merged', merged_into_id = ?, updated_at = ? WHERE id = ?`,
  )
  // A card may already reference the survivor; OR IGNORE skips those rows and
  // the DELETE cleans up what's left, so re-pointing never violates the PK.
  const repointCards = db.prepare(
    'UPDATE OR IGNORE flashcard_concept SET concept_id = ? WHERE concept_id = ?',
  )
  const dropOldCardLinks = db.prepare('DELETE FROM flashcard_concept WHERE concept_id = ?')
  const mergeTx = db.transaction((id: string, intoId: string) => {
    repointCards.run(intoId, id)
    dropOldCardLinks.run(id)
    markMerged.run(intoId, nowIso(), id)
  })

  function get(id: string): Concept | null {
    const row = byId.get(id) as ConceptRow | undefined
    return row ? toConcept(row) : null
  }

  return {
    create(input: CreateConceptInput): Concept {
      const id = newId()
      const now = nowIso()
      insert.run(
        id,
        input.fieldId,
        input.canonicalText,
        input.embedding ? embeddingToBlob(input.embedding) : null,
        input.embeddingModel ?? null,
        now,
        now,
      )
      return get(id)!
    },

    getById: get,

    /** The dedup candidate set: all active concepts (with embeddings) in a Field. */
    listActiveByField(fieldId: string): Concept[] {
      return (activeByField.all(fieldId) as ConceptRow[]).map(toConcept)
    },

    addMention(input: AddMentionInput): ConceptMention {
      const id = newId()
      insertMention.run(
        id,
        input.conceptId,
        input.entryId ?? null,
        input.anchorId ?? null,
        nowIso(),
      )
      return toMention(mentionById.get(id) as MentionRow)
    },

    mentionsFor(conceptId: string): ConceptMention[] {
      return (mentionsByConcept.all(conceptId) as MentionRow[]).map(toMention)
    },

    /** Provenance is a set, not a log: re-extracting an edited note that still
     *  argues the same thing shouldn't stack identical rows. Extraction checks
     *  here before writing a mention. */
    findMention(
      conceptId: string,
      entryId: string | null,
      anchorId: string | null,
    ): ConceptMention | null {
      const row = mentionBySource.get(conceptId, entryId, anchorId) as MentionRow | undefined
      return row ? toMention(row) : null
    },

    /** Undo support (spec §7): the extraction chip reverses the transaction it
     *  just committed. Only ever called on rows that same batch created, which
     *  is what makes a hard delete safe here — and the flashcard_concept FK
     *  turns "delete a concept a card already cites" into an error rather than
     *  a dangling card. */
    deleteMention(id: string): void {
      deleteMentionStmt.run(id)
    },

    delete(id: string): void {
      deleteConceptStmt.run(id)
    },

    /** Merge `id` into `intoId`: re-points flashcard links to the survivor and
     *  marks the loser merged. Card content is never touched (spec §2).
     *  Mentions stay on the merged concept as historical record. */
    merge(id: string, intoId: string): void {
      mergeTx(id, intoId)
    },
  }
}

export type ConceptRepo = ReturnType<typeof createConceptRepo>
