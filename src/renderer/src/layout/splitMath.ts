/**
 * The one piece of arithmetic behind a divider drag, kept pure so it can be
 * tested without a DOM.
 *
 * A drag only ever trades size between the divider's two neighbors. Sizes are
 * measured in px once, at pointer-down; weights come from the layout store.
 * The pair's combined weight is invariant, so the px↔weight ratio computed
 * here stays valid for the whole gesture and the divider tracks the cursor
 * exactly, however the rest of the layout is sized.
 */
export function resizePair(input: {
  /** Px sizes of the two panes when the gesture started. */
  startSizes: [number, number]
  /** Their current weights — the pair's sum is what gets redistributed. */
  weights: [number, number]
  /** Px floors; the drag stops at them instead of squashing a pane away. */
  minSizes: [number, number]
  /** Pointer travel since the gesture started, positive = toward the second. */
  deltaPx: number
}): [number, number] | null {
  const [aSize, bSize] = input.startSizes
  const [aWeight, bWeight] = input.weights
  const [minA, minB] = input.minSizes

  const totalPx = aSize + bSize
  const totalWeight = aWeight + bWeight
  // Nothing measurable to divide (container not laid out yet), or a container
  // too small to honor both floors — a clamp there would invert and snap the
  // split somewhere arbitrary, so leave it alone.
  if (totalPx <= 0 || totalWeight <= 0 || minA + minB > totalPx) return null

  const pxPerWeight = totalPx / totalWeight
  const aNext = Math.min(Math.max(aSize + input.deltaPx, minA), totalPx - minB)
  return [aNext / pxPerWeight, (totalPx - aNext) / pxPerWeight]
}
