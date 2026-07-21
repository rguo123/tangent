import type { Database } from 'better-sqlite3'
import type { Thread, ThreadStatus } from '@shared/entities'
import { newId, nowIso } from '../util'

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
  const byField = db.prepare('SELECT * FROM thread WHERE field_id = ? ORDER BY created_at DESC, rowid DESC')
  const byFieldAndStatus = db.prepare(
    'SELECT * FROM thread WHERE field_id = ? AND status = ? ORDER BY created_at DESC, rowid DESC',
  )
  const updateStatus = db.prepare('UPDATE thread SET status = ? WHERE id = ?')

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

    setStatus(id: string, status: ThreadStatus): void {
      updateStatus.run(status, id)
    },
  }
}

export type ThreadRepo = ReturnType<typeof createThreadRepo>
