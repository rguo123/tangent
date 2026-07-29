import { useState, type KeyboardEvent } from 'react'
import type { Flashcard } from '@shared/entities'

/**
 * Editing a draft during the cull pass. Two plain textareas, matching the
 * entry composer: card bodies are stored as the markdown you typed and
 * rendered on read, so there is nothing for a rich editor to add.
 *
 * Saving marks the card user-edited, which permanently shields it from
 * regeneration — the reader's wording wins over the model's, forever.
 */
export default function CardEditor({
  card,
  onSave,
  onCancel,
}: {
  card: Flashcard
  onSave: (front: string, back: string) => void
  onCancel: () => void
}) {
  const [front, setFront] = useState(card.front)
  const [back, setBack] = useState(card.back)
  const dirty = front.trim() !== card.front || back.trim() !== card.back
  const valid = front.trim() !== '' && back.trim() !== ''

  const save = () => {
    if (!valid) return
    if (dirty) onSave(front.trim(), back.trim())
    else onCancel()
  }

  // The pane's shortcuts are single letters, so every keystroke in here has to
  // stop before reaching them — otherwise typing "a" accepts the card.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    event.stopPropagation()
    if (event.key === 'Escape') onCancel()
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save()
  }

  return (
    <article className="card card-editing" onKeyDown={onKeyDown}>
      <label className="card-field">
        <span>Front</span>
        <textarea value={front} onChange={(e) => setFront(e.target.value)} autoFocus rows={2} />
      </label>
      <label className="card-field">
        <span>Back</span>
        <textarea value={back} onChange={(e) => setBack(e.target.value)} rows={4} />
      </label>
      <div className="card-actions">
        <button className="card-action primary" onClick={save} disabled={!valid}>
          Save
        </button>
        <button className="card-action" onClick={onCancel}>
          Cancel
        </button>
        <span className="card-hint">⌘Enter to save · Esc to cancel</span>
      </div>
    </article>
  )
}
