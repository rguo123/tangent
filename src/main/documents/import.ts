import { copyFileSync, readFileSync, rmSync } from 'fs'
import { basename, extname, join } from 'path'
import type { ImportResult, DocumentContent } from '@shared/ipc'
import type { Storage } from '../db/init'
import { newId } from '../db/util'
import { assetDir } from './assetPaths'
import { applyAssetUrls, downloadImages, type FetchBytes } from './webAssets'
import type { FetchPage } from './webFetch'

/**
 * Document import + content reading (spec §2, Documents).
 *
 * PDFs are copied into the app-managed documents dir — path references break
 * silently when files move. `content_ref` stores just the filename (relative
 * to documentsDir), so the whole data dir stays relocatable. Markdown is read
 * once and stored inline in `content_ref`; the original file is never
 * referenced again. Documents are immutable after import — there is no update
 * path here by design.
 *
 * No Electron imports in this module: the file picker lives in the IPC layer
 * so tests can drive imports with plain paths.
 */

const SOURCE_TYPE_BY_EXT = {
  '.pdf': 'pdf',
  '.md': 'markdown',
  '.markdown': 'markdown',
} as const

export const IMPORT_FILE_FILTERS = [
  { name: 'Documents', extensions: ['pdf', 'md', 'markdown'] },
  { name: 'PDF', extensions: ['pdf'] },
  { name: 'Markdown', extensions: ['md', 'markdown'] },
]

/** Import a source file into the default Field: copy/inline the content,
 *  create the Document row, and open a first Thread against it. */
export function importDocument(storage: Storage, filePath: string): ImportResult {
  const ext = extname(filePath).toLowerCase()
  const sourceType = SOURCE_TYPE_BY_EXT[ext as keyof typeof SOURCE_TYPE_BY_EXT]
  if (!sourceType) throw new Error(`Unsupported file type: ${ext || filePath}`)

  const field = storage.repos.fields.getDefault()
  const title = basename(filePath, ext)
  const id = newId()

  let contentRef: string
  if (sourceType === 'pdf') {
    contentRef = `${id}.pdf`
    copyFileSync(filePath, join(storage.documentsDir, contentRef))
  } else {
    contentRef = readFileSync(filePath, 'utf8')
  }

  try {
    // Document + first Thread commit together or not at all, like every
    // cross-entity write (cf. src/main/db/timeline.ts).
    return storage.db.transaction((): ImportResult => {
      const document = storage.repos.documents.create({
        id,
        fieldId: field.id,
        title,
        sourceType,
        contentRef,
      })
      const thread = storage.repos.threads.create({
        fieldId: field.id,
        documentId: document.id,
        title,
      })
      return { document, thread }
    })()
  } catch (err) {
    // Don't leave an orphaned copy behind if the row insert failed.
    if (sourceType === 'pdf') rmSync(join(storage.documentsDir, contentRef), { force: true })
    throw err
  }
}

export interface WebImportDeps {
  fetchPage: FetchPage
  fetchBytes: FetchBytes
}

/**
 * Import a web article. Same shape as the file path above — content inlined,
 * Document and first Thread committed together — with two differences: the
 * markdown is extracted rather than read, and the images it references are
 * pulled onto disk under `documents/<id>/` first.
 *
 * Both halves of the network are injected, so this is drivable from tests
 * without Electron or a socket, for the same reason the file picker lives in
 * the IPC layer rather than here.
 */
export async function importUrlDocument(
  storage: Storage,
  url: string,
  deps: WebImportDeps,
): Promise<ImportResult> {
  const page = await deps.fetchPage(url)

  // Loaded on first use, not at startup: linkedom and turndown cost ~50ms to
  // evaluate, and most launches never clip anything. This path already waits
  // seconds on the network, so the load is invisible here.
  const { clipArticle } = await import('./webClip')
  const article = clipArticle(page.html, page.finalUrl)

  const field = storage.repos.fields.getDefault()
  const id = newId()

  // Assets land before the row exists, so a failed insert has something to
  // clean up rather than something to leak — the same order the PDF path uses.
  const assets = await downloadImages(article.images, {
    documentId: id,
    documentsDir: storage.documentsDir,
    pageUrl: page.finalUrl,
    fetchBytes: deps.fetchBytes,
  })
  if (assets.skipped > 0) {
    console.warn(
      `${url}: ${assets.skipped} image(s) skipped (unreachable, oversized, or past the cap)`,
    )
  }
  const markdown = applyAssetUrls(article.markdown, assets.replacements)

  try {
    return storage.db.transaction((): ImportResult => {
      const document = storage.repos.documents.create({
        id,
        fieldId: field.id,
        title: article.title,
        sourceType: 'markdown',
        contentRef: markdown,
        sourceUrl: page.finalUrl,
      })
      const thread = storage.repos.threads.create({
        fieldId: field.id,
        documentId: document.id,
        title: article.title,
      })
      return { document, thread }
    })()
  } catch (err) {
    rmSync(assetDir(storage.documentsDir, id), { recursive: true, force: true })
    throw err
  }
}

/** Resolve a Document's renderable content: PDF bytes from the managed copy,
 *  or the inline text blob. */
export function readDocumentContent(storage: Storage, documentId: string): DocumentContent {
  const doc = storage.repos.documents.getById(documentId)
  if (!doc) throw new Error(`No such document: ${documentId}`)
  switch (doc.sourceType) {
    case 'pdf':
      return { sourceType: 'pdf', data: readFileSync(join(storage.documentsDir, doc.contentRef!)) }
    case 'markdown':
    case 'generated':
      return { sourceType: doc.sourceType, content: doc.contentRef! }
    case 'chat_transcript':
      throw new Error('chat_transcript documents have no standalone content (spec §3.3)')
  }
}
