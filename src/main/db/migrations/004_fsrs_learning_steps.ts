/**
 * Migration 004 — the one piece of FSRS card state the original schema missed.
 *
 * `ts-fsrs` keeps short-term (re)learning steps as an index into the configured
 * step list, and it reads that index back on the *next* review to decide whether
 * the card advances a step or graduates to Review. The five columns in 001
 * (stability, difficulty, due, last_reviewed, state) round-trip everything the
 * long-term algorithm needs, but not this — and a card whose step index resets
 * to 0 on every load never graduates: each Good lands it on the same 10-minute
 * step forever.
 *
 * So it is stored, on both sides: on the card, and on the review_log row that
 * undo restores from. The scheduler's other counters (`reps`, `lapses`,
 * `scheduled_days`, `elapsed_days`) are outputs it recomputes or never reads
 * back, and are deliberately not persisted.
 */
export const sql = `
ALTER TABLE flashcard ADD COLUMN learning_steps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE review_log ADD COLUMN prev_learning_steps INTEGER;
`
