/**
 * Which hosts a clipped page is allowed to reach (spec: threat model T2/T7).
 *
 * A page we import controls where it redirects and what image URLs it carries,
 * so both are treated as untrusted input pointed at the network this machine
 * happens to sit on. The interesting boundary isn't the internet — it's the
 * loopback interface and the LAN, where unauthenticated services live.
 *
 * The asymmetry that makes this usable: a URL the *user typed* is trusted
 * however private it is, because clipping your own `localhost:3000` is a
 * legitimate thing to want. Only what the *page* then asks for is filtered.
 *
 * No Electron here — this is string classification, and it's the part worth
 * testing.
 */

const PRIVATE_V4 = [
  /^127\./, // loopback
  /^10\./, // RFC1918
  /^192\.168\./, // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918
  /^169\.254\./, // link-local
  /^0\./, // "this network"
]

/**
 * Hostname-based, which is the honest limit: a public name that resolves to
 * 127.0.0.1 (DNS rebinding) passes this check. Closing that needs resolution
 * before connect, which Chromium doesn't hand us. Documented, not defended.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')

  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  if (host === '::1' || host === '::') return true
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true
  if (PRIVATE_V4.some((re) => re.test(host))) return true
  // A bare hostname with no dots is a LAN name, not an internet one.
  if (!host.includes('.') && !host.includes(':')) return true

  return false
}

/** The only two schemes anything in web import will follow. */
export function isHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:'
}

/**
 * Can `target` be fetched while clipping a document that came from `origin`?
 *
 * Public hosts always. Private ones only when the document itself came from
 * private space — so a clipped localhost dev server keeps its own images,
 * while a page on the open internet cannot reach into your network.
 */
export function isReachableFrom(target: URL, origin: URL): boolean {
  if (!isHttpUrl(target)) return false
  if (!isPrivateHost(target.hostname)) return true
  return isPrivateHost(origin.hostname)
}
