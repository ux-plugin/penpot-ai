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

  it('maps scale about the origin', () => {
    const m = propsToModifier({ scaleX: 2, scaleY: 3 })
    expect(m.matrix.a).toBeCloseTo(2, 6)
    expect(m.matrix.d).toBeCloseTo(3, 6)
    expect(m.matrix.e).toBeCloseTo(0, 6)
  })

  it('scales about a pivot', () => {
    // x' = 2·(x − 10) + 10 → e = 10·(1 − 2) = −10
    const m = propsToModifier({ scaleX: 2 }, { cx: 10, cy: 0 })
    expect(m.matrix.a).toBeCloseTo(2, 6)
    expect(m.matrix.e).toBeCloseTo(-10, 6)
  })
})

