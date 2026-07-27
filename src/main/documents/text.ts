import type { Storage } from '../db/init'
import { truncate } from '../util'
import { readDocumentContent } from './import'
import { extractPdfText } from './pdfText'

/**
 * A Document as plain text, for anything that feeds it to a model.
 *
 * Built on `readDocumentContent` so `content_ref` semantics (managed file path
 * vs. inline blob) stay owned by one module — this one only knows how to turn
 * each content shape into characters.
 */

/** Documents are immutable after import, so text extracted once stays valid
 *  for the life of the process. The *promise* is cached, not the result:
 *  two questions asked while the first extraction is still running should
 *  join it rather than each parse the PDF again. */
const cache = new Map<string, Promise<string>>()

/**
 * `maxChars` bounds both the extraction and the result — a book would
 * otherwise cost more in tokens than it adds in grounding. Never throws: a
 * scanned or malformed source yields '' so callers can degrade rather than
 * fail.
 */
export function readDocumentText(
  storage: Storage,
  documentId: string,
  maxChars: number,
): Promise<string> {
  const cached = cache.get(documentId)
  if (cached) return cached

  const pending = extract(storage, documentId, maxChars).catch((err) => {
    console.warn(`Could not read text from document ${documentId}: ${String(err)}`)
    return ''
  })
  cache.set(documentId, pending)
  return pending
}

async function extract(storage: Storage, documentId: string, maxChars: number): Promise<string> {
  const document = storage.repos.documents.getById(documentId)
  // A chat_transcript's content *is* its thread's entries, which reach the
  // model as conversation — there's no standalone text to read.
  if (!document || document.sourceType === 'chat_transcript') return ''

  const content = readDocumentContent(storage, documentId)
  if (content.sourceType === 'pdf') {
    // pdf.js rejects a Buffer outright — it wants a plain Uint8Array view.
    return extractPdfText(new Uint8Array(content.data), maxChars)
  }
  // Truncate first: web clips make multi-hundred-KB markdown routine, and
  // stripping before bounding would scan and copy the whole document to keep
  // the first `maxChars` of it. Stripping only ever shortens, so the bound
  // still holds.
  return stripImages(truncate(content.content, maxChars))
}

/**
 * Replace image syntax with its alt text before a document reaches a model.
 *
 * An image URL is tokens a model can do nothing with; the alt text is the part
 * that carried meaning. Web clips make this worth doing rather than merely
 * tidy — their images are `tangent://assets/<uuid>/<64 hex chars>.png`, around
 * a hundred characters of content-addressed noise apiece, in a budget that is
 * already truncating the article.
 */
function stripImages(markdown: string): string {
  return markdown.replace(/!\[([^\]]*)\]\([^)\s]*\)/g, '$1')
}

/** Test hook — documents are immutable in the app, so nothing else needs this. */
export function clearDocumentTextCache(): void {
  cache.clear()
}
