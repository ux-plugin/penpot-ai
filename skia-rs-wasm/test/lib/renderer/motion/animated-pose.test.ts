import { afterEach, describe, expect, it } from 'vitest'
import { transformRectAABB } from '../../../../src/lib/renderer/geom/matrix'
import {
  getAnimatedAABB,
  getAnimatedTransform,
  hasMotion,
  motionOverlayActive,
} from '../../../../src/lib/renderer/motion/animated-pose'
import { seekMotion, setMotionShapes, stopMotion } from '../../../../src/lib/renderer/motion/motion-store'
import { setKeyframe } from '../../../../src/lib/renderer/motion/edit'

afterEach(() => {
  stopMotion()
  setMotionShapes([])
})

/** A single-shape x-translation motion: delta 0 at t=0 (rest anchor) -> `endDelta` at `dur`. */
function xMotion(target: string, endDelta: number, dur = 1000) {
  let shapes = setKeyframe([], target, 'x', 0, 0)
  shapes = setKeyframe(shapes, target, 'x', dur, endDelta)
  return shapes
}

describe('transformRectAABB', () => {
  it('translates a rect', () => {
    const r = transformRectAABB({ x: 0, y: 0, width: 10, height: 10 }, { a: 1, b: 0, c: 0, d: 1, e: 200, f: 50 })
    expect(r).toEqual({ x: 200, y: 50, width: 10, height: 10 })
  })

  it('takes the AABB of a 90-degree rotation about the origin', () => {
    // rotate +90 CCW: (x,y) -> (-y, x); the unit-ish box (0,0)-(10,10) maps to (-10,0)-(0,10)
    const r = transformRectAABB({ x: 0, y: 0, width: 10, height: 10 }, { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 })
    expect(r.x).toBeCloseTo(-10)
    expect(r.y).toBeCloseTo(0)
    expect(r.width).toBeCloseTo(10)
    expect(r.height).toBeCloseTo(10)
  })
})

describe('animated-pose provider', () => {
  it('exposes the drawn matrix + overlay gate when paused mid-motion', () => {
    setMotionShapes(xMotion('s1', 200))
    seekMotion(1000)

    expect(motionOverlayActive()).toBe(true)
    expect(hasMotion('s1')).toBe(true)
    expect(hasMotion('nope')).toBe(false)

    const m = getAnimatedTransform('s1')
    expect(m).not.toBeNull()
    expect(m!.a).toBeCloseTo(1)
    expect(m!.e).toBeCloseTo(200)
    expect(m!.f).toBeCloseTo(0)

    expect(getAnimatedAABB('s1', { x: 0, y: 0, width: 10, height: 10 })).toEqual({
      x: 200,
      y: 0,
      width: 10,
      height: 10,
    })
  })

  it('is inactive at the rest frame (delta 0)', () => {
    setMotionShapes(xMotion('s1', 200))
    seekMotion(0)
    // At t=0 the shape sits at rest, so the overlay is not active.
    expect(motionOverlayActive()).toBe(false)
  })

  it('clears on stop: overlay inactive and no transform', () => {
    setMotionShapes(xMotion('s1', 200))
    seekMotion(1000)
    stopMotion()

    expect(motionOverlayActive()).toBe(false)
    expect(getAnimatedTransform('s1')).toBeNull()
  })
})
