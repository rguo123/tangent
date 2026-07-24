import type { Database } from 'better-sqlite3'
import type { Field } from '@shared/entities'
import { newId, nowIso } from '../util'

interface FieldRow {
  id: string
  name: string
  created_at: string
}

function toField(r: FieldRow): Field {
  return { id: r.id, name: r.name, createdAt: r.created_at }
}

export function createFieldRepo(db: Database) {
  const insert = db.prepare('INSERT INTO field (id, name, created_at) VALUES (?, ?, ?)')
  const byId = db.prepare('SELECT * FROM field WHERE id = ?')
  const all = db.prepare('SELECT * FROM field ORDER BY created_at, rowid')

  function get(id: string): Field | null {
    const row = byId.get(id) as FieldRow | undefined
    return row ? toField(row) : null
  }

  function list(): Field[] {
    return (all.all() as FieldRow[]).map(toField)
  }

  return {
    create(name: string): Field {
      const id = newId()
      insert.run(id, name, nowIso())
      return get(id)!
    },

    getById: get,

    list,

    /** The Field everything hangs off while the MVP is single-Field: the
     *  oldest row, seeded by initStorage. */
    getDefault(): Field {
      const field = list()[0]
      if (!field) throw new Error('No Field exists — initStorage seeds one, so this is a bug')
      return field
    },
  }
}

export type FieldRepo = ReturnType<typeof createFieldRepo>
