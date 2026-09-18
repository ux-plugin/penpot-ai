import { describe, expect, it } from 'vitest'
import { dollyBounds, frameDistanceForRadius } from '@/lib/renderer/three/scene3d-store'

describe('dollyBounds', () => {
  it('returns proportional min/max around the home distance', () => {
    const a = dollyBounds(10)
    expect(a.min).toBeCloseTo(2)
    expect(a.max).toBeCloseTo(50)
    const b = dollyBounds(6)
    expect(b.min).toBeCloseTo(1.2)
    expect(b.max).toBeCloseTo(30)
  })

  it('keeps min below and max above home so the camera can always dolly back out', () => {
    const d = 6
    const { min, max } = dollyBounds(d)
    expect(min).toBeLessThan(d)
    expect(max).toBeGreaterThan(d)
  })

  it('falls back to a unit home distance for non-positive input', () => {
    expect(dollyBounds(0)).toEqual({ min: 0.2, max: 5 })
    expect(dollyBounds(-3)).toEqual({ min: 0.2, max: 5 })
  })
})

describe('frameDistanceForRadius', () => {
  it('scales linearly with radius and grows as the fov narrows', () => {
    const d = frameDistanceForRadius(1, 45)
    expect(frameDistanceForRadius(2, 45)).toBeCloseTo(2 * d) // linear in radius
    expect(frameDistanceForRadius(1, 20)).toBeGreaterThan(d) // narrower fov → farther
  })

  it('places the bounding sphere on the frustum edge (padding = 1)', () => {
    const r = 1
    const fov = 60
    const dist = frameDistanceForRadius(r, fov, 1)
    const half = ((fov * Math.PI) / 180) / 2
    expect(dist * Math.sin(half)).toBeCloseTo(r)
  })
})
