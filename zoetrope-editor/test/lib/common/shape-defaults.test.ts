import { describe, expect, it } from 'vitest'
import { applyGeometryDefaults } from '../../../src/lib/common/shape-defaults'

describe('applyGeometryDefaults', () => {
  it('fills rotation and corners on a rect-backed shape', () => {
    const out = applyGeometryDefaults({ type: 'rect' })
    expect(out).toMatchObject({ type: 'rect', rotation: 0, r1: 0, r2: 0, r3: 0, r4: 0 })
  })

  it('fills corners for every rect-backed type', () => {
    for (const type of ['rect', 'image', 'frame', 'instance', 'component']) {
      expect(applyGeometryDefaults({ type })).toMatchObject({ r1: 0, r2: 0, r3: 0, r4: 0 })
    }
  })

  it('fills only rotation (no corners) on non-rect-backed shapes', () => {
    const out = applyGeometryDefaults({ type: 'circle' })
    expect(out.rotation).toBe(0)
    expect(out.r1).toBeUndefined()
    expect(out.r4).toBeUndefined()
  })

  it('never overwrites existing values', () => {
    const node = { type: 'rect', rotation: 30, r1: 4, r2: 4, r3: 4, r4: 4 }
    expect(applyGeometryDefaults(node)).toEqual(node)
  })

  it('keeps an explicit zero', () => {
    const node = { type: 'rect', rotation: 0, r1: 0, r2: 0, r3: 0, r4: 0 }
    expect(applyGeometryDefaults(node)).toBe(node) // same ref → no-op
  })

  it('fills a partially-set corner set without clobbering the set ones', () => {
    const out = applyGeometryDefaults({ type: 'rect', rotation: 0, r1: 8, r2: 8 } as {
      type: string; rotation: number; r1?: number; r2?: number; r3?: number; r4?: number
    })
    expect(out).toMatchObject({ r1: 8, r2: 8, r3: 0, r4: 0 })
  })

  it('returns the same reference when nothing needs filling', () => {
    const node = { type: 'circle', rotation: 0 }
    expect(applyGeometryDefaults(node)).toBe(node)
  })
})
