import { describe, expect, it } from 'vitest'
import { propsToModifier } from '../../../../src/lib/renderer/motion/modifier'

describe('propsToModifier', () => {
  it('returns identity with no opacity for empty props', () => {
    const m = propsToModifier({})
    expect(m.matrix).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
    expect(m.opacity).toBeUndefined()
  })

  it('maps x/y to translation', () => {
    const m = propsToModifier({ x: 30, y: -12 })
    expect(m.matrix.e).toBeCloseTo(30, 6)
    expect(m.matrix.f).toBeCloseTo(-12, 6)
  })

  it('passes opacity through', () => {
    expect(propsToModifier({ opacity: 0.4 }).opacity).toBeCloseTo(0.4, 6)
  })

  it('maps rotation (deg, about origin) to the rotation matrix', () => {
    const m = propsToModifier({ rotation: 90 })
    expect(m.matrix.a).toBeCloseTo(0, 6)
    expect(m.matrix.b).toBeCloseTo(1, 6)
    expect(m.matrix.c).toBeCloseTo(-1, 6)
    expect(m.matrix.d).toBeCloseTo(0, 6)
  })

  it('treats a scale delta of 0 as the identity', () => {
    const m = propsToModifier({ scaleX: 0, scaleY: 0 })
    expect(m.matrix.a).toBeCloseTo(1, 6)
    expect(m.matrix.d).toBeCloseTo(1, 6)
  })

  it('maps a scale delta about the origin (multiplier = 1 + delta)', () => {
    // deltas +1 / +2 → multipliers 2 / 3
    const m = propsToModifier({ scaleX: 1, scaleY: 2 })
    expect(m.matrix.a).toBeCloseTo(2, 6)
    expect(m.matrix.d).toBeCloseTo(3, 6)
    expect(m.matrix.e).toBeCloseTo(0, 6)
  })

  it('scales about a pivot', () => {
    // delta +1 → multiplier 2; x' = 2·(x − 10) + 10 → e = 10·(1 − 2) = −10
    const m = propsToModifier({ scaleX: 1 }, { cx: 10, cy: 0 })
    expect(m.matrix.a).toBeCloseTo(2, 6)
    expect(m.matrix.e).toBeCloseTo(-10, 6)
  })

  it('scale + translation about the REST centre lands the scale on the MOVED centre', () => {
    // The pivot MUST be the rest centre (here (0,0)); the shape translates by +100
    // and scales ×2. The matrix must map the rest centre (0,0) to the moved centre
    // (100,0) AND scale about that moved centre — i.e. a corner at (10,0) → 120,
    // not 220 (which is what a displaced pivot at (100,0) would wrongly produce).
    const restCentre = { cx: 0, cy: 0 }
    const m = propsToModifier({ x: 100, y: 0, scaleX: 1 }, restCentre)
    const apply = (px: number): number => m.matrix.a * px + m.matrix.e
    expect(apply(0)).toBeCloseTo(100, 6) // rest centre → moved centre
    expect(apply(10)).toBeCloseTo(120, 6) // moved centre 100 + 2·10
    expect(apply(-10)).toBeCloseTo(80, 6) // moved centre 100 − 2·10
  })
})

