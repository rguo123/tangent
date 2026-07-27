/**
 * Migration 003 — where a Document came from.
 *
 * Web clips are stored as `markdown` documents: once the article has been
 * extracted, that is exactly what they are, and reusing the type gets them the
 * whole render / anchor / agent-context path for free. What that loses is
 * provenance, which this column gives back — the original URL, for the badge,
 * the "open original" affordance, and to mark which documents own an assets
 * directory under `documents/<id>/`.
 *
 * Null for everything imported from a file, which is why this is a plain ADD
 * COLUMN rather than a `source_type` value: adding one would mean rebuilding
 * the table to widen a CHECK, and `thread` and `anchor` both reference it.
 */
export const sql = `
ALTER TABLE document ADD COLUMN source_url TEXT;
`
