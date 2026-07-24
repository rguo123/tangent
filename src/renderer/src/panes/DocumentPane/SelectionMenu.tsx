import type { PendingSelection } from './selection'

/** Floating note/ask affordance over a document selection. mousedown is
 *  swallowed so clicking a button doesn't collapse the selection first. */
export default function SelectionMenu({
  selection,
  onPick,
}: {
  selection: PendingSelection
  onPick: (kind: 'note' | 'question') => void
}) {
  return (
    <div
      className="selection-menu"
      style={{ left: selection.x, top: selection.y }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button onClick={() => onPick('note')}>Note</button>
      <button onClick={() => onPick('question')}>Ask</button>
    </div>
  )
}
