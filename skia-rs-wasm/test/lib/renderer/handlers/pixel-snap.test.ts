import { describe, expect, it } from 'vitest'
import {
  snapDrawRectToGrid,
  snapMoveDeltaToGrid,
} from '../../../../src/lib/renderer/handlers/pixel-snap'
import type { ViewportData } from '../../../../src/lib/renderer/viewport'

describe('snapMoveDeltaToGrid', () => {
  it('returns the delta unchanged when snapping is disabled (null baseline)', () => {
    expect(snapMoveDeltaToGrid({ x: 3.4, y: 7.8 }, null, false)).toEqual({ x: 3.4, y: 7.8 })
  })

  it('snaps the selection top-left onto the integer grid', () => {
    const base = { x: 0, y: 0 }
    const out = snapMoveDeltaToGrid({ x: 3.4, y: 7.8 }, base, false)
    expect(out).toEqual({ x: 3, y: 8 })
    // top-left lands on whole pixels
    expect(Number.isInteger(base.x + out.x)).toBe(true)
    expect(Number.isInteger(base.y + out.y)).toBe(true)
  })

  it('grids a fractional baseline (the first drag cleans it up)', () => {
    const base = { x: 10.3, y: 20.7 }
    const out = snapMoveDeltaToGrid({ x: 5.1, y: 5.1 }, base, false)
    // 10.3 + out.x === 15, 20.7 + out.y === 26
    expect(base.x + out.x).toBeCloseTo(15, 10)
    expect(base.y + out.y).toBeCloseTo(26, 10)
  })

  it('snaps both axes when shift is not held, even an axis that did not move', () => {
    const base = { x: 10.3, y: 20.7 }
    const out = snapMoveDeltaToGrid({ x: 0, y: 5.4 }, base, false)
    // x had no movement but is still gridded (matches the frontend both-axis snap)
    expect(base.x + out.x).toBeCloseTo(10, 10)
    expect(base.y + out.y).toBeCloseTo(26, 10)
  })

  it('leaves the shift-locked axis untouched (snap-ignore-axis)', () => {
    const base = { x: 10.3, y: 20.7 }
    const out = snapMoveDeltaToGrid({ x: 5.4, y: 0 }, base, true)
    // y is the locked axis (exactly 0) -> preserved, NOT snapped to the grid
    expect(out.y).toBe(0)
    expect(base.y + out.y).toBeCloseTo(20.7, 10) // unchanged
    // x is still snapped
    expect(base.x + out.x).toBeCloseTo(16, 10)
  })
})

describe('snapDrawRectToGrid', () => {
  const vp1: ViewportData = { panX: 0, panY: 0, zoom: 1 }

  it('rounds both world endpoints at zoom 1 (screen === world)', () => {
    const { world, screenRect } = snapDrawRectToGrid(
      { x: 10.4, y: 20.6, width: 30.2, height: 40.8 },
      vp1
    )
    // tl (10.4,20.6)->(10,21); br (40.6,61.4)->(41,61)
    expect(world).toEqual({ x: 10, y: 21, width: 31, height: 40 })
    // at zoom 1 / pan 0 the snapped screen rect equals the world rect
    expect(screenRect.x).toBe(10)
    expect(screenRect.y).toBe(21)
    expect(screenRect.width).toBe(31)
    expect(screenRect.height).toBe(40)
  })

  it('produces whole-number world geometry under zoom + pan', () => {
    const vp: ViewportData = { panX: 100, panY: 200, zoom: 2 }
    const { world } = snapDrawRectToGrid({ x: 11, y: 41, width: 61, height: 79 }, vp)
    expect(Number.isInteger(world.x)).toBe(true)
    expect(Number.isInteger(world.y)).toBe(true)
    expect(Number.isInteger(world.width)).toBe(true)
    expect(Number.isInteger(world.height)).toBe(true)
  })

  it('keeps the snapped screen rect consistent with its world rect (round-trip)', () => {
    const vp: ViewportData = { panX: 100, panY: 200, zoom: 2 }
    const { world, screenRect } = snapDrawRectToGrid({ x: 11, y: 41, width: 61, height: 79 }, vp)
    // screen = (world - pan) * zoom
    expect(screenRect.x).toBeCloseTo((world.x - vp.panX) * vp.zoom, 10)
    expect(screenRect.y).toBeCloseTo((world.y - vp.panY) * vp.zoom, 10)
    expect(screenRect.width).toBeCloseTo(world.width * vp.zoom, 10)
    expect(screenRect.height).toBeCloseTo(world.height * vp.zoom, 10)
  })

  it('can collapse to zero width/height (min-1 clamp is applied at commit, not here)', () => {
    const { world } = snapDrawRectToGrid({ x: 10.1, y: 10.1, width: 0.2, height: 0.2 }, vp1)
    expect(world.width).toBe(0)
    expect(world.height).toBe(0)
  })
})
