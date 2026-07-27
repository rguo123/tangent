import { useEffect, useRef, useState } from 'react'
import { activeComposerKind, useTimelineStore } from '../../state/timelineStore'

/**
 * Entry composer. Bodies are stored as the markdown source you typed and
 * rendered on read, so this is a plain textarea: a rich-text editor here would
 * spend its features on formatting that `getText()` throws away — a Cmd+B that
 * looks bold in the box and saves as plain text is worse than no Cmd+B. It also
 * matches the textarea an existing entry is edited in. Enter submits,
 * Shift+Enter breaks a line. When a document selection armed a draft anchor, it
 * shows as a chip above the input and the submitted entry is anchored to it.
 *
 * The note/ask switch decides which path the submission takes: a note is one
 * Entry, an ask is a question Entry plus a streamed `ai_response`. A draft
 * anchor carries its own kind (the selection menu already asked), so it wins.
 */
export default function Composer() {
  const draft = useTimelineStore((s) => s.draft)
  const clearDraft = useTimelineStore((s) => s.clearDraft)
  const setComposerMode = useTimelineStore((s) => s.setComposerMode)
  const agentStatus = useTimelineStore((s) => s.agentStatus)
  const asking = useTimelineStore(activeComposerKind) === 'question'

  const [body, setBody] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const submit = () => {
    const trimmed = body.trim()
    if (!trimmed) return
    void useTimelineStore.getState().submitEntry(trimmed)
    setBody('')
  }

  // Picking note/ask in the document pane should land you typing immediately.
  useEffect(() => {
    if (draft) inputRef.current?.focus()
  }, [draft])

  return (
    <div className="composer">
      {draft && (
        <div className="composer-draft">
          <span className="composer-draft-kind">{asking ? 'Ask about' : 'Note on'}</span>
          <span className="composer-draft-quote" title={draft.selector.exact}>
            “{draft.selector.exact}”
          </span>
          <button className="composer-draft-clear" title="Remove anchor" onClick={clearDraft}>
            ✕
          </button>
        </div>
      )}
      <div className="composer-modes">
        <button
          className={!asking ? 'composer-mode on' : 'composer-mode'}
          disabled={draft !== null}
          onClick={() => setComposerMode('note')}
        >
          Note
        </button>
        <button
          className={asking ? 'composer-mode on' : 'composer-mode'}
          disabled={draft !== null}
          onClick={() => setComposerMode('question')}
        >
          Ask
        </button>
        {asking && agentStatus && (
          <span
            className="composer-model"
            title={[
              agentStatus.baseUrl && `Endpoint: ${agentStatus.baseUrl}`,
              `Embeddings: ${agentStatus.embeddingModel} (${agentStatus.embeddingProvider})`,
            ]
              .filter(Boolean)
              .join('\n')}
          >
            {agentStatus.model}
          </span>
        )}
      </div>
      {asking && agentStatus?.unavailable && (
        <p className="composer-warning">{agentStatus.unavailable}</p>
      )}
      <textarea
        ref={inputRef}
        className="composer-editor"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div className="composer-hint">
        Enter to {asking ? 'ask' : 'save'} · Shift+Enter for a new line · Markdown supported
      </div>
    </div>
  )
}
