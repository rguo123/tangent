import { describe, expect, it } from 'vitest'
import { resizePair } from '../../src/renderer/src/layout/splitMath'

/** 600px + 400px of pane sharing 1.0 of weight — 1px is 0.001 weight. */
const BASE = {
  startSizes: [600, 400] as [number, number],
  weights: [0.6, 0.4] as [number, number],
  minSizes: [100, 100] as [number, number],
}

describe('resizePair', () => {
  it('converts pointer travel into weight 1:1 with pixels', () => {
    const [a, b] = resizePair({ ...BASE, deltaPx: 100 })!
    expect(a).toBeCloseTo(0.7)
    expect(b).toBeCloseTo(0.3)
  })

  it('conserves the pair total, so panes outside the drag never move', () => {
    for (const deltaPx of [-500, -37, 0, 12, 900]) {
      const [a, b] = resizePair({ ...BASE, deltaPx })!
      expect(a + b).toBeCloseTo(1.0)
    }
  })

  it('stops at each pane s floor instead of squashing it', () => {
    const shrunk = resizePair({ ...BASE, deltaPx: -9999 })!
    expect(shrunk[0]).toBeCloseTo(0.1) // 100px of 1000px
    const grown = resizePair({ ...BASE, deltaPx: 9999 })!
    expect(grown[1]).toBeCloseTo(0.1)
  })

  it('is independent of the weight scale — only the ratio matters', () => {
    const scaled = resizePair({ ...BASE, weights: [6, 4], deltaPx: 100 })!
    expect(scaled[0] / (scaled[0] + scaled[1])).toBeCloseTo(0.7)
  })

  it('declines to resize a container it cannot measure', () => {
    expect(resizePair({ ...BASE, startSizes: [0, 0], deltaPx: 50 })).toBeNull()
  })

  it('declines when the floors no longer fit, rather than snapping', () => {
    expect(resizePair({ ...BASE, minSizes: [700, 700], deltaPx: 50 })).toBeNull()
  })
})
