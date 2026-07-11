import { describe, expect, it } from 'vitest'
import {
  ensureRestAnchor,
  keyframeAt,
  keyframeDelta,
  moveKeyframe,
  rebaseToRest,
  removeKeyframe,
  setKeyframe,
  setParamKeyframe,
  type ShapeMotion,
} from '../../../../src/lib/renderer/motion/edit'

/** Keys of one property track on a shape, for terse assertions. */
const keys = (motions: ShapeMotion[], targetId: string, prop: string) =>
  motions.find((m) => m.targetId === targetId)?.timeline.bindings.find((b) => b.target.prop === prop)?.curve.keys

describe('setKeyframe', () => {
  it('creates the shape, binding, and key; duration tracks the latest key', () => {
    const motions = setKeyframe([], 's1', 'x', 0, 10)
    expect(motions).toHaveLength(1)
    expect(motions[0].targetId).toBe('s1')
    expect(motions[0].restFrame).toBe(0)
    expect(keys(motions, 's1', 'x')).toEqual([{ at: 0, value: 10 }])
    expect(motions[0].timeline.duration).toBe(0)

    const grown = setKeyframe(motions, 's1', 'x', 500, 100)
    expect(grown[0].timeline.duration).toBe(500)
    expect(keys(grown, 's1', 'x')).toHaveLength(2)
  })

  it('updates the key already at that time, preserving interp', () => {
    const a = setKeyframe([], 's1', 'x', 200, 10, 'easeIn')
    const b = setKeyframe(a, 's1', 'x', 200, 99)
    expect(keys(b, 's1', 'x')).toEqual([{ at: 200, value: 99, interp: 'easeIn' }])
  })

  it('adds a second property as a new binding on the same shape', () => {
    let motions = setKeyframe([], 's1', 'x', 0, 0)
    motions = setKeyframe(motions, 's1', 'rotation', 1000, 360)
    expect(motions).toHaveLength(1)
    expect(motions[0].timeline.bindings.map((b) => b.target.prop).sort()).toEqual(['rotation', 'x'])
  })

  it('does not mutate the input', () => {
    const before: ShapeMotion[] = []
    const after = setKeyframe(before, 's1', 'x', 0, 10)
    expect(before).toEqual([])
    expect(after).not.toBe(before)
  })
})

describe('removeKeyframe', () => {
  const base = setKeyframe(setKeyframe([], 's1', 'x', 0, 0), 's1', 'x', 500, 100)

  it('removes a key and recomputes duration', () => {
    const r = removeKeyframe(base, 's1', 'x', 500)
    expect(keys(r, 's1', 'x')?.map((k) => k.at)).toEqual([0])
    expect(r[0].timeline.duration).toBe(0)
  })

  it('drops the binding when it empties and the shape when it has none', () => {
    const r = removeKeyframe(removeKeyframe(base, 's1', 'x', 0), 's1', 'x', 500)
    expect(r).toEqual([])
  })

  it('returns the same array when nothing matches', () => {
    expect(removeKeyframe(base, 's1', 'x', 999)).toBe(base)
    expect(removeKeyframe(base, 'nope', 'x', 0)).toBe(base)
  })
})

describe('ensureRestAnchor', () => {
  it('adds a delta-0 key at the rest time when none exists', () => {
    const r = ensureRestAnchor([], 's1', 'x', 0)
    expect(keyframeAt(r, 's1', 'x', 0)).toEqual({ at: 0, value: 0 })
  })

  it('is a no-op (same reference) when a key already sits at the rest time', () => {
    const base = setKeyframe([], 's1', 'x', 0, 25)
    expect(ensureRestAnchor(base, 's1', 'x', 0)).toBe(base)
  })
})

describe('moveKeyframe', () => {
  const base = setKeyframe(setKeyframe([], 's1', 'x', 0, 0), 's1', 'x', 500, 100)

  it('retimes a key, preserving value, and recomputes duration', () => {
    const r = moveKeyframe(base, 's1', 'x', 500, 800)
    expect(keys(r, 's1', 'x')?.map((k) => k.at)).toEqual([0, 800])
    expect(keyframeAt(r, 's1', 'x', 800)).toEqual({ at: 800, value: 100 })
    expect(r[0].timeline.duration).toBe(800)
  })

  it('no-ops (same ref) with no source key or unchanged time', () => {
    expect(moveKeyframe(base, 's1', 'x', 250, 300)).toBe(base)
    expect(moveKeyframe(base, 's1', 'x', 500, 500)).toBe(base)
  })
})

describe('keyframeAt / keyframeDelta', () => {
  const motions = setKeyframe(setKeyframe([], 's1', 'x', 0, 0), 's1', 'x', 500, 100)

  it('finds a key at the given time, else undefined', () => {
    expect(keyframeAt(motions, 's1', 'x', 500)).toEqual({ at: 500, value: 100 })
    expect(keyframeAt(motions, 's1', 'x', 250)).toBeUndefined()
    expect(keyframeAt(motions, 's1', 'opacity', 0)).toBeUndefined()
  })

  it('samples the interpolated delta at a time (0 when un-keyframed)', () => {
    expect(keyframeDelta(motions, 's1', 'x', 250)).toBeCloseTo(50, 6)
    expect(keyframeDelta(motions, 's1', 'y', 250)).toBe(0)
    expect(keyframeDelta(motions, 'nope', 'x', 250)).toBe(0)
  })
})

describe('rebaseToRest', () => {
  // x: 0 at t0, 200 at t500 (a slide right).
  const motions = setKeyframe(setKeyframe([], 's1', 'x', 0, 0), 's1', 'x', 500, 200)

  it('moves the doc by the sampled delta at restFrame and shifts keys so rest is 0 there', () => {
    const { motions: out, docDelta } = rebaseToRest(motions, 's1', 500)
    expect(docDelta).toEqual({ x: 200, y: 0, rotation: 0 })
    expect(keys(out, 's1', 'x')).toEqual([
      { at: 0, value: -200 },
      { at: 500, value: 0 },
    ])
    expect(out[0].restFrame).toBe(500)
  })

  it('re-homes at an intermediate frame (interpolated delta)', () => {
    const { motions: out, docDelta } = rebaseToRest(motions, 's1', 250)
    expect(docDelta.x).toBeCloseTo(100, 6)
    const xk = keys(out, 's1', 'x')!
    expect(xk[0].value).toBeCloseTo(-100, 6)
    expect(xk[1].value).toBeCloseTo(100, 6)
  })

  it('has a zero doc delta at restFrame 0 (the rest anchor is delta 0)', () => {
    expect(rebaseToRest(motions, 's1', 0).docDelta).toEqual({ x: 0, y: 0, rotation: 0 })
  })

  it('returns motions unchanged when the target has no shape', () => {
    const r = rebaseToRest(motions, 'nope', 500)
    expect(r.motions).toBe(motions)
    expect(r.docDelta).toEqual({ x: 0, y: 0, rotation: 0 })
  })
})

describe('setParamKeyframe', () => {
  it('authors a param-domain binding without touching the time keys or duration', () => {
    let motions = setKeyframe([], 's1', 'x', 500, 40) // a time key
    motions = setParamKeyframe(motions, 's1', 'x', 'speed', 0, 0)
    motions = setParamKeyframe(motions, 's1', 'x', 'speed', 1, 100)
    expect(motions[0].timeline.bindings).toHaveLength(2)
    expect(motions[0].timeline.duration).toBe(500) // param keys do not extend duration
    // keyframeDelta reads the TIME binding only
    expect(keyframeDelta(motions, 's1', 'x', 500)).toBeCloseTo(40, 6)
  })
})
