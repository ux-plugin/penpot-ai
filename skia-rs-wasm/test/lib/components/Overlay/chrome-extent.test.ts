import { describe, expect, it } from 'vitest'
import { chromeExtent } from '../../../../src/lib/components/Overlay/chrome-extent'

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
/** A matrix scaled uniformly by s (what a motion `scale` keyframe produces). */
const scaled = (s: number) => ({ a: s, b: 0, c: 0, d: s, e: 0, f: 0 })
/** 90° rotation — scale factors are 1, so extent must be rotation-invariant. */
const ROT90 = { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 }

describe('chromeExtent', () => {
  it('reports the on-screen size of a normal box and is not degenerate', () => {
    const e = chromeExtent({ width: 100, height: 50, transform: IDENTITY }, 1)
    expect(e.screenWidth).toBeCloseTo(100, 6)
    expect(e.screenHeight).toBeCloseTo(50, 6)
    expect(e.degenerate).toBe(false)
  })

  it('folds the viewport zoom into the on-screen size', () => {
    const e = chromeExtent({ width: 100, height: 50, transform: IDENTITY }, 2)
    expect(e.screenWidth).toBeCloseTo(200, 6)
    expect(e.screenHeight).toBeCloseTo(100, 6)
  })

  it('is degenerate at scale 0 — the singular case that collapses the chrome', () => {
    const e = chromeExtent({ width: 100, height: 50, transform: scaled(0) }, 1)
    expect(e.screenWidth).toBeCloseTo(0, 6)
    expect(e.degenerate).toBe(true)
  })

  it('is degenerate while a scale animation is still near zero', () => {
    // 100px * 0.02 = 2px on screen — far below the 10px floor.
    expect(chromeExtent({ width: 100, height: 50, transform: scaled(0.02) }, 1).degenerate).toBe(true)
  })

  it('recovers as the scale animation grows back past the floor', () => {
    expect(chromeExtent({ width: 100, height: 50, transform: scaled(0.5) }, 1).degenerate).toBe(false)
  })

  it('is degenerate for a genuinely tiny shape and when zoomed far out', () => {
    expect(chromeExtent({ width: 2, height: 2, transform: IDENTITY }, 1).degenerate).toBe(true)
    // A healthy 100px shape at 2% zoom is 2px on screen.
    expect(chromeExtent({ width: 100, height: 100, transform: IDENTITY }, 0.02).degenerate).toBe(true)
  })

  it('is rotation-invariant (a rotated box is not degenerate)', () => {
    const e = chromeExtent({ width: 100, height: 50, transform: ROT90 }, 1)
    expect(e.screenWidth).toBeCloseTo(100, 6)
    expect(e.screenHeight).toBeCloseTo(50, 6)
    expect(e.degenerate).toBe(false)
  })

  it('treats a negative scale (mirror/flip) as a normal, usable box', () => {
    // Only exactly-zero scale is singular; flips are invertible and must stay editable.
    expect(chromeExtent({ width: 100, height: 50, transform: scaled(-1) }, 1).degenerate).toBe(false)
  })

  it('treats missing or non-finite input as degenerate', () => {
    expect(chromeExtent(null, 1).degenerate).toBe(true)
    expect(chromeExtent({ width: NaN, height: 50, transform: IDENTITY }, 1).degenerate).toBe(true)
  })

  it('falls back to zoom 1 for a non-finite zoom instead of producing NaN', () => {
    const e = chromeExtent({ width: 100, height: 50, transform: IDENTITY }, 0)
    expect(e.screenWidth).toBeCloseTo(100, 6)
    expect(e.degenerate).toBe(false)
  })
})
