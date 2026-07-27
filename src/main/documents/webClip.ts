import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import { createSlugger } from '@shared/slug'
import { parseDocument, type ClipDocument, type ClipElement } from './clipDom'
import { isHttpUrl } from './hosts'

/**
 * A web page → the markdown a Document is made of (spec §2, Documents).
 *
 * Pure: no Electron, no network, no disk. The page arrives as already-fetched
 * HTML and images leave as placeholders for someone else to download, which is
 * what lets the whole contract be exercised from fixtures — the same reason the
 * file picker lives in the IPC layer rather than in `import.ts`.
 *
 * The pipeline is Readability (Firefox's reader mode) for "which part of this
 * page is the article", then Turndown for "say it in markdown". Everything in
 * between is rewriting the two things that don't survive the trip on their own:
 * links and images.
 */

/** Bounds the work, because linkedom and Readability both run synchronously on
 *  the main thread — an uncapped document would freeze the UI rather than
 *  merely cost something. */
const MAX_HTML_CHARS = 8_000_000

/**
 * Readability answers "which part of this page is most article-like", not "is
 * any of it an article" — handed a page of nothing but navigation it returns
 * the navigation, wrapped in a div, and calls it a day. Without a floor that
 * imports as an empty Document. Set well below a short blog post (a one-link
 * aside on simonwillison.net measures ~800 characters).
 */
const MIN_ARTICLE_CHARS = 200

/** Where lazy-loading sites stash the real image before JS runs. Checked in
 *  order; the clip window usually renders these itself, but a page that
 *  loads images on scroll past the fold can still leave them behind. */
const LAZY_SRC_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-hi-res-src']

export interface ClippedImage {
  /** Absolute http(s) URL, as it appeared on the page. */
  url: string
  /** The opaque token standing in for it in `markdown`, until a caller
   *  resolves it to a local file. */
  placeholder: string
}

export interface ClippedArticle {
  title: string
  byline: string | null
  siteName: string | null
  markdown: string
  /** Deduplicated: one entry per distinct URL, however often it appears. */
  images: ClippedImage[]
}

/** Thrown when there is no article to be had — a link farm, a login wall, a
 *  page Readability can't score. Distinct from a network failure: the fetch
 *  worked, there just isn't a document in it. */
export class NoArticleError extends Error {
  constructor(url: string) {
    super(`No readable article found at ${url}`)
    this.name = 'NoArticleError'
  }
}

export function clipArticle(html: string, pageUrl: string): ClippedArticle {
  if (html.length > MAX_HTML_CHARS) {
    throw new Error(`Page is too large to import (${Math.round(html.length / 1e6)}MB)`)
  }
  const page = new URL(pageUrl)

  const document = parseDocument(html)
  setBase(document, page.href)
  promoteLazyImages(document)

  // linkedom's document satisfies Readability at runtime; the cast is only
  // needed because its declared type is a DOM one this process doesn't have.
  const article = new Readability(
    document as unknown as ConstructorParameters<typeof Readability>[0],
    {
      // Readability strips class attributes by default, which takes
      // `language-ts` on code blocks with it — the one attribute Turndown
      // reads. Classes can't reach the renderer anyway: markdown has none.
      keepClasses: true,
      // Hand back the article element rather than its serialization. The
      // default flattens the extracted tree to a string, which we would only
      // parse straight back into the same tree — ~10% of this function's
      // main-thread time on a large page, for nothing. `textContent` below is
      // computed before serialization either way.
      serializer: (element: unknown) => element,
    },
  ).parse()
  if (!article?.content) throw new NoArticleError(pageUrl)
  if ((article.textContent?.trim().length ?? 0) < MIN_ARTICLE_CHARS) {
    throw new NoArticleError(pageUrl)
  }

  const content = article.content as unknown as ClipElement
  rewriteLinks(content, page)
  const images = rewriteImages(content, page)

  const markdown = turndown().turndown(content.innerHTML).trim()
  if (!markdown) throw new NoArticleError(pageUrl)

  return {
    title: article.title?.trim() || page.hostname,
    byline: article.byline?.trim() || null,
    siteName: article.siteName?.trim() || null,
    markdown,
    images,
  }
}

/**
 * linkedom resolves no relative URLs of its own, so Readability's
 * `_fixRelativeUris` pass has nothing to work from and leaves `/img/a.png` as
 * it found it. A `<base>` gives it one — verified to produce output identical
 * to jsdom's, which does resolve them natively.
 */
function setBase(document: ClipDocument, href: string): void {
  const existing = document.querySelector('base')
  if (existing) {
    existing.setAttribute('href', href)
    return
  }
  const base = document.createElement('base')
  base.setAttribute('href', href)
  document.head.prepend(base)
}

/** Give `<img>` a real `src` before Readability judges it: an image whose only
 *  source is `data-src` looks empty, and empty images get dropped. */
function promoteLazyImages(document: ClipDocument): void {
  for (const img of document.querySelectorAll('img')) {
    const src = img.getAttribute('src')
    if (!src || src.startsWith('data:')) {
      const lazy = LAZY_SRC_ATTRS.map((a) => img.getAttribute(a)).find(Boolean)
      if (lazy) img.setAttribute('src', lazy)
    }
    // `srcset` (on the img, or on a <picture>'s <source>) is a comma-separated
    // list of candidates; the last is conventionally the largest.
    if (!img.getAttribute('src')) {
      const set =
        img.getAttribute('srcset') ??
        img.parentElement?.querySelector('source')?.getAttribute('srcset')
      const largest = set?.split(',').pop()?.trim().split(/\s+/)[0]
      if (largest) img.setAttribute('src', largest)
    }
  }
}

/**
 * Four cases, and the distinction that matters is where the link goes rather
 * than what it looks like:
 *
 *  - a fragment naming a heading that survived extraction stays a fragment, and
 *    moves the reader inside the document;
 *  - a fragment whose target Readability dropped (Wikipedia's `#cite_note-*`,
 *    all 82 of them) becomes an absolute URL, so it opens the original page at
 *    that spot instead of dangling;
 *  - an http(s) link is left alone — `setWindowOpenHandler` in main already
 *    routes those to the OS browser;
 *  - anything else loses its href and stays as text.
 */
function rewriteLinks(content: ClipElement, page: URL): void {
  const slugFor = headingSlugs(content)
  const pageWithoutHash = stripHash(page)

  for (const link of content.querySelectorAll('a[href]')) {
    const target = resolve(link.getAttribute('href'), page)
    if (!target) {
      unwrap(link)
      continue
    }

    const isSamePage = stripHash(target) === pageWithoutHash && target.hash.length > 1
    if (isSamePage) {
      const slug = slugFor.get(decodeURIComponent(target.hash.slice(1)))
      link.setAttribute('href', slug ? `#${slug}` : target.href)
      continue
    }

    if (isHttpUrl(target)) {
      link.setAttribute('href', target.href)
    } else {
      unwrap(link)
    }
  }
}

/** Absolute URL, or null if it isn't one — the shape every rewrite pass wants,
 *  since each does something different with the failure. */
function resolve(raw: string | null, base: URL): URL | null {
  if (!raw) return null
  try {
    return new URL(raw, base)
  } catch {
    return null
  }
}

/** Map every id/name a heading answers to → the slug it will carry once
 *  rendered. Built with the same slugger the renderer uses, walking the same
 *  document order, so the two sides produce identical strings. */
function headingSlugs(content: ClipElement): Map<string, string> {
  const slugger = createSlugger()
  const byOriginalId = new Map<string, string>()

  for (const heading of content.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const slug = slugger(heading.textContent ?? '')
    const id = heading.getAttribute('id')
    if (id) byOriginalId.set(id, slug)
    // A heading is often preceded by an empty <a name="…"> or wraps one.
    for (const named of heading.querySelectorAll('a[id], a[name]')) {
      const value = named.getAttribute('id') ?? named.getAttribute('name')
      if (value) byOriginalId.set(value, slug)
    }
    byOriginalId.set(slug, slug)
  }
  return byOriginalId
}

/** Collect images as placeholders. Only http(s) survives — a `data:` URI is
 *  unbounded and a `file:` one is somebody else's disk. */
function rewriteImages(content: ClipElement, page: URL): ClippedImage[] {
  const byUrl = new Map<string, ClippedImage>()

  for (const img of content.querySelectorAll('img')) {
    const url = resolve(img.getAttribute('src'), page)
    if (!url || !isHttpUrl(url)) {
      img.remove()
      continue
    }

    let image = byUrl.get(url.href)
    if (!image) {
      image = { url: url.href, placeholder: `tangent-asset:${byUrl.size}` }
      byUrl.set(url.href, image)
    }
    // Only `src` needs rewriting: Turndown's image rule reads nothing else, and
    // `keepReplacement` guarantees no element ever reaches the markdown as raw
    // HTML, so no other attribute has a way out.
    img.setAttribute('src', image.placeholder)
  }
  return [...byUrl.values()]
}

/** Drop the element, keep what it said. */
function unwrap(element: ClipElement): void {
  element.replaceWith(...element.childNodes)
}

function stripHash(url: URL): string {
  return `${url.origin}${url.pathname}${url.search}`
}

function turndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    hr: '---',
    /**
     * Turndown's answer for an element it can't express in markdown is to emit
     * the raw HTML — and the gfm plugin uses that for every table without a
     * header row, which on Wikipedia means the whole infobox.
     *
     * That HTML has nowhere good to go. The renderer escapes raw HTML by
     * policy, so it would surface as literal `<table class="infobox">` in the
     * reading pane, and any image inside it would keep an unsubstituted asset
     * placeholder, since the substitution matches markdown image syntax rather
     * than tags.
     *
     * `content` is those same children already converted to markdown. Losing
     * the grid is a real cost; showing the markup instead is a worse one.
     */
    keepReplacement: (content: string) => (content.trim() ? `\n\n${content}\n\n` : ''),
  })
  service.use(gfm)

  // Turndown reads the fence language off `<code class="language-x">`, but
  // plenty of sites put it on the `<pre>` instead, and highlighters leave the
  // code split across a span per token. This handles both and flattens the
  // spans back to text.
  service.addRule('fencedCodeWithLanguage', {
    filter: (node) =>
      node.nodeName === 'PRE' && !!node.firstChild && node.firstChild.nodeName === 'CODE',
    replacement: (_content, node) => {
      const element = node as unknown as ClipElement
      const code = element.firstChild as unknown as ClipElement
      const classes = `${element.getAttribute('class') ?? ''} ${code.getAttribute('class') ?? ''}`
      const language = classes.match(/(?:language|lang|highlight)-(\S+)/)?.[1] ?? ''
      const text = (code.textContent ?? '').replace(/\n+$/, '')
      // A fence has to be longer than the longest backtick run it contains.
      const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
      const fence = '`'.repeat(Math.max(3, longest + 1))
      return `\n\n${fence}${language}\n${text}\n${fence}\n\n`
    },
  })

  return service
}
