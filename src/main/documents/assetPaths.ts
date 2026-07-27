import { join, normalize, sep } from 'path'

/**
 * The naming and path rules behind `tangent://assets/<documentId>/<file>`.
 *
 * Split from the protocol registration so it holds no Electron import: these
 * rules are the security boundary for serving files off disk to the renderer,
 * which makes them the part that has to be directly testable.
 */

export const ASSET_SCHEME = 'tangent'
export const ASSET_HOST = 'assets'

/** Looked up, never sniffed — and the table doubles as the allowlist, so an
 *  extension that isn't here cannot be served at all. Nothing in it can be
 *  interpreted as a document. */
const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
}

export function contentTypeFor(extension: string): string | null {
  return CONTENT_TYPES[extension.toLowerCase().replace(/^\./, '')] ?? null
}

/**
 * Name the file an image should be stored as, or null to refuse it.
 *
 * Content-Type decides when it says something useful, so a CDN serving
 * `/photo?id=12` still produces a nameable file. The URL's extension is the
 * fallback, because plenty of hosts label perfectly good images
 * `application/octet-stream`.
 *
 * What the fallback must not do is rescue a response that announced itself as
 * something else entirely: a server answering `text/html` for `/page.png` is
 * not serving an image, whatever the path says.
 */
export function extensionFor(contentType: string | null, url: string): string | null {
  const fromType = contentType?.split(';')[0].trim().toLowerCase()
  if (fromType) {
    const match = Object.entries(CONTENT_TYPES).find(([, type]) => type === fromType)
    if (match) return match[0]
    const unknown = fromType === 'application/octet-stream' || fromType === 'binary/octet-stream'
    if (!fromType.startsWith('image/') && !unknown) return null
  }
  try {
    const path = new URL(url).pathname
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    if (contentTypeFor(extension)) return extension
  } catch {
    // Not a URL we can name a file from.
  }
  return null
}

export interface ResolvedAsset {
  path: string
  contentType: string
}

/** UUID, because that is what `newId()` mints, and a sha256 digest, because
 *  that is what the downloader names files. Attacker-supplied text reaches
 *  neither. */
const DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FILENAME = /^[0-9a-f]{64}\.([a-z0-9]{2,4})$/i

/** Where a document's downloaded images live. The writer, the rollback and the
 *  reader all go through this rather than each knowing the layout. */
export function assetDir(documentsDir: string, documentId: string): string {
  return join(documentsDir, documentId)
}

export function assetFilename(digest: string, extension: string): string {
  return `${digest}.${extension}`
}

export function assetUrl(documentId: string, filename: string): string {
  return `${ASSET_SCHEME}://${ASSET_HOST}/${documentId}/${filename}`
}

/**
 * Resolve a request to a file on disk, or null if anything about it is off.
 *
 * The regexes already exclude separators, dots and encodings, so traversal is
 * unreachable before the last check. It is made anyway: containment is the
 * property that actually matters, and asserting it directly is cheaper than
 * trusting two patterns to keep meaning what they mean today.
 */
export function resolveAssetPath(
  documentsDir: string,
  documentId: string,
  filename: string,
): ResolvedAsset | null {
  if (!DOCUMENT_ID.test(documentId)) return null
  const match = FILENAME.exec(filename)
  if (!match) return null
  const contentType = contentTypeFor(match[1])
  if (!contentType) return null

  // `join` normalizes, so the only thing left to arrange is that the prefix
  // test can't be satisfied by a sibling directory sharing the name.
  const resolved = join(assetDir(documentsDir, documentId), filename)
  const root = normalize(documentsDir)
  const prefix = root.endsWith(sep) ? root : root + sep
  return resolved.startsWith(prefix) ? { path: resolved, contentType } : null
}
