import type { Database } from 'better-sqlite3'
import { createAnchorRepo } from './anchorRepo'
import { createConceptRepo } from './conceptRepo'
import { createDocumentRepo } from './documentRepo'
import { createEntryRepo } from './entryRepo'
import { createFieldRepo } from './fieldRepo'
import { createFlashcardRepo } from './flashcardRepo'
import { createReviewLogRepo } from './reviewLogRepo'
import { createThreadRepo } from './threadRepo'

export function createRepos(db: Database) {
  return {
    fields: createFieldRepo(db),
    documents: createDocumentRepo(db),
    threads: createThreadRepo(db),
    anchors: createAnchorRepo(db),
    entries: createEntryRepo(db),
    concepts: createConceptRepo(db),
    flashcards: createFlashcardRepo(db),
    reviewLogs: createReviewLogRepo(db),
  }
}

export type Repos = ReturnType<typeof createRepos>
