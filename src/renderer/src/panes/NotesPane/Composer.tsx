import { useEffect, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { activeComposerKind, useTimelineStore } from '../../state/timelineStore'

/**
 * Entry composer. Tiptap so the composing surface matches the markdown read
 * view's stack; bodies are stored as plain text for now (rich formatting is a
 * later concern, not a schema change). Enter submits, Shift+Enter breaks a
 * line. When a document selection armed a draft anchor, it shows as a chip
 * above the input and the submitted entry is anchored to it.
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

  // handleKeyDown is captured once at editor creation; route through a ref so
  // submission always sees current editor/store state.
  const submitRef = useRef<() => void>(() => {})

  const editor = useEditor({
    extensions: [StarterKit],
    editorProps: {
      handleKeyDown: (_view, event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          submitRef.current()
          return true
        }
        return false
      },
    },
  })

  submitRef.current = () => {
    if (!editor) return
    const body = editor.getText().trim()
    if (!body) return
    void useTimelineStore.getState().submitEntry(body)
    editor.commands.clearContent()
  }

  // Picking note/ask in the document pane should land you typing immediately.
  useEffect(() => {
    if (draft && editor) editor.commands.focus()
  }, [draft, editor])

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
      <EditorContent editor={editor} className="composer-editor" />
      <div className="composer-hint">
        Enter to {asking ? 'ask' : 'save'} · Shift+Enter for a new line
      </div>
    </div>
  )
}
