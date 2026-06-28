import { describe, expect, it } from 'vitest'
import {
  shapeOutline,
  translateSegments,
  outlineWorldPoints,
  type ParametricShapeKind,
} from '../../../../src/lib/renderer/geom/primitives'
import type { PathSegment } from '../../../../src/lib/renderer/types'

const anchors = (segs: PathSegment[]) =>
  segs.filter((s) => s.type === 'move-to' || s.type === 'line-to' || s.type === 'curve-to')

describe('shapeOutline', () => {
  it('line is an open diagonal across the bbox', () => {
    const segs = shapeOutline('line', { width: 40, height: 20 })
    expect(segs).toEqual([
      { type: 'move-to', x: 0, y: 0 },
      { type: 'line-to', x: 40, y: 20 },
    ])
    // open path — no close
    expect(segs.some((s) => s.type === 'close-path')).toBe(false)
  })

  it('triangle is a closed 3-vertex ring, apex up', () => {
    const segs = shapeOutline('triangle', { width: 100, height: 60 })
    expect(anchors(segs)).toHaveLength(3)
    expect(segs[0]).toEqual({ type: 'move-to', x: 50, y: 0 })
    expect(segs.at(-1)).toEqual({ type: 'close-path' })
  })

  it('polygon honours the requested side count and closes', () => {
    const segs = shapeOutline('polygon', { width: 80, height: 80, sides: 6 })
    expect(anchors(segs)).toHaveLength(6)
    expect(segs.at(-1)).toEqual({ type: 'close-path' })
  })

  it('polygon clamps to a minimum of 3 sides', () => {
    expect(anchors(shapeOutline('polygon', { width: 10, height: 10, sides: 1 }))).toHaveLength(3)
  })

  it('star emits 2N alternating-radius vertices', () => {
    const segs = shapeOutline('star', { width: 100, height: 100, points: 5 })
    expect(anchors(segs)).toHaveLength(10)
    // first vertex is the top outer point
    expect(segs[0]).toMatchObject({ type: 'move-to', x: 50, y: 0 })
  })

  it('first polygon vertex sits at the top-center of the bbox', () => {
    const [first] = shapeOutline('polygon', { width: 60, height: 40, sides: 5 })
    expect(first).toMatchObject({ type: 'move-to' })
    expect((first as { x: number }).x).toBeCloseTo(30)
    expect((first as { y: number }).y).toBeCloseTo(0)
  })
})

describe('outlineWorldPoints', () => {
  it('translates anchor points by the origin and skips close-path', () => {
    const segs = shapeOutline('triangle', { width: 100, height: 60 })
    const pts = outlineWorldPoints(segs, 10, 5)
    expect(pts).toEqual([
      { x: 60, y: 5 },
      { x: 110, y: 65 },
      { x: 10, y: 65 },
    ])
  })

  it('includes curve-to endpoints (ellipse)', () => {
    const segs = shapeOutline('ellipse', { width: 40, height: 20 })
    const pts = outlineWorldPoints(segs, 0, 0)
    // move-to + 4 curve-to endpoints
    expect(pts).toHaveLength(5)
  })
})

describe('translateSegments', () => {
  it('shifts move-to/line-to coords and leaves close-path untouched', () => {
    const local = shapeOutline('triangle', { width: 100, height: 60 })
    const moved = translateSegments(local, 10, 5)
    expect(moved[0]).toEqual({ type: 'move-to', x: 60, y: 5 })
    expect(moved[1]).toEqual({ type: 'line-to', x: 110, y: 65 })
    expect(moved.at(-1)).toEqual({ type: 'close-path' })
  })

  it('shifts curve-to control points and endpoint (ellipse)', () => {
    const local = shapeOutline('ellipse', { width: 40, height: 20 })
    const moved = translateSegments(local, 100, 200)
    const curve = moved.find((s) => s.type === 'curve-to') as {
      x: number; y: number; c1x: number; c1y: number; c2x: number; c2y: number
    }
    const localCurve = local.find((s) => s.type === 'curve-to') as typeof curve
    expect(curve.x).toBeCloseTo(localCurve.x + 100)
    expect(curve.c1x).toBeCloseTo(localCurve.c1x + 100)
    expect(curve.c2y).toBeCloseTo(localCurve.c2y + 200)
  })

  it('places segments at the world origin so render matches the drag (regression)', () => {
    // The factory translates by (x, y); a shape dragged at (300, 200) must have
    // its first anchor at (300, 200), not near (0, 0).
    const local = shapeOutline('star', { width: 160, height: 160 })
    const world = translateSegments(local, 300, 200)
    expect(world[0]).toMatchObject({ type: 'move-to', x: 380, y: 200 })
  })
})

describe('all kinds produce a non-empty outline', () => {
  const kinds: ParametricShapeKind[] = ['line', 'triangle', 'polygon', 'star', 'rect', 'ellipse']
  for (const kind of kinds) {
    it(kind, () => {
      expect(shapeOutline(kind, { width: 50, height: 30 }).length).toBeGreaterThan(0)
    })
  }
})
