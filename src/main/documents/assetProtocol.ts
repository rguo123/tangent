import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { Readable } from 'stream'
import { protocol } from 'electron'
import { ASSET_HOST, ASSET_SCHEME, resolveAssetPath } from './assetPaths'

/**
 * `tangent://assets/<documentId>/<file>` — how a clipped article's images reach
 * the renderer.
 *
 * The alternative was widening the renderer's CSP to allow remote images, which
 * would put every tracking pixel in an article back on the network and make a
 * document stop rendering the day its host goes away. Downloading at import and
 * serving from disk costs a custom scheme and buys both back.
 *
 * The scheme is handled on the **default session only**. Clipped pages load in
 * their own partition, which therefore has no handler for it — a page cannot
 * read `tangent://assets/<some-other-document>/…` however it asks. Verified
 * against Electron 43: the URL that loads in the app renderer is blocked from a
 * clip-partition page, and the handler never sees the request.
 */

/** Must run before app-ready. `standard` gives the scheme real URL parsing;
 *  `secure` keeps it from counting as a mixed-content downgrade. */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true } },
  ])
}

export function registerAssetProtocol(documentsDir: string): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    if (url.hostname !== ASSET_HOST) return notFound()

    const [, documentId = '', filename = ''] = url.pathname.split('/')
    const asset = resolveAssetPath(documentsDir, safeDecode(documentId), safeDecode(filename))
    if (!asset) return notFound()

    let size: number
    try {
      size = (await stat(asset.path)).size
    } catch {
      return notFound()
    }

    return new Response(Readable.toWeb(createReadStream(asset.path)) as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': asset.contentType,
        'Content-Length': String(size),
        // An SVG is inert inside an <img>, but not if something navigates to it
        // directly. These make that case inert too: no script, no subresources,
        // and no re-reading the bytes as anything but what the extension says.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        'X-Content-Type-Options': 'nosniff',
        // Filenames are content digests and documents are immutable after
        // import, so a cached asset can never be the wrong one. Without this
        // every pane mount re-reads and re-decodes the whole image set.
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  })
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function notFound(): Response {
  return new Response('Not found', { status: 404 })
}
