# Web URL import — implementation plan

Ingest any article URL as a readable Document: core text, images and graphics
preserved; nav, ads and chrome removed. Links that point elsewhere open in the
OS browser; links that point *within* the article stay in the app.

Status: **built.** Written against the codebase at `2a2bc5d`; this section
records where the implementation diverged from the plan and why.

### Divergences from the plan as written

- **No heading `id`s in the DOM.** The plan had the markdown renderer stamping
  `md-<slug>` onto each heading. The document view renders through Tiptap, which
  drops attributes its schema doesn't declare, so those ids never reached the
  DOM. Fragments are resolved instead by re-deriving slugs from the rendered
  headings at click time (`MarkdownView.findHeading`) — same shared slugger,
  one less dependency, and no question of what a clipped page could name itself.
- **`@tiptap/extension-heading` not added**, as a consequence of the above.
  `@tiptap/extension-image` is pinned to `3.28.0`: Tiptap extensions declare an
  *exact* `@tiptap/core` peer, so the floating `^3.28.0` resolved to 3.29.1 and
  conflicted with the installed core.
- **A minimum article length was needed.** Readability answers "which part of
  this page is most article-like", not "is any of it an article" — given a page
  of pure navigation it returns the navigation and reports success. Without
  `MIN_ARTICLE_CHARS` that imports as an empty Document.
- **Tables that turndown can't express** were emitting raw HTML (the gfm plugin
  `keep`s any table without a header row — every Wikipedia infobox). The
  renderer escapes raw HTML by policy, so it surfaced as literal `<table …>` in
  the reading pane and left asset placeholders unsubstituted inside it. Fixed
  with a `keepReplacement` that flattens such elements to their converted
  children.
- **`<base>` is inserted programmatically**, not by string-injecting into the
  page HTML — verified to give byte-identical resolution without doing surgery
  on untrusted markup.

## 1. Scope

**In:** a URL → a `markdown` Document + first Thread, indistinguishable
downstream from a `.md` import. Images downloaded and served locally.
Intra-article links resolved in-app; everything else handed to the browser.

**Out (deliberately):** shadow-DOM sites (Reddit), pages Readability can't score
structurally (Hacker News), re-clipping/refresh, and offline archival of
anything but images. See §8.

## 2. Evidence behind the design

Twenty representative URLs, fetched two ways, run through the same extraction
pipeline (probe scripts and captured HTML are in the session scratchpad):

| | plain `fetch` | hidden `BrowserWindow` |
|---|---|---|
| usable extraction | 11/20 | **16/20** |
| regressions | — | none |
| latency | ~200ms | 1.1–2.5s typical, 4.3s worst |

The nine `fetch` failures were **not** mostly SPAs: five were anti-bot
challenges (Cloudflare "Just a moment" on Medium and Stack Overflow, Reddit's
verification interstitial, DataDome on NYT, OpenAI's interstitial), two were
client-rendered (x.com, LessWrong — whose prose sits in a hydration payload),
and two were Readability structural failures that no fetch strategy fixes.

Restricted to indie blogs / arXiv / docs sites / GitHub / Substack, plain fetch
scored 11/11. The browser's entire margin is Big Sites — which is exactly where
a bot wall is waiting on day one.

**Decision: browser-first, single path.** A fetch-then-escalate design needs a
"was that good enough?" heuristic, which is both throwaway work and wrong in the
dangerous direction — a cookie-wall stub or subscribe-teaser clears any
character threshold and gets imported as if it were the article.

## 3. Dependencies

| package | size | why |
|---|---|---|
| `@mozilla/readability` | 0 deps | article extraction; the Firefox Reader Mode engine |
| `linkedom` | 5 small deps | DOM for Readability. 3–4× faster than `jsdom` and a fraction of the tree. Ships CJS + ESM, so `externalizeDepsPlugin` handles it — no `pdfText.ts`-style import dance needed. |
| `turndown` + `turndown-plugin-gfm` | bundles its own DOM | HTML → markdown, with tables/strikethrough |
| `@tiptap/extension-image` | — | **StarterKit has no Image node** (verified: 22 extensions, none of them Image). Without this, images are silently dropped by the document pane. |

`jsdom` is explicitly *not* used.

## 4. Data model

`source_type` stays `markdown` — a clipped article **is** a markdown document,
so it inherits the entire render / anchor / agent-context path for free. Adding
a `'web'` value would mean a full table rebuild (SQLite can't alter a CHECK;
`thread` and `anchor` both reference `document`, so it needs
`PRAGMA defer_foreign_keys = ON` inside the migration transaction) for a badge.

**Migration `003_document_source_url.ts`** — one line:

```sql
ALTER TABLE document ADD COLUMN source_url TEXT;
```

`sourceUrl: string | null` joins `Document` in `src/shared/entities.ts` and the
row mapping in `documentRepo.ts`. It carries provenance, drives the `WEB` badge
and an "open original" affordance, and marks which documents own an assets dir.

Assets live in `documents/<documentId>/` — the first per-document subdirectory,
alongside the existing flat `<id>.pdf` files. The data dir stays a single
copyable folder.

## 5. Modules

### 5.1 `src/main/documents/webFetch.ts` — the only Electron-aware piece

```ts
export interface FetchedPage { html: string; finalUrl: string }
export function fetchPageViaBrowser(url: string): Promise<FetchedPage>
```

A hidden `BrowserWindow` loads the URL, JS runs, the settled DOM is serialized
back via `executeJavaScript('document.documentElement.outerHTML')`. Hardening,
all of it load-bearing since this executes untrusted JS by design:

- `show: false`, `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`, **no preload**
- dedicated session partition, separate from the app's
- `setWindowOpenHandler(() => ({ action: 'deny' }))` — no popups
- reject non-`http(s)` input schemes up front
- hard timeout ~20s; settle ~800ms after `did-stop-loading`; `destroy()` in a
  `finally`
- scroll to the bottom and back before serializing, so lazy images load
- clip windows are tagged (`isClipWindow`) so app lifecycle doesn't mistake one
  for the app's own UI. The existing `window-all-closed` handler turned out to
  cover the quit case already — what needed fixing was `activate`, which would
  otherwise see a hidden clip window and decline to reopen the main window.

Session choice is a real trade-off worth surfacing in settings later: an
in-memory partition is private; a persistent one lets you log into sites you
subscribe to once and clip them thereafter, at the cost of clips carrying your
identity. **Start in-memory.**

### 5.2 `src/main/documents/webClip.ts` — pure, no Electron, all the logic

Its DOM types are written out by hand in `clipDom.ts`: the main process has no
DOM lib and shouldn't gain one, and linkedom types its own return as
`Window & typeof globalThis`, which resolves to nothing useful there.

```ts
export interface ClippedArticle {
  title: string
  byline: string | null
  siteName: string | null
  markdown: string
  images: ClippedImage[]   // { originalUrl, placeholder }
}
export function clipArticle(html: string, finalUrl: string): ClippedArticle
```

1. **Pre-pass** on the parsed DOM: promote `data-src` / `data-original` /
   `srcset` / `<picture><source>` onto `img.src` so lazy images survive.
2. **Inject `<base href="finalUrl">`** before parsing. linkedom has no base-URI
   resolution, so without this Readability leaves `/books/joshi.jpg` relative.
   Verified: with the `<base>`, output matches jsdom's exactly.
3. `Readability.parse()`. **A `null` return is an error**, surfaced as "couldn't
   find an article at that URL" — not an empty Document.
4. **Link rewriting**, against the extracted content:
   - external `http(s)` → untouched; `setWindowOpenHandler` already routes
     these to the OS browser (`src/main/index.ts:37`)
   - fragment matching a heading that survived extraction → keep as `#slug`,
     an in-app jump
   - fragment with no surviving target (Wikipedia's 82 `#cite_note-*` links) →
     absolutize against `finalUrl`, so it opens the original page at that spot
   - anything else → the existing sanitizer degrades it to plain text
5. `turndown` + `gfm`, plus a rule reading `class="language-*"` for fenced code
   languages (turndown drops the language otherwise).
6. Image `src`s become opaque placeholders; the caller resolves them to files.

### 5.3 `src/main/documents/webAssets.ts`

```ts
export function downloadImages(
  images: ClippedImage[],
  destDir: string,
  fetchBytes: FetchBytes,          // injected — Electron in prod, stub in tests
): Promise<Map<string, string>>    // placeholder -> local filename
```

Caps: ≤40 images, ≤5MB each, ≤25MB total, `http(s)` only, skip 1×1 tracking
pixels. Filenames are `<sha256(url)>.<ext>`. A failed download drops the image
to its alt text — a remote URL left in place would be blocked by CSP anyway, so
a broken image is the one outcome to avoid. `data:` URIs stay inline (CSP
already permits them).

Production `fetchBytes` uses `session.fromPartition(CLIP_PARTITION).fetch()`, so
image requests carry the same cookies and referer as the page load and survive
hotlink protection.

### 5.4 `src/main/documents/import.ts`

```ts
export function importUrlDocument(
  storage: Storage,
  url: string,
  deps: { fetchPage: FetchPage; fetchBytes: FetchBytes },
): Promise<ImportResult>
```

Mirrors `importDocument` (`import.ts:35`): title from the article, markdown
inlined into `content_ref`, `source_url` set, Document + first Thread in one
transaction. Same cleanup discipline — on insert failure, `rm -rf` the assets
dir, matching the existing PDF rollback at `import.ts:72`.

Stays Electron-free: both dependencies are injected, exactly as the file picker
already lives in the IPC layer rather than here.

### 5.5 `tangent://` protocol

CSP (`src/renderer/index.html:8`) is `img-src 'self' data: blob:`, so remote
images are blocked today — and should stay blocked (tracking pixels, link rot).
Instead:

- `protocol.registerSchemesAsPrivileged([{ scheme: 'tangent', privileges: { standard: true, secure: true } }])` at module top level in `src/main/index.ts`, before ready
- `protocol.handle('tangent', …)` after ready, next to `initStorage`
- URL shape `tangent://assets/<documentId>/<filename>`
- **Path safety:** `documentId` must match the UUID shape (`newId()` is
  `randomUUID()`), filename must match `^[a-f0-9]{64}\.[a-z0-9]+$`, and the
  resolved path must still sit under `documentsDir`. Reject otherwise.
- CSP gains `tangent:` in `img-src`

## 6. Renderer

**`src/renderer/src/lib/markdown.ts`** — the single sanitizer, so both changes
land here:
- `SAFE_HREF` accepts `^#` fragments (currently they degrade to plain text)
- headings render with `id="<slug>"`; needs a small deterministic slugger with
  `-1`/`-2` dedup. Harmless for entry bodies, which share this path.

**`src/renderer/src/panes/DocumentPane/MarkdownView.tsx`**:
- `StarterKit.configure({ heading: false, link: { openOnClick: false } })` —
  verified these option keys exist in StarterKit 3.28
- a `Heading.extend()` keeping the `id` attribute (Tiptap strips unknown
  attributes, so fragment targets are lost otherwise)
- `@tiptap/extension-image`
- click handler: `#fragment` → `scrollIntoView`; anything else → `window.open`,
  which the existing handler sends to the browser

**`src/renderer/index.html`** — `tangent:` added to `img-src`.

**`src/renderer/src/sidebar/Sidebar.tsx`** — a URL input beside
`+ Import document`, with a pending state (this takes seconds). Errors flow
through the existing `reportError` path.

## 7. IPC, agent, tests

- `documents:importUrl` → `{ url } : ImportResult` in `src/shared/ipc.ts`,
  registered in `src/main/ipc/documents.ts` where the Electron dependencies get
  injected; `documents.importUrl(url)` in preload; `importUrlDocument` action in
  `appStore`. Already promise-based, so the seconds of fetching need no
  streaming — just a disabled button.
- `readDocumentText` (`documents/text.ts`) works unchanged, but should **strip
  image markdown** before feeding a web document to a model — `tangent://` URLs
  are pure token noise.
- **Tests** (`tests/documents/`): fixture HTML checked in from the probe
  captures, exercising `clipArticle` — title, code fences, image placeholders,
  and each of the four link cases; plus `importUrlDocument` with both deps
  stubbed. No network in tests. `webFetch.ts` stays untested by unit tests —
  it's Electron glue, and every piece of logic worth covering lives elsewhere.

## 8. Known limits, accepted

- **Shadow DOM** (Reddit): `outerHTML` doesn't serialize shadow roots. Needs a
  recursive walker; punted.
- **Readability structural failures** (Hacker News' table layout): content is
  present but scores badly. No fetch strategy helps. Escape hatch when it
  matters: the clip window can `printToPDF()` and the page enters through the
  PDF path that already exists — post-MVP.
- **Hard captchas** (DataDome/NYT) may still block. Cloudflare's managed
  challenge did solve itself in testing.
- Clipping is a point-in-time snapshot; no refresh/re-clip.

## 9. Build order

Each step is reviewable on its own; the app stays working throughout.

1. Migration 003 + `sourceUrl` through entity/repo. *(tests: migrations)*
2. `webClip.ts` + fixtures. Pure, no wiring — the whole extraction contract
   lands under test before anything renders it. *(the biggest step)*
3. `webFetch.ts` + `window-all-closed` guard. Verifiable by hand against a live
   URL.
4. `tangent://` protocol + CSP + `webAssets.ts`.
5. `importUrlDocument` + IPC + preload + store.
6. Renderer: markdown sanitizer, MarkdownView extensions, Sidebar input.
7. `readDocumentText` image stripping.

## 10. Decisions

1. **Session partition: in-memory.** Clips carry no identity and no cookies.
   Persistent (log in once, clip subscriptions) stays available as a later
   setting.
2. **`application/pdf` URLs: not handled.** Non-HTML content types are a clean
   error. Routing them into the existing PDF path is additive later.
3. **Image cap: 40**, 5MB each, 25MB total. Exceeding it is reported on the
   import result rather than silently truncated.

## 11. Security

This feature loads attacker-controlled HTML and executes its JavaScript, then
renders content derived from it inside a privileged renderer. That is the whole
threat model; everything below is a mitigation for a specific step of that path.

Four properties were verified against Electron 43 rather than assumed (probes in
the session scratchpad):

| claim | result |
|---|---|
| `<img src="tangent://…">` loads in the app renderer | loads |
| the same URL from a **clipped page** | **blocked** — the handler never sees the request |
| `will-redirect` + `preventDefault()` vetoes a redirect chain | vetoed, `loadURL` rejects |
| a partition without `persist:` is non-persistent | `isPersistent() === false` |

### T1 — Untrusted JS in the clip window
`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, **no
preload**, `webSecurity` left on, dedicated in-memory partition. The window
never touches the app's session, and has no bridge to main.

### T2 — Navigation as SSRF (`file://`, loopback, private ranges)
A page can redirect itself anywhere, and whatever lands gets serialized into the
imported document. `will-navigate` and `will-redirect` enforce `http(s)` and veto
redirects into loopback/private address space.

**The user's own typed URL is trusted** — `http://localhost:3000` is a legitimate
thing to want to clip on your own machine. Only *page-driven* navigation into
private space is blocked. Hostname-based, so it does not stop DNS rebinding;
noted, not defended against.

### T3 — A clipped page reading local assets
`tangent://` is registered on the **default session only**. Clipped pages run in
a partition that has no handler for the scheme, so a malicious page cannot read
`tangent://assets/<other-doc>/…`. Verified above.

### T4 — Path traversal through the protocol handler
`documentId` must match the UUID shape `newId()` produces, filename must match
`^[a-f0-9]{64}\.[a-z0-9]+$` (sha256 + extension), extension must be in an image
allowlist, and the resolved path must still sit under `documentsDir`. Filenames
are derived from a hash of the URL — never from attacker-supplied path text.

### T5 — SVG as a script vector
SVG is worth keeping (technical diagrams), and `<img>` context does not execute
it. To close direct navigation as well, every asset response carries
`Content-Security-Policy: default-src 'none'`, `X-Content-Type-Options: nosniff`,
and a `Content-Type` from a fixed extension→MIME map — never sniffed, never
`text/html`.

### T6 — XSS through the markdown pipeline
`lib/markdown.ts` already escapes raw HTML and restricts hrefs, and remains the
only sanitizer. The two new allowances are inert: `#fragment` hrefs, and
`tangent:` **as an image source only** (not as a link href). Heading `id`s derive
from attacker-controlled heading text, so they are escaped and prefixed (`md-`)
to keep clipped content from minting ids that collide with the app's own DOM.

### T7 — Image download as SSRF
Image URLs come from the page, not the user. `http(s)` only; a private-space host
is allowed only when it matches the document's own host (so a clipped localhost
dev page keeps its images, while a public page cannot reach into your LAN).

### T8 — Resource exhaustion
Serialized HTML capped at 8MB before parsing (linkedom and Readability run
**synchronously on the main thread** — an uncapped 100MB document would freeze
the UI). 20s load timeout, 40 images, 5MB each, 25MB total.

### T9 — Ambient page capabilities
Permission requests denied (`setPermissionRequestHandler` /
`setPermissionCheckHandler` → false), downloads cancelled (`will-download` →
`preventDefault`), popups denied (`setWindowOpenHandler` → deny), autoplay
gated on user activation.

### T10 — Accepted risks
- **Prompt injection.** Clipped text reaches the model through
  `readDocumentText`. An article can carry instructions aimed at the agent. This
  is inherent to reading untrusted documents (a PDF can do it too); the app is
  local, single-user, and the agent holds no tools, so it is accepted and noted
  rather than defended.
- **JS dialogs.** A page calling `alert()` blocks its own renderer. Electron
  offers no supported way to suppress this without `contextIsolation: false`,
  which would be a far worse trade. The load timeout bounds it.
- **Main-thread parse cost** for a large-but-under-cap page: a visible hitch on
  import, not a hang. Moving extraction to a `utilityProcess` is the fix if it
  ever bites.
