import { BrowserWindow, session, type Session } from 'electron'
import { isHttpUrl, isPrivateHost } from './hosts'
import type { FetchBytes } from './webAssets'

/**
 * Fetch a page the way a browser would, because for a growing share of the web
 * nothing less works.
 *
 * Measured over twenty representative URLs, a plain HTTP fetch produced a
 * usable article for 11; loading the same URLs in a real Chromium produced 16,
 * with no regressions. The gap was almost entirely anti-bot challenges
 * (Cloudflare's "Just a moment", Reddit's verification interstitial) rather
 * than single-page apps — walls that no amount of parsing cleverness gets past,
 * and that a real browser simply walks through.
 *
 * So this is the only fetch path, not a fallback. A fallback would need a "was
 * that good enough?" heuristic, which is both throwaway work and wrong in the
 * dangerous direction: a cookie-wall stub clears any character threshold and
 * gets imported as though it were the article.
 *
 * This module runs untrusted JavaScript on purpose. Everything below that looks
 * paranoid is load-bearing; see docs/web-import-plan.md §11.
 */

/** No `persist:` prefix, so the partition is in-memory: clips carry no cookies
 *  and leave none behind. Trading that for "log in once, clip your
 *  subscriptions" is a settings decision, not a default. */
const CLIP_PARTITION = 'tangent-clip'

const LOAD_TIMEOUT_MS = 20_000
/** After the network goes quiet, how long to let hydration finish. Measured:
 *  300ms already rescues five of six JS-dependent pages; 800ms buys the sixth
 *  without being felt. The lazy-load scroll runs inside this window rather than
 *  after it — nothing about the scroll depends on hydration having finished,
 *  and overlapping them gives the images it triggers the rest of the window to
 *  arrive instead of a bare 400ms of their own. */
const SETTLE_MS = 800
const LAZY_SCROLL_MS = 400

export interface FetchedPage {
  html: string
  /** Where the redirect chain actually ended — the base every relative URL in
   *  `html` resolves against. */
  finalUrl: string
}

export type FetchPage = (url: string) => Promise<FetchedPage>

let prepared: Session | null = null

/** One-time hardening of the clip session. Nothing here is per-page. */
function clipSession(): Session {
  if (prepared) return prepared
  const clip = session.fromPartition(CLIP_PARTITION)

  // Electron's default UA advertises Electron and the app name, which is both a
  // bot-detection trigger and more than a reader needs to disclose.
  clip.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  )
  // A page being read has no business asking for the camera, the microphone,
  // or a notification.
  clip.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  clip.setPermissionCheckHandler(() => false)
  clip.on('will-download', (event) => event.preventDefault())

  prepared = clip
  return clip
}

/**
 * Fetch bytes as the clipped page itself would have.
 *
 * Lives here rather than in the IPC layer because it depends on the clip
 * session, which this module owns: requests then carry the same headers and
 * connection pool as the page load — surviving hotlink protection — and usually
 * hit the cache that the page load already populated, since the clip window has
 * loaded every one of these images once already.
 */
export const fetchBytesViaClipSession: FetchBytes = async (url) => {
  const response = await clipSession().fetch(url)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get('content-type'),
  }
}

export async function fetchPageViaBrowser(url: string): Promise<FetchedPage> {
  const target = new URL(url)
  if (!isHttpUrl(target)) throw new Error(`Only http(s) URLs can be imported: ${url}`)

  // The user typed this one, so it is trusted however private it is — clipping
  // your own dev server is legitimate. Only where the *page* goes next is
  // filtered, and only into private space it didn't start in.
  const allowPrivate = isPrivateHost(target.hostname)

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 2400,
    webPreferences: {
      partition: CLIP_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // No preload: there is deliberately no bridge from the page to main.
      autoplayPolicy: 'document-user-activation-required',
      backgroundThrottling: false,
    },
  })
  clipSession()

  try {
    guardNavigation(win, allowPrivate)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    await withTimeout(load(win, url), LOAD_TIMEOUT_MS, `Timed out loading ${url}`)

    const html = await readOuterHtml(win)
    return { html, finalUrl: win.webContents.getURL() || target.href }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/**
 * A page can redirect itself anywhere, and whatever lands is what gets
 * serialized into the document. `will-redirect` fires with the *target* before
 * it is committed and `preventDefault` genuinely aborts the chain — verified
 * against Electron 43 rather than assumed.
 */
function guardNavigation(win: BrowserWindow, allowPrivate: boolean): void {
  const veto = (event: Electron.Event, next: string): void => {
    let url: URL
    try {
      url = new URL(next)
    } catch {
      event.preventDefault()
      return
    }
    const blocked = !isHttpUrl(url) || (!allowPrivate && isPrivateHost(url.hostname))
    if (blocked) {
      console.warn(`Blocked clip navigation to ${next}`)
      event.preventDefault()
    }
  }
  win.webContents.on('will-redirect', veto)
  win.webContents.on('will-navigate', veto)
}

/** Resolve once the page has stopped loading *and* had a moment to hydrate.
 *  `did-fail-load` for the main frame is fatal; sub-resource failures are not
 *  reported here and don't matter — a missing font never cost anyone an
 *  article. */
function load(win: BrowserWindow, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (): void => {
      // Not awaited: the scroll and the settle run concurrently, and the scroll
      // is best-effort besides.
      void triggerLazyLoading(win)
      setTimeout(() => resolve(), SETTLE_MS)
    }
    win.webContents.once('did-stop-loading', settle)
    win.webContents.on('did-fail-load', (_event, code, description, _validated, isMainFrame) => {
      // -3 is ERR_ABORTED, which is what a redirect looks like from here.
      if (isMainFrame && code !== -3) reject(new Error(`${description} (${code})`))
    })
    win.loadURL(url).catch(reject)
  })
}

/** Images below the fold often wait for a scroll that never comes in a window
 *  nobody is looking at. */
async function triggerLazyLoading(win: BrowserWindow): Promise<void> {
  try {
    await win.webContents.executeJavaScript(
      `new Promise((resolve) => {
         try { window.scrollTo(0, document.body.scrollHeight) } catch {}
         setTimeout(() => {
           try { window.scrollTo(0, 0) } catch {}
           resolve(true)
         }, ${LAZY_SCROLL_MS})
       })`,
    )
  } catch {
    // A page that refuses to be scrolled is still a page worth reading.
  }
}

async function readOuterHtml(win: BrowserWindow): Promise<string> {
  const html: unknown = await withTimeout(
    win.webContents.executeJavaScript('document.documentElement.outerHTML'),
    LOAD_TIMEOUT_MS,
    'Timed out reading the page',
  )
  if (typeof html !== 'string' || !html) throw new Error('The page returned no content')
  // Size is not checked here: the string is already in this process's heap by
  // the time it could be, and `clipArticle` refuses an oversized page a few
  // microseconds later with the message that belongs to it.
  return html
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    work.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}
