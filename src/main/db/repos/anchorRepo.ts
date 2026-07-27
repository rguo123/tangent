import type { Database } from 'better-sqlite3'
import type { Anchor, TextQuoteSelector } from '@shared/entities'
import { newId, nowIso } from '../util'

interface AnchorRow {
  id: string
  thread_id: string
  document_id: string
  selector: string
  created_at: string
  extracted_at: string | null
}

function toAnchor(r: AnchorRow): Anchor {
  return {
    id: r.id,
    threadId: r.thread_id,
    documentId: r.document_id,
    selector: JSON.parse(r.selector) as TextQuoteSelector,
    createdAt: r.created_at,
    extractedAt: r.extracted_at,
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
  // Same shape as the entry watermark: due means "not read yet", not "produced
  // nothing". The NOT EXISTS clause that remains is a different rule — an
  // anchored note reaches extraction through *its entry*, so the anchor must
  // not enter a second time on its own.
  const dueOrphans = db.prepare(
    `SELECT a.* FROM anchor a
     WHERE a.thread_id = ? AND a.extracted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM entry e WHERE e.anchor_id = a.id)
     ORDER BY a.created_at, a.rowid`,
  )
  const stamp = db.prepare('UPDATE anchor SET extracted_at = ? WHERE id = ?')

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

    /** Highlights with nothing written about them (spec §5.1: a highlight with
     *  no note is still engagement). Anchors that *do* have an entry ride along
     *  with that entry's watermark instead. */
    dueForExtraction(threadId: string): Anchor[] {
      return (dueOrphans.all(threadId) as AnchorRow[]).map(toAnchor)
    },

    /** `null` restores an anchor to due — what an extraction undo needs. */
    setExtractedAt(id: string, at: string | null): void {
      stamp.run(at, id)
    },
  }
}

export type AnchorRepo = ReturnType<typeof createAnchorRepo>
