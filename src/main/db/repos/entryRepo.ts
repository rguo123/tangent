import type { Database } from 'better-sqlite3'
import type { Entry, EntryKind } from '@shared/entities'
import { newId, nowIso } from '../util'

interface EntryRow {
  id: string
  thread_id: string
  anchor_id: string | null
  parent_entry_id: string | null
  kind: EntryKind
  body: string
  pinned: number
  created_at: string
  updated_at: string
  extracted_at: string | null
}

function toEntry(r: EntryRow): Entry {
  return {
    id: r.id,
    threadId: r.thread_id,
    anchorId: r.anchor_id,
    parentEntryId: r.parent_entry_id,
    kind: r.kind,
    body: r.body,
    pinned: r.pinned !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    extractedAt: r.extracted_at,
  }
}

export interface CreateEntryInput {
  threadId: string
  kind: EntryKind
  body: string
  anchorId?: string
  parentEntryId?: string
}

export function createEntryRepo(db: Database) {
  const insert = db.prepare(
    `INSERT INTO entry (id, thread_id, anchor_id, parent_entry_id, kind, body, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  )
  const byId = db.prepare('SELECT * FROM entry WHERE id = ?')
  const byThread = db.prepare('SELECT * FROM entry WHERE thread_id = ? ORDER BY created_at, rowid')
  const updateBodyStmt = db.prepare('UPDATE entry SET body = ?, updated_at = ? WHERE id = ?')
  const updatePinned = db.prepare('UPDATE entry SET pinned = ? WHERE id = ?')
  const due = db.prepare(
    `SELECT * FROM entry
     WHERE thread_id = ? AND (extracted_at IS NULL OR extracted_at < updated_at)
     ORDER BY created_at, rowid`,
  )
  const stamp = db.prepare('UPDATE entry SET extracted_at = ? WHERE id = ?')
  const stampAll = db.transaction((ids: string[], at: string) => {
    for (const id of ids) stamp.run(at, id)
  })

  function get(id: string): Entry | null {
    const row = byId.get(id) as EntryRow | undefined
    return row ? toEntry(row) : null
  }

  return {
    create(input: CreateEntryInput): Entry {
      const id = newId()
      const now = nowIso()
      insert.run(
        id,
        input.threadId,
        input.anchorId ?? null,
        input.parentEntryId ?? null,
        input.kind,
        input.body,
        now,
        now,
      )
      return get(id)!
    },

    getById: get,

    listByThread(threadId: string): Entry[] {
      return (byThread.all(threadId) as EntryRow[]).map(toEntry)
    },

    /** `at` is injectable so callers/tests can guarantee watermark ordering. */
    updateBody(id: string, body: string, at: string = nowIso()): void {
      updateBodyStmt.run(body, at, id)
    },

    setPinned(id: string, pinned: boolean): void {
      updatePinned.run(pinned ? 1 : 0, id)
    },

    /** The §5.1 watermark query: never extracted, or edited since last extraction. */
    dueForExtraction(threadId: string): Entry[] {
      return (due.all(threadId) as EntryRow[]).map(toEntry)
    },

    markExtracted(ids: string[], at: string = nowIso()): void {
      stampAll(ids, at)
    },

    /** Watermark writes one entry at a time, `null` included — undoing an
     *  extraction has to put back the timestamp each entry had before it, which
     *  for a first extraction is no timestamp at all. */
    setExtractedAt(id: string, at: string | null): void {
      stamp.run(at, id)
    },
  }
}

export type EntryRepo = ReturnType<typeof createEntryRepo>
