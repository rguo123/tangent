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

## Native module notes (better-sqlite3)

`better-sqlite3` v13 ships a **Node-API** build, so the same compiled binary loads under both Electron's bundled Node and the system Node — verified in this repo against Electron 43 (Node 24) and system Node 22. That means:

- `npm test` runs vitest under plain system Node with no rebuild step.
- The `postinstall` script still runs `electron-rebuild -w better-sqlite3` as insurance against a future version dropping Node-API or a new native dependency being added (it no-ops when the existing build already matches the ABI).
- The Electron **major version is pinned** in `devDependencies` deliberately — it's the ABI anchor. Bump it consciously, then re-verify `npm test` and `npm run dev` both still load the native module.

Version pins that matter: `vite@^7` (electron-vite 5 does not support Vite 8) with `@vitejs/plugin-react@^5` to match.

## Layout

```
src/
├── main/       # Electron main process: DB, documents, agent layer, IPC handlers
├── preload/    # contextBridge — the only bridge between renderer and main
├── renderer/   # React UI (panes, sidebar)
└── shared/     # entity types + IPC contracts, imported by all three
tests/          # vitest, exercises main-process layers directly
```
