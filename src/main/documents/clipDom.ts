import { parseHTML } from 'linkedom'

/**
 * The DOM, as much of it as web import touches.
 *
 * The main process has no DOM lib, and shouldn't — adding one to the node
 * tsconfig would let `window.foo` typecheck in a process that has no window.
 * But extraction genuinely does manipulate a document; linkedom provides one at
 * runtime while typing it as `Window & typeof globalThis`, which resolves to
 * nothing useful here.
 *
 * So the contract is written out. It doubles as an inventory of exactly how
 * much DOM surface the feature depends on, which is less than it looks.
 */

export interface ClipNode {
  nodeName: string
  textContent: string | null
}

export interface ClipElement extends ClipNode {
  firstChild: ClipElement | null
  parentElement: ClipElement | null
  childNodes: Iterable<ClipNode>
  innerHTML: string
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  remove(): void
  replaceWith(...nodes: ClipNode[]): void
  prepend(...nodes: ClipNode[]): void
  querySelector(selectors: string): ClipElement | null
  querySelectorAll(selectors: string): Iterable<ClipElement>
}

export interface ClipDocument {
  head: ClipElement
  body: ClipElement
  createElement(name: string): ClipElement
  querySelector(selectors: string): ClipElement | null
  querySelectorAll(selectors: string): Iterable<ClipElement>
}

export function parseDocument(html: string): ClipDocument {
  return (parseHTML(html) as unknown as { document: ClipDocument }).document
}
