import { useEffect } from 'react'
import { useAppStore } from './state/appStore'
import { useExtractionStore } from './state/extractionStore'

/** Long enough to read and act on, short enough that it never becomes furniture. */
const DISMISS_MS = 8_000

/**
 * The one thing a silent background write says out loud (spec §7): what it did,
 * and an undo while the memory of writing the note is still fresh. It gets a
 * corner, not a dialog — extraction is not something to respond to.
 */
export default function ExtractionChip() {
  const notice = useExtractionStore((s) => s.notice)
  const dismiss = useExtractionStore((s) => s.dismiss)
  const undo = useExtractionStore((s) => s.undo)

  // A repeat of the same notice keeps its object identity, so the timer runs
  // from when the chip appeared rather than restarting on the echo.
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(dismiss, DISMISS_MS)
    return () => clearTimeout(timer)
  }, [notice, dismiss])

  if (!notice) return null

  return (
    <div className={notice.failed ? 'extraction-chip failed' : 'extraction-chip'} role="status">
      <span className="extraction-chip-text">{notice.text}</span>
      {/* Drafts are the one extraction output that needs the user; the chip is
          where they hear about it, so it's also the way in. */}
      {notice.cardsAdded > 0 && (
        <button
          className="extraction-chip-action"
          onClick={() => useAppStore.getState().openArtifactsPane()}
        >
          cull
        </button>
      )}
      {notice.batchId && (
        <button className="extraction-chip-action" onClick={() => void undo()}>
          undo
        </button>
      )}
      <button className="extraction-chip-close" title="Dismiss" onClick={dismiss}>
        ✕
      </button>
    </div>
  )
}
