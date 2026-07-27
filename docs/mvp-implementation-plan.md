# Tangent MVP — Implementation Plan

**Scope:** Phase 0 of the [technical spec](./tangent-technical-spec.md) — the core loop: read/chat/note in one place, flashcards out the other end. Single Field, no chat-native Threads, no branching, recall-type cards only.

**Structure:** 7 phases. Each phase ends with something you can run (`npm run dev` and/or `npm test`) and inspect by hand. No phase depends on a later one; the app is launchable from Phase 0 onward.

---

## 0. Foundational decisions (locked before Phase 0)

These are the choices where getting it wrong is expensive to unwind, so they're made up front.

### Build tooling: `electron-vite`

Three-target builds (main / preload / renderer) out of the box, dev-mode HMR for the renderer, and — critically — sane defaults for **externalizing native modules** so `better-sqlite3` isn't bundled by the renderer build. Alternatives considered:

- *Electron Forge + Vite plugin* — workable, but the Vite plugin is less mature than electron-vite itself; Forge's value is packaging, which we defer to Phase 7 (electron-builder works fine with electron-vite).
- *Hand-rolled webpack* — no reason in 2026.

### Native module strategy: `better-sqlite3` + `@electron/rebuild`

`better-sqlite3` is a native module and must be compiled against **Electron's Node ABI**, not the system Node's. This is the #1 scaffold footgun. Mitigations, all set up in Phase 0:

- `"postinstall": "electron-rebuild -f -w better-sqlite3"` in package.json
- Pin the Electron major version in `devDependencies` (ABI changes with Electron majors)
- `better-sqlite3` listed in electron-vite's `externalizeDepsPlugin` scope (default behavior — verify, don't assume)
- Unit tests (vitest) run under **system Node**, which needs its *own* native build. Solution: tests import the DB layer directly and vitest runs `better-sqlite3` compiled for system Node; the postinstall rebuild targets Electron. Use `npm rebuild better-sqlite3` in a pretest script if the two ABIs fight, or (simpler) keep a `node_modules/.bin/electron-rebuild` invocation only in `postinstall` and accept one manual `npm rebuild` when switching between test-mode and dev-mode. Document whichever we land on in the README on day one.

### Process boundaries

Everything stateful lives in the **main process**: SQLite, document file management, the agent layer, all network calls. The renderer is a pure view over typed IPC.

- `contextIsolation: true`, `nodeIntegration: false`, single `contextBridge` API exposed from preload
- IPC contracts (request/response types per channel) defined once in `src/shared/` and imported by both sides — no stringly-typed channels
- Agent calls run in the main process per the spec (no sidecar, no worker thread until a call measurably blocks the IPC bridge)

### Project layout

```
tangent/
├── package.json
├── electron.vite.config.ts
├── tsconfig.json                  # base; per-target tsconfigs extend it
├── src/
│   ├── main/
│   │   ├── index.ts               # app lifecycle, window creation
│   │   ├── db/
│   │   │   ├── connection.ts      # open DB, pragma setup (WAL, foreign_keys)
│   │   │   ├── migrations/        # numbered .sql files + runner
│   │   │   └── repos/             # one module per entity (fieldRepo, threadRepo, …)
│   │   ├── documents/             # import, app-data dir management
│   │   ├── agent/
│   │   │   ├── provider/          # LLM provider abstraction + implementations
│   │   │   ├── extraction.ts
│   │   │   └── cardgen.ts
│   │   └── ipc/                   # ipcMain.handle registrations, one file per domain
│   ├── preload/
│   │   └── index.ts               # contextBridge; mirrors src/shared/ipc contracts
│   ├── renderer/
│   │   ├── App.tsx
│   │   ├── panes/                 # DocumentPane/, NotesPane/, ArtifactsPane/
│   │   ├── sidebar/
│   │   ├── state/                 # renderer-side stores (zustand)
│   │   └── api.ts                 # typed wrapper over window.tangent (the bridge)
│   └── shared/
│       ├── entities.ts            # Field, Document, Thread, Anchor, Entry, Concept, Flashcard, ReviewLog types
│       └── ipc.ts                 # channel names + request/response types
├── tests/                         # vitest; DB-layer and agent-layer units
└── docs/
```

`src/shared/` is the load-bearing directory: entity types and IPC contracts are defined exactly once. The spec's "code should funnel through anchors rather than `thread.document`" guidance gets enforced here by shaping the repo/IPC APIs around anchors from the start.

### App data layout (spec §2, Documents)

One folder holds everything, so backup is a copy command:

```
<app.getPath('userData')>/tangent/
├── tangent.db                     # single DB for the whole app
└── documents/<document_id>.<ext>  # imported PDFs/markdown, copied in, immutable
```

### Dependency manifest

| Package | Role | Notes |
|---|---|---|
| `electron` | runtime | Pin major. ABI anchor for native rebuilds. |
| `electron-vite`, `vite` | build | |
| `typescript` | | strict mode on from day one |
| `react`, `react-dom` | renderer | |
| `better-sqlite3` | storage | native; see rebuild strategy above |
| `@electron/rebuild` | native ABI | postinstall hook |
| `react-pdf` | PDF rendering | wraps pdf.js; **worker must be configured for Vite** — import `pdfjs-dist/build/pdf.worker.min.mjs?url` and set `GlobalWorkerOptions.workerSrc`. Budget time for this in Phase 2; it's the classic react-pdf-under-a-bundler snag. |
| `@tiptap/react`, `@tiptap/starter-kit` | markdown read view + Entry composer | Pin major — Tiptap has had breaking major churn. |
| `ts-fsrs` | review scheduling | library, not an agent (spec §5) |
| `openai` | chat + structured output provider | the OpenAI *wire format*, not the vendor — see Phase 4 |
| *(embeddings)* | embeddings provider | chat aggregators mostly don't serve them; see Phase 4 |
| `zod` | schemas for structured LLM output + IPC payload validation | pairs with the SDK's `zodOutputFormat` helper |
| `zustand` | renderer state | small, no boilerplate; renderer state is thin anyway since main owns truth |
| `vitest` | tests | runs against the DB and agent layers directly (no Electron needed) |
| `electron-builder` | packaging | deferred to Phase 7 |

Deliberately **not** used: ORMs (hand-written SQL in repo modules — the schema is 8 tables), `sqlite-vec` (spec: brute-force cosine in JS), LangChain-style frameworks (spec: thin provider abstraction), Python anything.

---

## Phase 0 — Scaffold + toolchain proof

**Goal:** the risky toolchain combination (Electron + Vite + native SQLite + TypeScript + tests) demonstrably works before any product code exists.

- Scaffold with electron-vite (React + TS template), apply the layout above
- Wire `better-sqlite3` + `@electron/rebuild` per the strategy above
- One IPC round-trip: renderer button → main opens an in-memory SQLite DB, runs `SELECT sqlite_version()` → renderer displays it
- vitest configured; one test that opens a temp-file DB, creates a table, inserts, reads back
- ESLint + Prettier; `contextIsolation` on, CSP header set in `index.html`

**Testable outcome:**
- `npm run dev` → window opens showing Electron, Chrome, Node, and SQLite versions (the SQLite one proves the native module loaded in main and IPC works end-to-end)
- `npm test` → green under system Node
- Delete `node_modules`, `npm install`, both still work (proves the postinstall rebuild is real, not a local accident)

---

## Phase 1 — Storage layer: full schema + repos

**Goal:** the entire Phase-0 data model exists and is tested, before any UI consumes it. The schema is the spec's most carefully-designed artifact; implementing it in one pass keeps it coherent.

- Migration runner (numbered SQL files, `schema_migrations` table, applied in a transaction on startup)
- Migration 001: **all eight tables** — `field`, `document`, `thread`, `anchor`, `entry`, `concept` (+ `concept_mention`), `flashcard`, `review_log` — with the spec's constraints:
  - `thread.document_id NOT NULL` (§3.3 invariant)
  - `concept_mention` CHECK: `entry_id IS NOT NULL OR anchor_id IS NOT NULL`
  - `concept.merged_into_id` set iff `status = 'merged'` (CHECK)
  - `flashcard.concept_ids` as a join table (`flashcard_concept`), not a JSON column — cards reference multiple concepts and merge re-pointing needs to be an UPDATE, not a JSON rewrite
  - `review_log` append-only, carrying pre-review FSRS state for undo (§2)
  - `entry.extracted_at` watermark column present from the start
- WAL mode, `foreign_keys = ON`
- Repo module per entity with the queries the later phases need (e.g. `entryRepo.dueForExtraction(threadId)` implementing the `extracted_at IS NULL OR extracted_at < updated_at` watermark — written and tested now, used in Phase 5)
- App-data directory bootstrap (`tangent/documents/` created on startup); seed a default Field row (MVP is single-Field)
- IPC: a read-only `debug:dbStats` channel (row counts per table) surfaced in a dev-only corner of the UI

**Testable outcome:**
- `npm test` → repo tests green: CHECK constraints actually reject bad rows, watermark query returns the right entries, flashcard↔concept re-pointing works
- `npm run dev` → dev stats panel shows the seeded Field; `sqlite3 ~/Library/Application\ Support/tangent/tangent.db .schema` shows the full schema; kill and relaunch, data persists

---

## Phase 2 — Documents + Thread shell

**Goal:** import a real source and read it inside the app.

- Import flow: file picker → PDF copied into `documents/` (markdown: content stored per spec `content_ref` semantics) → `document` row → `thread` row created against it
- Sidebar: flat thread list for the default Field; select to open; thread create/archive
- Document pane: `react-pdf` for PDFs (page virtualization — render a window of pages, not all); Tiptap read-only view for markdown
- Pane close/open toggles (document pane and notes pane both closeable per spec §4)
- Document immutability honored: no edit affordances anywhere on a document

**Testable outcome:**
- `npm run dev` → import a real ~30-page paper PDF; it renders with selectable text (verify the pdf.js **text layer** is on — Phase 3 depends on it); scrolling stays smooth
- Import a markdown file; renders
- Relaunch: threads and documents persist; original source file moved/renamed on disk → app unaffected (copy semantics verified)

---

## Phase 3 — Entry timeline + anchors

**Goal:** the notes half of the unified surface: write notes, anchor them to selections, see highlights.

- Notes+chat pane: chronological Entry list + Tiptap composer at bottom; unanchored `note` entries work immediately
- Selection flow: select text in document pane → floating "note / ask" affordance → creates an Anchor (text-quote selector: exact quote + prefix/suffix context + page number, W3C style per spec §2) and an anchored Entry ("ask" is a stub until Phase 4 — creates the `question` entry without an AI reply)
- Highlight painting: search the pdf.js text layer for the stored quote; on clean match, paint highlight; on mismatch, **degrade to page-level jump** (spec §4 — do not attempt hypothes.is-grade re-anchoring)
- Cross-navigation: click an anchored entry → scroll/jump to its region; click a highlight → scroll timeline to its entries
- Anchors for markdown documents via the same text-quote selector against the rendered text

**Testable outcome:**
- Select a passage → "note" → write a note → highlight appears in the PDF and the entry shows its quote context
- Relaunch: highlights re-paint from stored selectors
- Manufacture a degrade case (anchor a quote that spans a hyphenated line-break): app falls back to page jump without erroring
- Entries edit/update bumps `updated_at` (watermark integrity for Phase 5), verified in the dev stats panel or sqlite CLI

---

## Phase 4 — LLM provider abstraction + Ask AI

**Goal:** the network seam, built to the spec's rule: no provider-specific types leak past the boundary.

**The abstraction** (`src/main/agent/provider/`):

```ts
interface LLMProvider {
  chat(req: ChatRequest): AsyncIterable<ChatDelta>;          // streaming
  structured<T>(req: StructuredRequest<T>): Promise<T>;      // zod-schema-validated
  embed(texts: string[]): Promise<Float32Array[]>;
}
```

**Provider reality check:** the services that serve cheap chat mostly **don't serve embeddings**. So the spec's "embeddings come from the same abstraction" holds at the *interface* level, while the implementation composes two vendors behind it:

- `chat` / `structured` → the **OpenAI wire format** via the `openai` SDK pointed at any `baseUrl`. One implementation covers OpenRouter (default), Groq, DeepSeek, Together, OpenAI, and local Ollama / LM Studio; switching is a `baseUrl` + `model` edit in `agent.json`, not new code. Structured output uses `response_format: json_schema`, falling back to JSON mode + an inlined schema on endpoints that can't enforce one — zod validates either way.
- `embed` → Voyage by default; `openai-compatible` embeddings (OpenAI's `text-embedding-3-small`, Ollama's `nomic-embed-text`) are a config switch.

*(As built, July 2026: the plan originally specified `@anthropic-ai/sdk` with `claude-opus-4-8` and the `voyageai` package. Cost drove the switch to the OpenAI-compatible seam — the default model is ~20x cheaper than the Opus tier and one config line from ~140x cheaper. The abstraction was unchanged by the swap, which is the evidence it was drawn in the right place: `ask.ts`, the IPC layer, and the UI were untouched.)*
- `MockProvider` — deterministic canned responses + hash-based fake embeddings, used by all tests and a `TANGENT_MOCK_LLM=1` dev mode so the app runs offline

Config: JSON file in the app-data dir (`provider`, `model`, `embeddingProvider`); API keys via env var first (settings UI is Phase 7 polish). Store embeddings as `Float32Array` → BLOB, with `embedding_model` recorded on the concept row so a future model switch can detect stale vectors.

**Ask AI flow:**
- "ask" (from Phase 3's stub) or composer-as-question → `question` entry → main assembles context (document text, the anchored quote if any, recent thread entries) → streams the reply into an `ai_response` entry with `parent_entry_id` linking it to its question (spec: chronology is not enough with two questions in flight)
- Pin affordance on `ai_response` entries flips `pinned` in place
- Errors (no key, network down) render as a failed state on the entry, retryable — never a lost question

**Testable outcome:**
- `npm test` → provider-layer tests green against `MockProvider`; a structured-output test validates zod-schema round-tripping
- `npm run dev` with real keys → ask "what does section 3 argue?" against the imported paper → grounded streamed answer appears threaded under the question; pin it; ask two questions quickly → replies attach to the right parents
- `TANGENT_MOCK_LLM=1 npm run dev` → full app works offline

---

## Phase 5 — Extraction pipeline

**Goal:** background concept extraction per spec §5.1 — reads engagement, not everything.

- **Triggers:** thread blur/switch + idle timer (~90s of no edits), debounced; never per-keystroke. A manual "extract now" dev button for deterministic testing.
- **Input assembly:** entries due per the watermark query (Phase 1) filtered to *engaged* material — user `note`/`question` entries, **pinned** `ai_response` entries, plus anchored quote text (a highlight with no note still counts). Unpinned AI responses are never included.
- **Extraction call:** one `structured()` call proposing candidate concepts (`canonical_text` + which input each came from)
- **Dedup:** embed candidates; brute-force cosine against all active Concepts in the Field (spec: sub-10ms at this scale, no vector extension). Above threshold (start ~0.85, constant in one place, tuned against real data) → existing concept gets a new `ConceptMention`; below → new Concept + mention. Mentions carry `entry_id` or `anchor_id` per source.
- **Commit path:** agent proposes, app commits (spec §3) — extraction returns proposals; a single repo transaction writes concepts/mentions and stamps `extracted_at` on the consumed entries
- **UX:** silent write + transient chip ("4 concepts added · undo") per spec §7; undo reverses the transaction

*(As built, July 2026: three things the plan left open. **Activity detection lives in main**, not the renderer — main already sees every committed entry over IPC, so the finest granularity available is "a note was saved" and per-keystroke was never reachable; the renderer only reports *which thread is active*, since a switch is the one thing main can't see. **Mentions are a set, not a log** — re-extracting an edited note that still argues the same thing adds no row, so provenance answers "where did this come from" rather than "how many times was it re-read". And `StructuredRequest` gained an `offlineFallback`, read only by MockProvider in `TANGENT_MOCK_LLM=1`, so a background pipeline that has no model to call degrades to a grounded stand-in instead of taking the feature down offline.)*

**Testable outcome:**
- `npm test` → with `MockProvider`: watermark selects the right entries; near-duplicate embedding → mention not new concept; unpinned AI responses excluded; undo restores prior state
- `npm run dev` (real provider) → take notes on a section, switch threads → chip appears; inspect `concept` / `concept_mention` via dev panel or sqlite CLI — concepts trace back to your actual notes/highlights, not un-engaged document text
- Edit an old note → next trigger re-extracts *only* that entry (verify via `extracted_at` timestamps); re-proposing an existing concept adds a mention, no duplicate

---

## Phase 6 — Flashcards: generation, cull, review

**Goal:** close the loop — the Artifacts pane, draft cull, and FSRS review.

- **Generation:** on extraction commit, new Concepts (only new — re-proposed concepts never regenerate cards, spec §2) → one `structured()` call → recall-type cards, `lifecycle = 'draft'`
- **Cull pass** (Artifacts pane, top of view when drafts exist): one card at a time, keyboard-first — accept / edit / discard. Edit sets `user_edited`; accept flips to `active` and initializes FSRS state via `ts-fsrs`; discard deletes.
- **Review:** due `active` cards for the whole Field (not just current thread, spec §4). Front → reveal → Again/Hard/Good/Easy → `ts-fsrs` computes next state → update card + **append `review_log` row with pre-review FSRS state**
- **Undo last review:** restore card state from the latest `review_log` row, mark the log row undone (append-only — flag, don't delete)
- **Lifecycle rules enforced in the repo layer:** regeneration skips `user_edited` cards; concept merge re-points `flashcard_concept` rows without touching card content (mechanism tested now even though the merge-producing coherence agent is Phase 3 of the roadmap)
- Suspend action on cards (spec lifecycle: `draft | active | suspended`)

**Testable outcome — this is the full product loop:**
1. `npm run dev` → import a paper → read, highlight, take notes, ask + pin one answer
2. Switch threads → extraction chip → drafts appear in Artifacts pane
3. Cull: accept some (edit one), discard duds — seconds per card
4. Review the accepted cards; ratings produce sensible `due_at` spreads (inspect via sqlite CLI); `review_log` has one row per review with pre-state
5. Undo last review → card state restored
6. Relaunch → due queue intact
7. `npm test` → FSRS state transitions, undo, `user_edited` protection, merge re-pointing all green

---

## Phase 7 — Hardening + polish (optional, post-MVP-proof)

Not required to demo the loop; do selectively:

- Settings UI: API keys (safeStorage-encrypted), provider/model selection
- Error/empty states pass (no thread yet, no due cards, extraction failed)
- `electron-builder` packaging for macOS; verify the native module + pdf.js worker survive packaging (asar unpack rules for `better-sqlite3`)
- Extraction/cardgen effort + threshold tuning against real usage

---

## Risk register

| Risk | Phase | Mitigation |
|---|---|---|
| `better-sqlite3` ABI mismatch vs Electron | 0 | postinstall `electron-rebuild`, pinned Electron major, clean-install verification in Phase 0's exit criteria |
| pdf.js worker breaks under Vite / packaging | 2, 7 | `?url` worker import pattern; re-verify at packaging time |
| Anchor quote matching too brittle | 3 | spec pre-authorizes page-jump degradation; never block the core loop on highlight fidelity |
| Embeddings vendor split surprises later phases | 4 | `embed()` behind the same interface from day one; `embedding_model` recorded per concept |
| Extraction quality (dup/junk concepts) | 5–6 | draft+cull is the designed safety net; threshold is a single tunable constant; mock-provider tests lock the *mechanics* so tuning only touches prompts/threshold |
| Tiptap/react-pdf major-version churn | all | pin majors, upgrade deliberately |
