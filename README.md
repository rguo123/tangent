# Tangent

Desktop app for building expertise in a field: read a source, chat with an AI about it, and take notes in one unified surface — then get spaced-repetition flashcards generated from what you actually engaged with.

- **Spec:** [docs/tangent-technical-spec.md](docs/tangent-technical-spec.md)
- **Implementation plan:** [docs/mvp-implementation-plan.md](docs/mvp-implementation-plan.md)

## Stack

Electron + React + TypeScript, built with [electron-vite](https://electron-vite.org). SQLite via `better-sqlite3` in the main process; the renderer talks to it over typed IPC (contracts in `src/shared/ipc.ts`).

## Development

```sh
npm install        # postinstall rebuilds better-sqlite3 for Electron
npm run dev        # launch the app with renderer HMR
npm test           # vitest, runs under system Node
npm run typecheck  # tsc for both node (main/preload) and web (renderer) targets
npm run lint
npm run build      # production build to out/
```

## Agent layer

All model access goes through one interface (`src/main/agent/provider/types.ts`): streaming `chat`, schema-validated `structured`, and `embed`. No provider-specific type crosses that seam, so `ask.ts` and the UI have no idea who is answering.

Behind it, `openai-compatible` is a single implementation covering every endpoint that speaks the OpenAI wire format — **OpenRouter (default), Groq, DeepSeek, Together, OpenAI, and local Ollama / LM Studio**. Switching between them is a `baseUrl` + `model` edit, not new code.

```sh
cp .env.example .env   # then paste your key in; .env is gitignored
npm run dev

TANGENT_MOCK_LLM=1 npm run dev        # deterministic canned provider, fully offline
```

Keys are read at startup from `.env`, in this order — **first definition wins, and a real environment variable beats both files**, so `OPENROUTER_API_KEY=… npm run dev` still overrides for one run:

1. `<userData>/tangent/.env` — the per-install file a settings UI would write (Phase 7)
2. `<project root>/.env` — the dev convenience

Keys are deliberately kept out of `agent.json` and the DB, so the data dir stays safe to copy as a backup. Endpoint and model selection *are* in `<userData>/tangent/agent.json`:

```json
{
  "provider": "openai-compatible",
  "baseUrl": "https://openrouter.ai/api/v1",
  "model": "deepseek/deepseek-v4-flash",
  "embeddingProvider": "voyage",
  "embeddingModel": "voyage-3.5-lite"
}
```

Some endpoints worth knowing (prices per MTok, checked 2026-07-26 — for scale, the Opus tier is $5/$25):

| Endpoint | `baseUrl` | Example `model` | Cost | Key |
|---|---|---|---|---|
| OpenRouter *(default)* | `https://openrouter.ai/api/v1` | `deepseek/deepseek-v4-flash` | $0.14 / $0.28 | `OPENROUTER_API_KEY` |
| OpenRouter, a tier up | ″ | `deepseek/deepseek-v4-pro` | $0.435 / $0.87 | ″ |
| OpenRouter, cheapest useful | ″ | `openai/gpt-oss-120b` | $0.037 / $0.17 | ″ |
| Groq | `https://api.groq.com/openai/v1` | *(open models, very fast)* | varies | `OPENAI_API_KEY` |
| Ollama / LM Studio | `http://localhost:11434/v1` | `llama3.1:8b` | free, offline | *none needed* |

**Embeddings are a separate vendor** — chat aggregators like OpenRouter don't serve them. Voyage is the default (`VOYAGE_API_KEY`); setting `"embeddingProvider": "openai-compatible"` points them at `embeddingBaseUrl` instead (OpenAI's `text-embedding-3-small`, or Ollama's `nomic-embed-text` for a free local option) using `EMBEDDING_API_KEY`. Nothing needs embeddings until Phase 5.

Missing keys don't block launch: the app starts, the composer names the variable to set, and the ask fails on that entry rather than at startup. A `localhost` endpoint is never warned about, since local servers authenticate nothing.

**Ask AI.** Asking writes the question Entry *and* its `ai_response` Entry before any network call, then streams the reply into the second one over `agent:delta` / `agent:end` (the push half of the IPC contract, in `src/shared/ipc.ts`). An `ai_response` with an empty body and no live stream is the failed state — retryable, and it survives a relaunch without a status column. A lost network call is never a lost question.

## Native module notes (better-sqlite3)

`better-sqlite3` v13 ships a **Node-API** build, so the same compiled binary loads under both Electron's bundled Node and the system Node — verified in this repo against Electron 43 (Node 24) and system Node 22. That means:

- `npm test` runs vitest under plain system Node with no rebuild step.
- The `postinstall` script still runs `electron-rebuild -w better-sqlite3` as insurance against a future version dropping Node-API or a new native dependency being added (it no-ops when the existing build already matches the ABI).
- The Electron **major version is pinned** in `devDependencies` deliberately — it's the ABI anchor. Bump it consciously, then re-verify `npm test` and `npm run dev` both still load the native module.

Version pins that matter: `vite@^7` (electron-vite 5 does not support Vite 8) with `@vitejs/plugin-react@^5` to match.

## Layout

```
src/
├── main/       # Electron main process
│   ├── agent/  #   LLM provider abstraction, context assembly, ask-AI flow
│   ├── db/     #   connection, migrations, repos (one per entity), bootstrap
│   └── ipc/    #   typed ipcMain.handle registrations, one file per domain
├── preload/    # contextBridge — the only bridge between renderer and main
├── renderer/   # React UI (panes, sidebar)
└── shared/     # entity types + IPC contracts, imported by all three
tests/          # vitest, exercises main-process layers directly

App data lives in `app.getPath('userData')` (macOS: `~/Library/Application Support/tangent/`):
`tangent.db` plus `documents/` for imported sources — one folder, so backup is a copy command.
```
