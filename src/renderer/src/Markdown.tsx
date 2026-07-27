import { useMemo } from 'react'
import { renderMarkdown } from './lib/markdown'

/**
 * Rendered markdown body. Safe to hand model output or user notes — see
 * `lib/markdown` for what the renderer strips.
 *
 * The memo holds the `dangerouslySetInnerHTML` *object*, not just the string:
 * React compares that prop by identity and rewrites the whole subtree when it
 * changes, so a fresh literal would re-render every entry's HTML — and drop any
 * selection in it — every time the timeline reloads.
 */
export default function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => ({ __html: renderMarkdown(source) }), [source])
  return <div className={`markdown-body ${className ?? ''}`} dangerouslySetInnerHTML={html} />
}
