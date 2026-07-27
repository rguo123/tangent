/**
 * Fixture pages for web-import tests.
 *
 * Readability scores candidates by text length and gives up well under a
 * thousand characters, so every fixture needs a real article's worth of prose
 * in it before it will extract anything at all. That threshold is the reason
 * this is shared: it is an assumption about a dependency, and it should be
 * stated once rather than rediscovered per test file.
 */

const PROSE = Array.from(
  { length: 6 },
  (_, i) =>
    `<p>Paragraph ${i} of the article body, long enough that Readability treats this element as the primary content of the page rather than boilerplate to be discarded.</p>`,
).join('')

/** An article surrounded by the chrome extraction is supposed to remove. */
export function articlePage(body: string): string {
  return `<!doctype html><html><head><title>Raft</title></head><body>
    <nav><a href="/">Home</a><a href="/about">About</a></nav>
    <aside class="ad"><a href="https://ads.example/buy">Buy something</a></aside>
    <article>${body}</article>
    <footer>Copyright notice nobody wants to read.</footer>
  </body></html>`
}

/** The filler itself, for tests that need to pad their own markup. */
export { PROSE }
