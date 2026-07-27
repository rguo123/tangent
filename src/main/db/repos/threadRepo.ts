import type { Database } from 'better-sqlite3'
import type { SourceType, Thread, ThreadStatus } from '@shared/entities'
import type { ThreadListItem } from '@shared/ipc'
import { newId, nowIso } from '../util'
import { toDocument } from './documentRepo'

interface ThreadRow {
  id: string
  field_id: string
  document_id: string
  parent_thread_id: string | null
  title: string
  status: ThreadStatus
  created_at: string
}

function toThread(r: ThreadRow): Thread {
  return {
    id: r.id,
    fieldId: r.field_id,
    documentId: r.document_id,
    parentThreadId: r.parent_thread_id,
    title: r.title,
    status: r.status,
    createdAt: r.created_at,
  }
}

type ThreadWithDocumentRow = ThreadRow & {
  doc_id: string
  doc_field_id: string
  doc_title: string
  doc_source_type: SourceType
  doc_content_ref: string | null
  doc_source_url: string | null
  doc_created_at: string
}

export interface CreateThreadInput {
  fieldId: string
  documentId: string
  title: string
  parentThreadId?: string
}

export function createThreadRepo(db: Database) {
  const insert = db.prepare(
    `INSERT INTO thread (id, field_id, document_id, parent_thread_id, title, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`,
  )
  const byId = db.prepare('SELECT * FROM thread WHERE id = ?')
  const byField = db.prepare(
    'SELECT * FROM thread WHERE field_id = ? ORDER BY created_at DESC, rowid DESC',
  )
  const byFieldAndStatus = db.prepare(
    'SELECT * FROM thread WHERE field_id = ? AND status = ? ORDER BY created_at DESC, rowid DESC',
  )
  const updateStatus = db.prepare('UPDATE thread SET status = ? WHERE id = ?')
  const byFieldWithDocument = db.prepare(
    `SELECT t.*,
            d.id AS doc_id, d.field_id AS doc_field_id, d.title AS doc_title,
            d.source_type AS doc_source_type, d.content_ref AS doc_content_ref,
            d.source_url AS doc_source_url, d.created_at AS doc_created_at
     FROM thread t JOIN document d ON d.id = t.document_id
     WHERE t.field_id = ?
     ORDER BY t.created_at DESC, t.rowid DESC`,
  )

  function get(id: string): Thread | null {
    const row = byId.get(id) as ThreadRow | undefined
    return row ? toThread(row) : null
  }

  return {
    create(input: CreateThreadInput): Thread {
      const id = newId()
      insert.run(
        id,
        input.fieldId,
        input.documentId,
        input.parentThreadId ?? null,
        input.title,
        nowIso(),
      )
      return get(id)!
    },

    getById: get,

    listByField(fieldId: string, status?: ThreadStatus): Thread[] {
      const rows = status ? byFieldAndStatus.all(fieldId, status) : byField.all(fieldId)
      return (rows as ThreadRow[]).map(toThread)
    },

    /** The sidebar's read model: every thread joined with its document. */
    listByFieldWithDocument(fieldId: string): ThreadListItem[] {
      return (byFieldWithDocument.all(fieldId) as ThreadWithDocumentRow[]).map((r) => ({
        thread: toThread(r),
        document: toDocument({
          id: r.doc_id,
          field_id: r.doc_field_id,
          title: r.doc_title,
          source_type: r.doc_source_type,
          content_ref: r.doc_content_ref,
          source_url: r.doc_source_url,
          created_at: r.doc_created_at,
        }),
      }))
    },

    setStatus(id: string, status: ThreadStatus): void {
      updateStatus.run(status, id)
    },
  }
}

export type ThreadRepo = ReturnType<typeof createThreadRepo>
