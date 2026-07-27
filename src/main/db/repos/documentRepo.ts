import type { Database } from 'better-sqlite3'
import type { Document, SourceType } from '@shared/entities'
import { newId, nowIso } from '../util'

export interface DocumentRow {
  id: string
  field_id: string
  title: string
  source_type: SourceType
  content_ref: string | null
  source_url: string | null
  created_at: string
}

export function toDocument(r: DocumentRow): Document {
  return {
    id: r.id,
    fieldId: r.field_id,
    title: r.title,
    sourceType: r.source_type,
    contentRef: r.content_ref,
    sourceUrl: r.source_url,
    createdAt: r.created_at,
  }
}

export interface CreateDocumentInput {
  /** Caller-supplied when the id must exist before the row (a PDF is copied to
   *  documents/<id>.pdf before insert); generated otherwise. */
  id?: string
  fieldId: string
  title: string
  sourceType: SourceType
  /** Required for pdf/markdown/generated; must be null for chat_transcript (CHECK-enforced). */
  contentRef: string | null
  /** Set only by web import — the URL the content was clipped from. */
  sourceUrl?: string | null
}

export function createDocumentRepo(db: Database) {
  const insert = db.prepare(
    `INSERT INTO document (id, field_id, title, source_type, content_ref, source_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const byId = db.prepare('SELECT * FROM document WHERE id = ?')
  const byField = db.prepare('SELECT * FROM document WHERE field_id = ? ORDER BY created_at, rowid')

  function get(id: string): Document | null {
    const row = byId.get(id) as DocumentRow | undefined
    return row ? toDocument(row) : null
  }

  return {
    create(input: CreateDocumentInput): Document {
      const id = input.id ?? newId()
      insert.run(
        id,
        input.fieldId,
        input.title,
        input.sourceType,
        input.contentRef,
        input.sourceUrl ?? null,
        nowIso(),
      )
      return get(id)!
    },

    getById: get,

    listByField(fieldId: string): Document[] {
      return (byField.all(fieldId) as DocumentRow[]).map(toDocument)
    },
  }
}

export type DocumentRepo = ReturnType<typeof createDocumentRepo>
