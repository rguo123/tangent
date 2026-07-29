import { create } from 'zustand'

/**
 * Pane sizing for the resizable shell.
 *
 * Sizes are **weights, not pixels**: a pane's share of its container is its
 * weight over the sum of the visible panes' weights. Three consequences, all
 * of them the reason it's modeled this way:
 *
 * - "How much of the window does it take up" is the thing being stored, so a
 *   window resize keeps the split the user chose instead of drifting.
 * - Closing a pane (or opening one) redistributes proportionally with no
 *   bookkeeping — the ratio between the survivors is untouched.
 * - The renderer just hands the weight to `flex-grow`, so the browser does the
 *   layout and there is no measure-then-set loop to keep in sync.
 *
 * Defaults sum to 1 within a container, so they read as percentages.
 *
 * Not persisted yet (deliberate — Phase 7 owns settings). When it is, the
 * whole job is: hydrate `weights` at startup and subscribe to it here, since
 * this store is the only writer.
 */

/** Any stable string. The known ones have defaults below; anything else — a
 *  pane added later, a placeholder — starts at `FALLBACK_WEIGHT`. */
export type PaneId = string

export const DEFAULT_PANE_WEIGHTS: Record<PaneId, number> = {
  sidebar: 0.16,
  document: 0.46,
  notes: 0.38,
  // The other three are the default layout and read as percentages of it.
  // Artifacts opens on top of them, taking its share proportionally — which is
  // the whole reason weights beat pixels.
  artifacts: 0.3,
}

const FALLBACK_WEIGHT = 1

interface LayoutState {
  weights: Record<PaneId, number>
  /** A divider only ever trades size between its two neighbors, so both sides
   *  land in one write — the pair's sum is conserved and no other pane moves. */
  setPairWeights: (a: PaneId, aWeight: number, b: PaneId, bWeight: number) => void
  /** Double-click a divider → both its neighbors go back to defaults. */
  resetPanes: (ids: PaneId[]) => void
}

export const useLayoutStore = create<LayoutState>((set) => ({
  weights: { ...DEFAULT_PANE_WEIGHTS },

  setPairWeights: (a, aWeight, b, bWeight) =>
    set((s) => ({ weights: { ...s.weights, [a]: aWeight, [b]: bWeight } })),

  resetPanes: (ids) =>
    set((s) => {
      const weights = { ...s.weights }
      for (const id of ids) weights[id] = defaultWeightFor(id)
      return { weights }
    }),
}))

export function defaultWeightFor(id: PaneId): number {
  return DEFAULT_PANE_WEIGHTS[id] ?? FALLBACK_WEIGHT
}

/** Weight to render a pane at, falling back for ids the store hasn't seen. */
export function weightFor(weights: Record<PaneId, number>, id: PaneId): number {
  return weights[id] ?? defaultWeightFor(id)
}
