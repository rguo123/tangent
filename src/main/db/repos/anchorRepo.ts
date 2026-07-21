import type { Database } from 'better-sqlite3'
import type { Anchor, TextQuoteSelector } from '@shared/entities'
import { newId, nowIso } from '../util'

interface AnchorRow {
  id: string
  thread_id: string
  document_id: string
  selector: string
  created_at: string
}

function toAnchor(r: AnchorRow): Anchor {
  return {
    id: r.id,
    threadId: r.thread_id,
    documentId: r.document_id,
    selector: JSON.parse(r.selector) as TextQuoteSelector,
    createdAt: r.created_at,
  }
}

export interface CreateAnchorInput {
  threadId: string
  documentId: string
  selector: TextQuoteSelector
}

export function createAnchorRepo(db: Database) {
  const insert = db.prepare(
    `INSERT INTO anchor (id, thread_id, document_id, selector, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
  const byId = db.prepare('SELECT * FROM anchor WHERE id = ?')
  const byThread = db.prepare('SELECT * FROM anchor WHERE thread_id = ? ORDER BY created_at, rowid')

  function get(id: string): Anchor | null {
    const row = byId.get(id) as AnchorRow | undefined
    return row ? toAnchor(row) : null
  }

  return {
    create(input: CreateAnchorInput): Anchor {
      const id = newId()
      insert.run(id, input.threadId, input.documentId, JSON.stringify(input.selector), nowIso())
      return get(id)!
    },

    getById: get,

    listByThread(threadId: string): Anchor[] {
      return (byThread.all(threadId) as AnchorRow[]).map(toAnchor)
    },
  }
}

export type AnchorRepo = ReturnType<typeof createAnchorRepo>
