/**
 * Migration 002 — extraction's reads (spec §5.1).
 *
 * `anchor.extracted_at` makes highlights work the way entries already do: a
 * watermark records that extraction *read* the input, not that it got a concept
 * out of it. Deriving due-ness from "has no mention yet" instead — which is what
 * this replaces — meant a highlight the model declined to extract from was
 * re-sent on every run, forever.
 *
 * An anchor is immutable, so unlike an entry its watermark is only ever set
 * once (or cleared, by an extraction undo). It carries no `updated_at` to
 * outrun.
 *
 * The two indexes serve the other half of the same query — anchors are matched
 * against `entry.anchor_id` and `concept_mention.anchor_id`, neither of which
 * was reachable by an index, so each unnoted highlight cost a full scan of both
 * tables on the main process.
 */
export const sql = `
ALTER TABLE anchor ADD COLUMN extracted_at TEXT;

CREATE INDEX idx_entry_anchor ON entry(anchor_id);
CREATE INDEX idx_concept_mention_anchor ON concept_mention(anchor_id);
`
