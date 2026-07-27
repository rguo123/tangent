import { useRef, type CSSProperties, type ReactNode } from 'react'
import { useLayoutStore, weightFor, type PaneId } from '../state/layoutStore'
import { resizePair } from './splitMath'

/**
 * A row (or column) of resizable panes with drag handles between them.
 *
 * Generic on purpose: it knows nothing about documents or notes, only ids and
 * minimum sizes, so a future vertical split (say, review below the reader) is
 * `direction="vertical"` rather than new code. Sizes live in `layoutStore` —
 * see the note there on why weights beat pixels.
 *
 * The drag math never reads the store's numbers back as pixels. It measures
 * the two neighbor elements at pointer-down, converts the pointer delta with
 * that pane pair's own px-per-weight ratio, and writes both weights at once.
 * So dividers stay glued to the cursor regardless of what else is on screen,
 * and a container that has no width yet simply can't be dragged.
 */

export type SplitDirection = 'horizontal' | 'vertical'

export interface SplitPane {
  /** Stable across mounts — it's the key the size is stored under. */
  id: PaneId
  node: ReactNode
  /** Px floor. The drag stops here instead of squashing the pane away. */
  minSize?: number
}

const DEFAULT_MIN_SIZE = 120

/** Px a divider moves per arrow-key press. */
const KEYBOARD_STEP = 24

interface Axis {
  pointerPos: (e: { clientX: number; clientY: number }) => number
  sizeOf: (el: HTMLElement) => number
  /** Arrow keys that shrink / grow the pane before the divider. */
  shrinkKey: string
  growKey: string
}

const AXES: Record<SplitDirection, Axis> = {
  horizontal: {
    pointerPos: (e) => e.clientX,
    sizeOf: (el) => el.getBoundingClientRect().width,
    shrinkKey: 'ArrowLeft',
    growKey: 'ArrowRight',
  },
  vertical: {
    pointerPos: (e) => e.clientY,
    sizeOf: (el) => el.getBoundingClientRect().height,
    shrinkKey: 'ArrowUp',
    growKey: 'ArrowDown',
  },
}

export default function SplitView({
  panes,
  direction = 'horizontal',
  className,
}: {
  panes: SplitPane[]
  direction?: SplitDirection
  className?: string
}) {
  const weights = useLayoutStore((s) => s.weights)
  const setPairWeights = useLayoutStore((s) => s.setPairWeights)
  const resetPanes = useLayoutStore((s) => s.resetPanes)
  const axis = AXES[direction]
  // Keyed by pane id, not index, so a toggled-off pane can't leave a stale
  // element behind for a divider to measure.
  const paneEls = useRef(new Map<PaneId, HTMLDivElement>())

  /** Move the divider between `a` and `b` by `deltaPx`, measured from where
   *  the panes were when the gesture started. */
  const applyDelta = (
    a: SplitPane,
    b: SplitPane,
    deltaPx: number,
    startSizes: [number, number],
  ) => {
    const next = resizePair({
      startSizes,
      weights: [weightFor(weights, a.id), weightFor(weights, b.id)],
      minSizes: [a.minSize ?? DEFAULT_MIN_SIZE, b.minSize ?? DEFAULT_MIN_SIZE],
      deltaPx,
    })
    if (next) setPairWeights(a.id, next[0], b.id, next[1])
  }

  const measure = (pane: SplitPane): number => {
    const el = paneEls.current.get(pane.id)
    return el ? axis.sizeOf(el) : 0
  }

  const children: ReactNode[] = []
  panes.forEach((pane, index) => {
    if (index > 0) {
      const before = panes[index - 1]
      children.push(
        <Divider
          key={`divider:${before.id}:${pane.id}`}
          direction={direction}
          label={`Resize ${before.id} and ${pane.id}`}
          onDragStart={() => [measure(before), measure(pane)] as [number, number]}
          onDrag={(deltaPx, startSizes) => applyDelta(before, pane, deltaPx, startSizes)}
          onReset={() => resetPanes([before.id, pane.id])}
        />,
      )
    }
    const minSize = pane.minSize ?? DEFAULT_MIN_SIZE
    const style: CSSProperties = { flexGrow: weightFor(weights, pane.id), flexBasis: 0 }
    if (direction === 'horizontal') style.minWidth = minSize
    else style.minHeight = minSize
    children.push(
      <div
        key={pane.id}
        className="split-pane"
        data-pane-id={pane.id}
        ref={(el) => {
          if (el) paneEls.current.set(pane.id, el)
          else paneEls.current.delete(pane.id)
        }}
        style={style}
      >
        {pane.node}
      </div>,
    )
  })

  return (
    <div className={['split', `split-${direction}`, className].filter(Boolean).join(' ')}>
      {children}
    </div>
  )
}

/**
 * The handle itself. A 1px line with a fat invisible hit area, so it looks
 * like a seam and grabs like a grip.
 *
 * Pointer capture means the drag survives the cursor outrunning the handle —
 * with a min-size clamp in play that happens constantly — and it ends on
 * pointerup wherever that lands, so there are no window listeners to leak.
 */
function Divider({
  direction,
  label,
  onDragStart,
  onDrag,
  onReset,
}: {
  direction: SplitDirection
  label: string
  onDragStart: () => [number, number]
  onDrag: (deltaPx: number, startSizes: [number, number]) => void
  onReset: () => void
}) {
  const axis = AXES[direction]
  const drag = useRef<{ origin: number; startSizes: [number, number] } | null>(null)

  const nudge = (deltaPx: number) => onDrag(deltaPx, onDragStart())

  // Also the pointercancel path (a system gesture stealing the pointer,
  // say) — otherwise the body stays selection-locked with no drag in flight.
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    e.currentTarget.classList.remove('dragging')
    document.body.classList.remove('resizing', `resizing-${direction}`)
  }

  return (
    <div
      className="split-divider"
      role="separator"
      aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
      aria-label={label}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        drag.current = { origin: axis.pointerPos(e), startSizes: onDragStart() }
        e.currentTarget.setPointerCapture(e.pointerId)
        e.currentTarget.classList.add('dragging')
        // Panes are full of selectable text; without this a drag paints half
        // the document blue on the way past.
        document.body.classList.add('resizing', `resizing-${direction}`)
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        onDrag(axis.pointerPos(e) - drag.current.origin, drag.current.startSizes)
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === axis.shrinkKey) nudge(-KEYBOARD_STEP)
        else if (e.key === axis.growKey) nudge(KEYBOARD_STEP)
        else return
        e.preventDefault()
      }}
    />
  )
}
