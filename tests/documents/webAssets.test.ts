import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveAssetPath } from '../../src/main/documents/assetPaths'
import {
  applyAssetUrls,
  downloadImages,
  MAX_IMAGES,
  type FetchBytes,
} from '../../src/main/documents/webAssets'

import type { ClippedImage } from '../../src/main/documents/webClip'

const DOC_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const PAGE = 'https://example.com/post'

let documentsDir: string

beforeEach(() => {
  documentsDir = mkdtempSync(join(tmpdir(), 'tangent-assets-'))
})
afterEach(() => {
  rmSync(documentsDir, { recursive: true, force: true })
})

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])

function images(...urls: string[]): ClippedImage[] {
  return urls.map((url, i) => ({ url, placeholder: `tangent-asset:${i}` }))
}

/** Serves the same PNG for anything asked of it, recording the asks. URLs in
 *  `failing` reject instead. */
function stubFetch(
  overrides: Record<string, Partial<{ bytes: Uint8Array; contentType: string }>> = {},
  failing: string[] = [],
) {
  const asked: string[] = []
  const fetchBytes: FetchBytes = async (url) => {
    asked.push(url)
    if (failing.includes(url)) throw new Error('network')
    const override = overrides[url]
    return {
      bytes: override?.bytes ?? PNG_BYTES,
      contentType: override?.contentType ?? 'image/png',
    }
  }
  return { fetchBytes, asked }
}

/** The options object is the same every time but for the page URL. */
function download(imgs: ClippedImage[], fetchBytes: FetchBytes, pageUrl = PAGE) {
  return downloadImages(imgs, { documentId: DOC_ID, documentsDir, pageUrl, fetchBytes })
}

describe('downloadImages', () => {
  it('writes each image and maps its placeholder to a tangent:// URL', async () => {
    const { fetchBytes } = stubFetch()
    const result = await download(images('https://cdn.test/a.png'), fetchBytes)

    expect(result.skipped).toBe(0)
    const url = result.replacements.get('tangent-asset:0')!
    expect(url).toMatch(new RegExp(`^tangent://assets/${DOC_ID}/[0-9a-f]{64}\\.png$`))

    const filename = url.split('/').pop()!
    const onDisk = readdirSync(join(documentsDir, DOC_ID))
    expect(onDisk).toEqual([filename])
    expect(readFileSync(join(documentsDir, DOC_ID, filename))).toEqual(Buffer.from(PNG_BYTES))

    // The name the protocol handler will be asked for resolves back to it.
    expect(resolveAssetPath(documentsDir, DOC_ID, filename)?.path).toBe(
      join(documentsDir, DOC_ID, filename),
    )
  })

  it('never asks for a private-network image on a public page', async () => {
    const { fetchBytes, asked } = stubFetch()
    const result = await download(
      images('http://169.254.169.254/latest/meta-data/', 'https://cdn.test/ok.png'),
      fetchBytes,
    )

    expect(asked).toEqual(['https://cdn.test/ok.png'])
    expect(result.skipped).toBe(1)
    expect(result.replacements.size).toBe(1)
  })

  it('keeps same-host images when the page itself is local', async () => {
    const { fetchBytes, asked } = stubFetch()
    await download(
      images('http://localhost:3000/img/a.png'),
      fetchBytes,
      'http://localhost:3000/post',
    )
    expect(asked).toEqual(['http://localhost:3000/img/a.png'])
  })

  it('caps the number of images and reports the remainder', async () => {
    const many = images(
      ...Array.from({ length: MAX_IMAGES + 5 }, (_, i) => `https://cdn.test/${i}.png`),
    )
    const { fetchBytes, asked } = stubFetch()
    const result = await download(many, fetchBytes)

    expect(asked).toHaveLength(MAX_IMAGES)
    expect(result.replacements.size).toBe(MAX_IMAGES)
    expect(result.skipped).toBe(5)
  })

  it('skips oversized responses and ones that are not images', async () => {
    const { fetchBytes } = stubFetch({
      'https://cdn.test/big.png': { bytes: new Uint8Array(5_000_001) },
      'https://cdn.test/page.png': { contentType: 'text/html' },
    })
    const result = await download(
      images('https://cdn.test/big.png', 'https://cdn.test/page.png', 'https://cdn.test/ok.png'),
      fetchBytes,
    )

    expect(result.skipped).toBe(2)
    expect([...result.replacements.keys()]).toEqual(['tangent-asset:2'])
  })

  it('survives a download that throws', async () => {
    const { fetchBytes } = stubFetch({}, ['https://cdn.test/gone.png'])
    const result = await download(
      images('https://cdn.test/gone.png', 'https://cdn.test/ok.png'),
      fetchBytes,
    )
    expect(result.skipped).toBe(1)
    expect([...result.replacements.keys()]).toEqual(['tangent-asset:1'])
  })

  it('names files by content, so the same image twice is one file', async () => {
    const { fetchBytes } = stubFetch()
    const a = await download(images('https://cdn.test/same.png'), fetchBytes)
    const b = await download(images('https://cdn.test/same.png'), fetchBytes)
    expect(a.replacements.get('tangent-asset:0')).toBe(b.replacements.get('tangent-asset:0'))
    expect(readdirSync(join(documentsDir, DOC_ID))).toHaveLength(1)
  })
})

describe('applyAssetUrls', () => {
  it('substitutes resolved placeholders', () => {
    const map = new Map([['tangent-asset:0', 'tangent://assets/doc/abc.png']])
    expect(applyAssetUrls('before ![A](tangent-asset:0) after', map)).toBe(
      'before ![A](tangent://assets/doc/abc.png) after',
    )
  })

  it('degrades an image that never arrived to its alt text', () => {
    expect(applyAssetUrls('see ![Diagram](tangent-asset:3) here', new Map())).toBe(
      'see Diagram here',
    )
  })

  it('leaves ordinary links alone', () => {
    const markdown = '[link](https://example.com) and `tangent-asset:0` in code'
    expect(applyAssetUrls(markdown, new Map())).toBe(markdown)
  })
})
