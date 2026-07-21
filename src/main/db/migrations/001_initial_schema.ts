/**
 * Migration 001 — the entire Phase-0 data model (spec §2) in one pass.
 *
 * Conventions:
 *  - TEXT UUID primary keys, generated in the app layer.
 *  - Timestamps are ISO-8601 TEXT with millisecond precision (lexicographic
 *    order = chronological order), generated in the app layer.
 *  - Booleans are INTEGER 0/1.
 *  - `flashcard.concept_ids` is the `flashcard_concept` join table so concept
 *    merges re-point cards with an UPDATE, not a JSON rewrite.
 */
export const sql = `
CREATE TABLE field (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE document (
  id          TEXT NOT NULL PRIMARY KEY,
  field_id    TEXT NOT NULL REFERENCES field(id),
  title       TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('pdf', 'markdown', 'generated', 'chat_transcript')),
  -- File path (pdf) or content blob (markdown/generated); a chat_transcript's
  -- content is the owning thread's message log, so its ref is NULL — and only its.
  content_ref TEXT,
  created_at  TEXT NOT NULL,
  CHECK ((source_type = 'chat_transcript') = (content_ref IS NULL))
);
CREATE INDEX idx_document_field ON document(field_id);

CREATE TABLE thread (
  id               TEXT NOT NULL PRIMARY KEY,
  field_id         TEXT NOT NULL REFERENCES field(id),
  -- Never NULL (spec §3.3): exploration threads get a chat_transcript document.
  document_id      TEXT NOT NULL REFERENCES document(id),
  parent_thread_id TEXT REFERENCES thread(id),
  title            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_thread_field ON thread(field_id, status);

CREATE TABLE anchor (
  id          TEXT NOT NULL PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES thread(id),
  -- Kept alongside thread_id deliberately — the seam for multi-document threads.
  document_id TEXT NOT NULL REFERENCES document(id),
  -- JSON: text-quote selector (or message-id range for chat_transcript).
  selector    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_anchor_thread ON anchor(thread_id);

CREATE TABLE entry (
  id              TEXT NOT NULL PRIMARY KEY,
  thread_id       TEXT NOT NULL REFERENCES thread(id),
  anchor_id       TEXT REFERENCES anchor(id),
  -- Links an ai_response to its question; chronology alone is ambiguous.
  parent_entry_id TEXT REFERENCES entry(id),
  kind            TEXT NOT NULL CHECK (kind IN ('note', 'question', 'ai_response')),
  body            TEXT NOT NULL,
  pinned          INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  -- Extraction watermark (spec §5.1): due when NULL or < updated_at.
  extracted_at    TEXT
);
CREATE INDEX idx_entry_thread ON entry(thread_id, created_at);

CREATE TABLE concept (
  id              TEXT NOT NULL PRIMARY KEY,
  field_id        TEXT NOT NULL REFERENCES field(id),
  canonical_text  TEXT NOT NULL,
  -- Float32Array bytes; brute-force cosine in JS, no vector extension (spec §3).
  embedding       BLOB,
  embedding_model TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged')),
  merged_into_id  TEXT REFERENCES concept(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK ((status = 'merged') = (merged_into_id IS NOT NULL))
);
CREATE INDEX idx_concept_field ON concept(field_id, status);

CREATE TABLE concept_mention (
  id         TEXT NOT NULL PRIMARY KEY,
  concept_id TEXT NOT NULL REFERENCES concept(id),
  entry_id   TEXT REFERENCES entry(id),
  anchor_id  TEXT REFERENCES anchor(id),
  created_at TEXT NOT NULL,
  -- Both source paths are load-bearing: notes/pins carry entry_id, anchored
  -- document quotes carry anchor_id only.
  CHECK (entry_id IS NOT NULL OR anchor_id IS NOT NULL)
);
CREATE INDEX idx_concept_mention_concept ON concept_mention(concept_id);

CREATE TABLE flashcard (
  id               TEXT NOT NULL PRIMARY KEY,
  field_id         TEXT NOT NULL REFERENCES field(id),
  front            TEXT NOT NULL,
  back             TEXT NOT NULL,
  card_type        TEXT NOT NULL CHECK (card_type IN ('recall', 'relationship')),
  lifecycle        TEXT NOT NULL DEFAULT 'draft' CHECK (lifecycle IN ('draft', 'active', 'suspended')),
  user_edited      INTEGER NOT NULL DEFAULT 0,
  -- FSRS scheduling state; all NULL until the card is accepted (draft -> active).
  stability        REAL,
  difficulty       REAL,
  due_at           TEXT,
  last_reviewed_at TEXT,
  state            INTEGER CHECK (state IN (0, 1, 2, 3)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  -- Scheduling columns are coherent: all set together when the card enters
  -- FSRS, all NULL before that (last_reviewed_at may stay NULL until the
  -- first review, but never exists without the rest).
  CHECK (
    (state IS NULL) = (stability IS NULL)
    AND (state IS NULL) = (difficulty IS NULL)
    AND (state IS NULL) = (due_at IS NULL)
    AND (state IS NOT NULL OR last_reviewed_at IS NULL)
  )
);
CREATE INDEX idx_flashcard_field ON flashcard(field_id, lifecycle);
CREATE INDEX idx_flashcard_due ON flashcard(lifecycle, due_at);

CREATE TABLE flashcard_concept (
  flashcard_id TEXT NOT NULL REFERENCES flashcard(id),
  concept_id   TEXT NOT NULL REFERENCES concept(id),
  PRIMARY KEY (flashcard_id, concept_id)
);
CREATE INDEX idx_flashcard_concept_concept ON flashcard_concept(concept_id);

CREATE TABLE review_log (
  id                    TEXT NOT NULL PRIMARY KEY,
  flashcard_id          TEXT NOT NULL REFERENCES flashcard(id),
  rating                INTEGER NOT NULL CHECK (rating IN (1, 2, 3, 4)),
  reviewed_at           TEXT NOT NULL,
  -- Days until the next due date the scheduler assigned.
  scheduled_interval    REAL,
  -- Pre-review FSRS state, for undo-last-review; NULL prev_state means the
  -- card had never been scheduled (first review of a just-accepted card
  -- carries state 0 instead, so in practice these are always set).
  prev_stability        REAL,
  prev_difficulty       REAL,
  prev_due_at           TEXT,
  prev_last_reviewed_at TEXT,
  prev_state            INTEGER CHECK (prev_state IN (0, 1, 2, 3)),
  -- Append-only: undo flags the row rather than deleting it.
  undone                INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_review_log_flashcard ON review_log(flashcard_id, reviewed_at);
`
