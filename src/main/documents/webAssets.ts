import { createHash } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { assetDir, assetFilename, assetUrl, extensionFor } from './assetPaths'
import { isReachableFrom } from './hosts'
import type { ClippedImage } from './webClip'

/**
 * Pull a clipped article's images onto disk and point its markdown at them.
 *
 * Network access is injected rather than imported so this is exercisable from
 * tests without Electron or a socket — the same seam the rest of web import
 * uses. In the app the injected implementation fetches on the clip session, so
 * image requests carry the same headers the page load did and survive hotlink
 * protection.
 */

/** Enough for a long, figure-heavy technical post; short of a gallery. */
export const MAX_IMAGES = 40
const MAX_IMAGE_BYTES = 5_000_000
const MAX_TOTAL_BYTES = 25_000_000
/** Downloads are latency-bound, so a few at a time turns 40 sequential round
 *  trips into something that finishes while the user is still reading the
 *  title. A pool rather than batches of six: image latency is heavy-tailed
 *  (CDN hit vs. cold origin), and a barrier every six makes the whole run wait
 *  on each batch's slowest member — measurably about twice the wall time. */
const CONCURRENCY = 6

export interface FetchedBytes {
  bytes: Uint8Array
  contentType: string | null
}

export type FetchBytes = (url: string) => Promise<FetchedBytes>

export interface AssetResult {
  /** Placeholder → `tangent://` URL, for images that made it. */
  replacements: Map<string, string>
  /** Images that were dropped: unreachable, too big, past the cap, or of a
   *  type we won't serve. Reported rather than silently swallowed. */
  skipped: number
}

export async function downloadImages(
  images: ClippedImage[],
  options: {
    documentId: string
    documentsDir: string
    pageUrl: string
    fetchBytes: FetchBytes
  },
): Promise<AssetResult> {
  const { documentId, documentsDir, pageUrl, fetchBytes } = options
  const replacements = new Map<string, string>()
  if (images.length === 0) return { replacements, skipped: 0 }

  const page = new URL(pageUrl)
  const allowed = images.filter((image) => reachable(image, page))
  const withinCap = allowed.slice(0, MAX_IMAGES)
  let skipped = images.length - withinCap.length

  const destination = assetDir(documentsDir, documentId)
  await mkdir(destination, { recursive: true })

  // Downloaded concurrently, accounted in document order: which request happens
  // to return first must not decide which images fit under the byte cap.
  const fetched: (FetchedBytes | null)[] = new Array(withinCap.length).fill(null)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, withinCap.length) }, async () => {
      for (let i = next++; i < withinCap.length; i = next++) {
        try {
          fetched[i] = await fetchBytes(withinCap[i].url)
        } catch {
          fetched[i] = null
        }
      }
    }),
  )

  let totalBytes = 0
  for (const [i, image] of withinCap.entries()) {
    const bytes = fetched[i]
    if (!bytes || totalBytes + bytes.bytes.length > MAX_TOTAL_BYTES) {
      skipped++
      continue
    }
    const written = await write(bytes, image, destination, documentId)
    if (!written) {
      skipped++
      continue
    }
    totalBytes += bytes.bytes.length
    replacements.set(image.placeholder, written)
  }

  return { replacements, skipped }
}

function reachable(image: ClippedImage, page: URL): boolean {
  try {
    return isReachableFrom(new URL(image.url), page)
  } catch {
    return false
  }
}

/** Returns the `tangent://` URL, or null if the response wasn't an image we're
 *  willing to store. */
async function write(
  fetched: FetchedBytes,
  image: ClippedImage,
  destination: string,
  documentId: string,
): Promise<string | null> {
  if (fetched.bytes.length === 0 || fetched.bytes.length > MAX_IMAGE_BYTES) return null

  const extension = extensionFor(fetched.contentType, image.url)
  if (!extension) return null

  // Content-addressed by source URL: two articles quoting the same diagram
  // don't collide, and re-running an import is idempotent.
  const digest = createHash('sha256').update(image.url).digest('hex')
  const filename = assetFilename(digest, extension)
  await writeFile(join(destination, filename), fetched.bytes)
  return assetUrl(documentId, filename)
}

/**
 * Swap placeholders for the URLs that resolved. An image that didn't make it
 * degrades to its alt text — a remote URL left in place would be blocked by the
 * renderer's CSP, so a broken image is the one outcome worth ruling out.
 */
export function applyAssetUrls(markdown: string, replacements: Map<string, string>): string {
  return markdown.replace(
    /!\[([^\]]*)\]\((tangent-asset:\d+)\)/g,
    (_match, alt: string, placeholder: string) => {
      const url = replacements.get(placeholder)
      return url ? `![${alt}](${url})` : alt
    },
  )
}
