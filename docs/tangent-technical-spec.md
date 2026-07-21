# Tangent — Technical Spec

**Status:** Revised after design review (2026-07-21)
**Scope of this version:** Flashcards only as the artifact type. Knowledge graph, quiz mode, and other artifact views are explicitly out of scope until a later phase.

---

## 1. Purpose

Tangent is a desktop app for building genuine expertise in a field, not just archiving notes about it. It unifies reading a source, talking to an AI about it, and taking notes into one interaction, and turns the accumulated understanding into spaced-repetition review material. The design center is the **agent layer** — extraction, branching, and card generation should be doing real work, not just wrapping a chat completion.

Non-goals: this is not a general-purpose PKM tool. It does not map an entire document library or vault. Every session happens inside a bounded **Field**, and the app has no notion of "all your knowledge" — only "what you're actively building expertise in."

---

## 2. Core data model

Five entities. Everything else in the app is a view over these.

### Field
A bounded domain of study (e.g. "Distributed systems for interviews").
- `id`, `name`, `created_at`
- All Threads, Documents, and Concepts below are scoped to exactly one Field.

### Document
A content object. Not owned by any single Thread.
- `id`, `field_id`, `title`
- `source_type`: `pdf | markdown | generated | chat_transcript`
- `content_ref`: file path (pdf) or content blob (markdown/generated), null for `chat_transcript` (content lives in the owning Thread's message log)
- `created_at`

**Documents are immutable after import.** PDFs already are; markdown and generated documents get the same treatment — "editing" a source means importing a new Document. This is what makes text-quote Anchors safe: an anchor can never orphan, so no `resolved/orphaned` state machine or re-anchoring pass is needed. If mutable sources ever become necessary, that machinery gets added then.

Imported PDFs are **copied into an app-managed data directory**, not referenced in place — path references break silently when files move, and one folder holding DB + documents makes backup a copy command.

A Document can be referenced by more than one Thread (e.g. two different Threads each covering a different section of the same paper). A `chat_transcript` Document is self-referential — its "content" is the live conversation of the one Thread it belongs to (see §3.3).

### Thread
A single investigation: one Document, one working view into it, one notes+chat timeline.
- `id`, `field_id`, `document_id` (required, never null — see §3.3), `parent_thread_id` (nullable — branch lineage)
- `title`, `created_at`, `status` (`active | archived`)

### Anchor
The join between a Thread and the region of its Document it's working with.
- `id`, `thread_id`, `document_id`
- `selector`: for `pdf`/`markdown`/`generated` — a text-quote selector (quoted text + prefix/suffix context, W3C Web Annotation style) plus optional page number; for `chat_transcript` — a message id or message-id range
- `created_at`

`Anchor.document_id` is deliberately kept even though the Thread currently determines the Document — it's the seam that lets a later phase relax "one Thread = one Document" (paper + appendix, comparing two sources) by simply allowing anchors into other Documents. Code should funnel through anchors rather than `thread.document` where practical, to keep that door open.

### Entry
One item in the blended notes+chat timeline. This is the unification point between "notes" and "chat" — they are the same object type with a different `kind`.
- `id`, `thread_id`, `anchor_id` (nullable — unanchored entries land at thread level)
- `parent_entry_id` (nullable — links an `ai_response` to the `question` it answers; chronological order is not enough once two questions are in flight, and Phase 2 branching wants explicit lineage)
- `kind`: `note | question | ai_response`
- `body` (markdown), `pinned` (bool — an `ai_response` becomes a durable note when pinned)
- `created_at`, `updated_at`
- `extracted_at` (nullable — extraction watermark, see §5.1)

### Concept
An atomic knowledge unit extracted by the agent layer. Concepts are Field-scoped and are what Flashcards are generated from.
- `id`, `field_id`, `canonical_text`, `embedding` (BLOB — see §3, no vector extension needed)
- `status`: `active | merged`
- `merged_into_id` (nullable — set iff `status = merged`, points to the surviving Concept)
- `created_at`, `updated_at`

### ConceptMention
Where a Concept showed up.
- `id`, `concept_id`, `entry_id` (nullable), `anchor_id` (nullable)
- CHECK constraint: at least one of `entry_id` / `anchor_id` is non-null. Both paths are load-bearing: mentions from notes/pins carry `entry_id`; mentions from anchored document quotes carry `anchor_id` only.

### Flashcard
- `id`, `field_id`, `concept_ids` (one or more — cards testing a relationship reference multiple concepts)
- `front`, `back`, `card_type`: `recall | relationship`
- `lifecycle`: `draft | active | suspended` — cards are born `draft` (see §5.2), enter FSRS scheduling only when accepted, and can be suspended without deletion
- `user_edited` (bool — set once the user touches `front`/`back`; regeneration must never clobber an edited card)
- FSRS scheduling fields: `stability`, `difficulty`, `due_at`, `last_reviewed_at`, `state`

**Card lifecycle rules:**
- Concept merge re-points `concept_ids` to the surviving Concept without touching card content.
- Re-extraction that re-proposes an existing Concept does not regenerate its cards.
- Regeneration (any phase) skips `user_edited` cards entirely.

### ReviewLog
Append-only history of every review. FSRS parameter optimization requires review history, and so does undo-last-review — the scheduling fields on Flashcard only hold current state, so history is unreconstructable once discarded. Cheapest insurance in the spec; exists from Phase 0.
- `id`, `flashcard_id`, `rating`, `reviewed_at`, `scheduled_interval`, plus the pre-review FSRS state needed for undo

---

## 3. System architecture

```
Electron app
├── Renderer (React)
│   ├── Document pane      — PDF.js (react-pdf) or Tiptap, depending on source_type
│   ├── Notes+chat pane    — Tiptap-based Entry timeline, anchor-aware composer
│   ├── Artifacts pane     — Flashcard review UI (v1: single tab, no tab strip needed yet)
│   └── Thread/Field nav   — sidebar, thread tree
└── Main process           — window/file management, IPC bridge, SQLite access,
    └── Agent layer (TypeScript, in-process)
        ├── LLM provider abstraction (swappable — see below)
        ├── extraction, flashcard generation (single structured LLM calls)
        └── proposes writes; commit path is the same SQLite layer as everything else
```

- **No sidecar.** The MVP agent work — extraction, card generation, FSRS — is single LLM calls plus embedding math, not multi-step orchestration. A separate Python process would add a second runtime, lifecycle management, IPC transport, and two languages coupled to one SQLite schema, for no orchestration benefit. Agent code runs in the main process (moved to a worker thread only if a call ever measurably blocks the IPC bridge). If a Phase 2/3 agent genuinely becomes a multi-step graph, extracting a sidecar then is a refactor, not a rewrite — the "agent proposes, app commits" boundary (below) is the seam.
- **LLM provider abstraction:** all model access goes through a thin internal interface (chat completion + structured output + embeddings). Providers are swappable via config; calls go over the network. No provider-specific types leak past the abstraction. Embeddings come from the same abstraction — extraction therefore requires network, which is acceptable.
- **Storage:** SQLite (`better-sqlite3` from the main process). **One DB file for the whole app** — Field is a row, which keeps cross-field dedup possible later even though v1 doesn't use it.
- **No vector extension.** A Field holds hundreds to low-thousands of Concepts; brute-force cosine similarity over embedding BLOBs in JS is sub-10ms at that scale. `sqlite-vec` would mean ABI-matching a native extension against Electron's Node for zero benefit. The schema doesn't change either way — if a Field ever hits ~100k concepts, add the extension then.
- **Agent layer proposes, app state owns:** extraction and card generation propose Concepts, ConceptMentions, and Flashcards; the commit path writes them to SQLite after (optionally) surfacing a confirmation to the user. This boundary is what keeps every LLM feature replaceable without touching source-of-truth logic.

### 3.3 Document/Thread invariant
`Thread.document_id` is always set. A Thread that starts as pure exploration is backed by a `chat_transcript` Document created alongside it. This keeps every downstream system (extraction, card generation) working against "Thread → Document → Anchors" with no null-Document branch. The Document pane defaults to closed when `source_type = chat_transcript`, since it would just mirror the notes+chat pane.

*(Design review note: flipping this to a nullable `document_id` was considered and rejected — the invariant stands. The cost is the special cases around the self-referential `chat_transcript` Document; the benefit is a uniform downstream shape.)*

---

## 4. UI spec (v1)

Three panes, each independently closeable, one Thread open at a time:

1. **Document pane** — renders the Thread's Document (PDF via PDF.js, markdown/generated via Tiptap read view). Selecting text offers "note" / "ask" — either creates an Entry anchored to that selection.
2. **Notes+chat pane** — single chronological Entry list for the Thread. Composer at the bottom always available for unanchored entries too. Each `ai_response` Entry has a "pin" affordance that flips it to a durable note in place.
3. **Artifacts pane** — v1 shows exactly one view: **flashcard review** for the current Field (not just the current Thread — review pulls from the whole Field's due cards). Also hosts the draft-card cull pass (§5.2). No tab strip needed until a second artifact type exists.

**PDF anchor fidelity (v1): best-effort highlights.** Store quote + prefix/suffix + page. Paint the in-document highlight when the stored quote matches the PDF.js text layer cleanly; degrade to a page-level jump when it doesn't (hyphenation, ligatures, and column-order noise make perfect re-anchoring a hypothes.is-grade problem that v1 does not take on). Extraction and card generation only need the stored quote text, so highlight fidelity never gates the core loop.

Navigation: Field switcher at the top; a Thread list/tree per Field (flat list is fine for v1 — branch visualization can wait for Phase 2 when branching actually exists).

---

## 5. Agent layer responsibilities

| Responsibility | What it does | Phase |
|---|---|---|
| Extraction | Scans engaged material (§5.1), proposes Concepts, dedupes against existing Field concepts via embedding similarity | MVP |
| Flashcard generation | Turns Concepts (and pairs of related Concepts) into draft cards (§5.2) | MVP |
| Review scheduling | FSRS-based due-date computation via `ts-fsrs` — a library, not an agent | MVP |
| Branch proposal | Detects a chat question drifting from the Document's scope, proposes spinning up a child Thread | Phase 2 |
| Coherence/reconciliation | Cross-Thread scan for contradicting or redundant Concepts within a Field | Phase 3 |
| Thread → Document promotion | Synthesizes a chat-native Thread into a generated Document + child Thread | Phase 3 |

### 5.1 Extraction inputs and bookkeeping

**Extraction reads engagement, not everything.** Inputs are: user-authored Entries (`note`, `question`), **pinned** `ai_response` Entries, and the document text of Anchors (highlighting a passage counts as engagement even if you wrote nothing about it). Unpinned AI responses are never extraction fodder — pinning is the curation gesture. This is what keeps cards grounded in "what you actually engaged with," not a Q&A pass over raw text.

**Bookkeeping:** extraction is debounced (trigger on thread blur/switch plus an idle timer), not per-keystroke. Each Entry carries `extracted_at`; an Entry is due for (re-)extraction when `extracted_at` is null or older than `updated_at` — so edited notes get re-read without re-reading everything. Re-extraction that re-proposes an existing Concept adds a ConceptMention, not a duplicate Concept (embedding dedup handles the fuzzy match).

### 5.2 Card flow: draft + cull

Cards auto-generate from Concepts but land in `lifecycle = draft` — they do not enter FSRS scheduling. The Artifacts pane surfaces drafts for a fast keep/edit/discard skim (seconds per card); accepted cards flip to `active` and start scheduling. Rationale: a good session can yield 30+ concepts, auto-scheduling all of them floods the review queue, and review debt is the classic way spaced-repetition habits die. The cull pass doubles as a first review, and also catches extraction mistakes downstream of the silent concept write.

---

## 6. Phased roadmap

### Phase 0 — MVP
Goal: prove the core loop — read/chat/note in one place, get flashcards out the other end.

- Single Field only (no Field switcher needed yet, or a trivial one)
- Thread = one Document (`pdf`, `markdown`, or `generated` — **no `chat_transcript` yet**, defer the pure-exploration case) + Anchors + Entry timeline
- Document pane + Notes+chat pane, both closeable; no branching, no parent/child Threads
- Manual "ask AI" in the notes+chat composer (plain provider-abstraction call with Document context)
- Extraction (background): engaged Entries/Anchors → candidate Concepts → dedup via embedding similarity → write to SQLite
- Flashcard generation: Concepts → draft cards (recall-type only, skip relationship-type for now) → cull pass
- Artifacts pane: draft cull + flashcard review UI with FSRS scheduling (`ts-fsrs`), ReviewLog written from day one
- **Cut for MVP:** chat-native Threads, branching, coherence agent, relationship-type cards, multi-field nav, thread promotion

This alone is a complete, demoable product: open a paper, read and chat and note in one place, and get real spaced-repetition cards generated from what you actually engaged with — not from a Q&A pass over the raw text.

### Phase 1 — Chat-native threads + multi-field
- `chat_transcript` Document type; Threads can start with no external source
- Field switcher and multiple concurrent Fields
- Document pane auto-collapse for chat-native Threads
- Relationship-type flashcards (testing links between two Concepts, preferentially generated from Concepts that co-occur across Entries)

### Phase 2 — Branching
- Parent/child Thread lineage
- Branch-proposal agent: detects drift, proposes a child Thread, user confirms/declines
- Thread tree view in the sidebar (this is where a "tangent" visualization first becomes necessary — still no graph artifact, just navigation)

### Phase 3 — Coherence + promotion
- Coherence/reconciliation agent: cross-Thread contradiction and redundancy detection within a Field, surfaced as a review prompt (not auto-applied)
- Thread → Document promotion: "turn this exploration into a source" action, generates a `generated` Document + child Thread
- Revisit whether a knowledge-graph artifact is worth adding, now that there's real branch/concept structure to visualize
- Revisit whether any agent has become a genuine multi-step graph worth extracting into its own process/orchestration framework

---

## 7. Resolved design decisions (from review, 2026-07-21)

| Question | Decision |
|---|---|
| Agent runtime | TypeScript, in Electron main process. No Python sidecar, no LangGraph. Sidecar transport question is moot. |
| LLM provider | Swappable via a thin provider abstraction (chat + structured output + embeddings); network calls expected. No provider-specific types past the boundary. |
| SQLite layout | One DB file for the whole app; Field is a row. |
| Vector search | No `sqlite-vec` — embeddings as BLOBs, brute-force cosine in JS. Revisit only at ~100k concepts/Field. |
| Document mutability | Immutable after import. No anchor orphaning, no re-anchoring machinery. PDFs copied into app-managed data dir. |
| `Thread.document_id` | Stays non-null (chat-native Threads get a `chat_transcript` Document). Nullable alternative considered and rejected. |
| Extraction inputs | User notes/questions + pinned AI responses + anchored quotes. Unpinned AI responses excluded. |
| Extraction trigger | Debounced (thread blur/switch + idle timer), watermarked via `Entry.extracted_at` vs `updated_at`. |
| Concept confirmation UX | Silent-write + chip with undo for MVP; the card cull pass is the downstream safety net. |
| Card admission | Draft + cull pass; cards enter FSRS only when accepted. |
| PDF anchor fidelity (v1) | Best-effort highlights; degrade to page-level jump on text-layer mismatch. |
| Review history | ReviewLog table from Phase 0 (FSRS optimization + undo). |
