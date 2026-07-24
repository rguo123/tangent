/**
 * IPC contract shared between main, preload, and renderer.
 *
 * Every channel is a key in `IpcContract`, mapping to its request/response
 * types. Main registers handlers through `handle()` (src/main/ipc) and the
 * renderer calls through `invoke()` (src/preload) — both derive their
 * signatures from this one map, so the two sides cannot drift.
 */

import type { Anchor, Document, Entry, TextQuoteSelector, Thread, ThreadStatus } from './entities'

/** A thread joined with its document — what the sidebar renders. */
export interface ThreadListItem {
  thread: Thread
  document: Document
}

export interface ImportResult {
  document: Document
  thread: Thread
}

/** What the document pane renders. PDFs cross the bridge as bytes; text
 *  sources as their content string. chat_transcript never reaches here —
 *  its content is the thread's entry timeline. */
export type DocumentContent =
  | { sourceType: 'pdf'; data: Uint8Array }
  | { sourceType: 'markdown' | 'generated'; content: string }

/** Everything the notes pane renders for one thread, in one round trip. */
export interface TimelineData {
  entries: Entry[]
  anchors: Anchor[]
}

export interface CreateEntryRequest {
  threadId: string
  /** ai_response entries are created by the agent path (Phase 4), never over this channel. */
  kind: 'note' | 'question'
  body: string
  /** Present when the entry is anchored to a document selection — the anchor
   *  and entry are created in one transaction. */
  anchor?: { documentId: string; selector: TextQuoteSelector }
}

export interface CreateEntryResult {
  entry: Entry
  anchor: Anchor | null
}

export interface DebugVersions {
  electron: string
  chrome: string
  node: string
  sqlite: string
}

/** Row counts per table — dev-only visibility into the DB. */
export interface DbStats {
  tables: Record<string, number>
}

export interface IpcContract {
  /** Opens a native file picker in main; null when the user cancels. */
  'documents:import': { request: void; response: ImportResult | null }
  'documents:content': { request: { documentId: string }; response: DocumentContent }
  /** All threads (active and archived) for the default Field, newest first. */
  'threads:list': { request: void; response: ThreadListItem[] }
  'threads:setStatus': { request: { threadId: string; status: ThreadStatus }; response: void }
  'timeline:get': { request: { threadId: string }; response: TimelineData }
  'entries:create': { request: CreateEntryRequest; response: CreateEntryResult }
  /** Bumps updated_at — the extraction watermark (spec §5.1) depends on it. */
  'entries:updateBody': { request: { entryId: string; body: string }; response: Entry }
  'debug:versions': { request: void; response: DebugVersions }
  'debug:dbStats': { request: void; response: DbStats }
}

export type IpcChannel = keyof IpcContract
export type IpcRequest<C extends IpcChannel> = IpcContract[C]['request']
export type IpcResponse<C extends IpcChannel> = IpcContract[C]['response']
