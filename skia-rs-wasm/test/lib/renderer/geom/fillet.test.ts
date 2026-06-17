import { describe, expect, it } from 'vitest'
import { filletCorner, roundedSegments } from '../../../../src/lib/renderer/geom/fillet'
import { anchorsToSegments, type Anchor } from '../../../../src/lib/renderer/geom/anchors'

const corner = (x: number, y: number): Anchor => ({ point: { x, y } })
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

describe('filletCorner', () => {
  it('a 90° corner trims by r along each edge and the arc stays radius r from the centre', () => {
    // Corner at origin, edges going left and down → interior angle 90°. Edges are
    // long enough (200) that the trim isn't clamped (max trim would be 100).
    const f = filletCorner({ x: -200, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 200 }, 70)!
    expect(f).not.toBeNull()
    expect(f.rEff).toBeCloseTo(70, 6)
    // tan(45°) = 1 → trim = r = 70
    expect(f.t1.x).toBeCloseTo(-70, 6)
    expect(f.t1.y).toBeCloseTo(0, 6)
    expect(f.t2.x).toBeCloseTo(0, 6)
    expect(f.t2.y).toBeCloseTo(70, 6)
    // The fillet circle centre is at (-70, 70); both tangent points are r away.
    const centre = { x: -70, y: 70 }
    expect(dist(f.t1, centre)).toBeCloseTo(70, 6)
    expect(dist(f.t2, centre)).toBeCloseTo(70, 6)
    // The bézier midpoint should sit ~r from the centre too (good arc approximation).
    const mid = (t: number) => {
      const u = 1 - t
      return {
        x: u * u * u * f.t1.x + 3 * u * u * t * f.c1.x + 3 * u * t * t * f.c2.x + t * t * t * f.t2.x,
        y: u * u * u * f.t1.y + 3 * u * u * t * f.c1.y + 3 * u * t * t * f.c2.y + t * t * t * f.t2.y,
      }
    }
    expect(dist(mid(0.5), centre)).toBeCloseTo(70, 1)
  })

  it('clamps the trim to half the shorter edge and reduces the effective radius', () => {
    // Right-angle corner whose shorter edge is only 40 long → max trim 20.
    const f = filletCorner({ x: -40, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1000 }, 500)!
    expect(f.t1.x).toBeCloseTo(-20, 6) // trim clamped to 20
    expect(f.t2.y).toBeCloseTo(20, 6)
    expect(f.rEff).toBeCloseTo(20, 6) // 90° → rEff = trim
  })

  it('returns null for a straight run, a zero-length edge, or r ≤ 0', () => {
    expect(filletCorner({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }, 10)).toBeNull()
    expect(filletCorner({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }, 10)).toBeNull()
    expect(filletCorner({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }, 0)).toBeNull()
  })
})

describe('roundedSegments', () => {
  const square: Anchor[] = [corner(0, 0), corner(100, 0), corner(100, 100), corner(0, 100)]

  it('radius 0 is identical to the sharp segments', () => {
    expect(roundedSegments(square, 0, true)).toEqual(anchorsToSegments(square, true))
  })

  it('rounds every corner of a closed square: 4 arcs + 4 edges + close', () => {
    const segs = roundedSegments(square, 20, true)
    const types = segs.map((s) => s.type)
    expect(types[0]).toBe('move-to')
    expect(types.filter((t) => t === 'curve-to')).toHaveLength(4) // one arc per corner
    expect(types.filter((t) => t === 'line-to')).toHaveLength(4) // one straight edge per side
    expect(types[types.length - 1]).toBe('close-path')
    // Every emitted coordinate stays within the original bounding box.
    for (const s of segs) {
      if ('x' in s) {
        expect(s.x).toBeGreaterThanOrEqual(-1e-6)
        expect(s.x).toBeLessThanOrEqual(100 + 1e-6)
        expect(s.y).toBeGreaterThanOrEqual(-1e-6)
        expect(s.y).toBeLessThanOrEqual(100 + 1e-6)
      }
    }
  })

  it('leaves the endpoints of an open path sharp, rounds the interior corner', () => {
    const segs = roundedSegments([corner(0, 0), corner(100, 0), corner(100, 100)], 20, false)
    // Open path: starts exactly at the first endpoint (not trimmed).
    expect(segs[0]).toEqual({ type: 'move-to', x: 0, y: 0 })
    // The single interior corner (index 1) becomes an arc.
    expect(segs.some((s) => s.type === 'curve-to')).toBe(true)
    expect(segs.some((s) => s.type === 'close-path')).toBe(false)
  })

  it('passes smooth (handled) vertices through unrounded', () => {
    const anchors: Anchor[] = [
      corner(0, 0),
      { point: { x: 50, y: 0 }, handleIn: { x: 40, y: -10 }, handleOut: { x: 60, y: 10 } },
      corner(100, 0),
    ]
    const segs = roundedSegments(anchors, 15, false)
    // The smooth middle vertex keeps a single curve edge through it (its handles),
    // and the open endpoints aren't rounded → no extra arcs introduced.
    expect(segs.filter((s) => s.type === 'curve-to').length).toBeGreaterThanOrEqual(1)
    expect(segs[0]).toEqual({ type: 'move-to', x: 0, y: 0 })
  })
})
