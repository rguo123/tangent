/**
 * PDF → plain text, in the main process, for agent context assembly.
 *
 * The renderer already has a text layer (pdf.js paints it for highlights), but
 * context assembly happens in main where the DB and the agent live — pulling
 * text back across the bridge would make the agent depend on a pane being open.
 * So main runs pdf.js headlessly over the same file.
 *
 * Two details worth keeping:
 *  - `legacy/build/pdf.mjs` is the build that runs outside a browser.
 *  - The import goes through `new Function` so the CJS main bundle can't
 *    rewrite `import()` into `require()` — this package is ESM-only.
 */

import { createRequire } from 'module'
import { pathToFileURL } from 'url'

const PDFJS_SPECIFIER = 'pdfjs-dist/legacy/build/pdf.mjs'

const importEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<PdfjsModule>

let pdfjs: Promise<PdfjsModule> | null = null

/** Resolved to an absolute file URL first: `new Function` hides the import
 *  from the bundler, which also means the host resolves the specifier with no
 *  module context of its own. Loaded once and reused. */
function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjs) pdfjs = importPdfjs()
  return pdfjs
}

async function importPdfjs(): Promise<PdfjsModule> {
  const resolved = createRequire(import.meta.url).resolve(PDFJS_SPECIFIER)
  const url = pathToFileURL(resolved).href
  try {
    return await importEsm(url)
  } catch {
    // Vitest evaluates modules in a VM with no dynamic-import callback, so the
    // `new Function` form can't resolve anything under the test runner. A
    // plain import works there; in the app build the branch above already
    // succeeded, so this one is never reached.
    return (await import(/* @vite-ignore */ url)) as PdfjsModule
  }
}

interface TextItem {
  str?: string
  hasEOL?: boolean
}

interface PdfjsModule {
  getDocument(params: {
    data: Uint8Array
    isEvalSupported?: boolean
    useSystemFonts?: boolean
  }): { promise: Promise<PdfDocument> }
}

interface PdfDocument {
  numPages: number
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: TextItem[] }> }>
  destroy(): Promise<void>
}

/**
 * Extract text page by page, stopping once `maxChars` is reached — a long book
 * would otherwise cost more in tokens than it adds in grounding. Pages are
 * separated by blank lines so the model can see the boundaries.
 */
export async function extractPdfText(data: Uint8Array, maxChars: number): Promise<string> {
  const { getDocument } = await loadPdfjs()
  const doc = await getDocument({ data, isEvalSupported: false, useSystemFonts: false }).promise

  try {
    const pages: string[] = []
    let total = 0
    for (let n = 1; n <= doc.numPages && total < maxChars; n++) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      const text = content.items
        .map((item) => (item.str ?? '') + (item.hasEOL ? '\n' : ''))
        .join('')
        .trim()
      if (!text) continue
      pages.push(text)
      total += text.length
    }
    return pages.join('\n\n').slice(0, maxChars)
  } finally {
    await doc.destroy()
  }
}
