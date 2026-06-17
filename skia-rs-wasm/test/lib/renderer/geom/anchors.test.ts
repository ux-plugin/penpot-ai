import { describe, expect, it } from 'vitest'
import {
  anchorsToSegments,
  anchorsBounds,
  segmentsToAnchors,
  segmentsToSvgPath,
  nearestPointOnPath,
  insertAnchorOnEdge,
  reflect,
  type Anchor,
} from '../../../../src/lib/renderer/geom/anchors'

const corner = (x: number, y: number): Anchor => ({ point: { x, y } })

describe('reflect', () => {
  it('mirrors a handle through the anchor point', () => {
    expect(reflect({ x: 10, y: 10 }, { x: 14, y: 12 })).toEqual({ x: 6, y: 8 })
  })
})

describe('anchorsToSegments', () => {
  it('open all-corner path → move-to + line-tos', () => {
    const segs = anchorsToSegments([corner(0, 0), corner(10, 0), corner(10, 10)])
    expect(segs).toEqual([
      { type: 'move-to', x: 0, y: 0 },
      { type: 'line-to', x: 10, y: 0 },
      { type: 'line-to', x: 10, y: 10 },
    ])
  })

  it('emits a curve-to when an endpoint carries a handle', () => {
    const a: Anchor = { point: { x: 0, y: 0 }, handleOut: { x: 4, y: 0 } }
    const b: Anchor = { point: { x: 10, y: 0 }, handleIn: { x: 6, y: 0 } }
    expect(anchorsToSegments([a, b])).toEqual([
      { type: 'move-to', x: 0, y: 0 },
      { type: 'curve-to', x: 10, y: 0, c1x: 4, c1y: 0, c2x: 6, c2y: 0 },
    ])
  })

  it('a one-sided handle still curves (other control = its own point)', () => {
    const a: Anchor = { point: { x: 0, y: 0 }, handleOut: { x: 4, y: 4 } }
    const segs = anchorsToSegments([a, corner(10, 0)])
    expect(segs[1]).toEqual({ type: 'curve-to', x: 10, y: 0, c1x: 4, c1y: 4, c2x: 10, c2y: 0 })
  })

  it('closed all-corner path closes with close-path only (no explicit edge)', () => {
    const segs = anchorsToSegments([corner(0, 0), corner(10, 0), corner(10, 10)], true)
    expect(segs.map((s) => s.type)).toEqual(['move-to', 'line-to', 'line-to', 'close-path'])
  })

  it('closed curved path adds an explicit closing curve-to before close-path', () => {
    const first: Anchor = { point: { x: 0, y: 0 }, handleIn: { x: -2, y: 2 } }
    const last: Anchor = { point: { x: 10, y: 10 }, handleOut: { x: 12, y: 8 } }
    const segs = anchorsToSegments([first, corner(10, 0), last], true)
    expect(segs.map((s) => s.type)).toEqual(['move-to', 'line-to', 'line-to', 'curve-to', 'close-path'])
    expect(segs[3]).toMatchObject({ type: 'curve-to', x: 0, y: 0, c1x: 12, c1y: 8, c2x: -2, c2y: 2 })
  })
})

describe('segmentsToAnchors ⇄ anchorsToSegments round-trip', () => {
  const cases: { name: string; anchors: Anchor[]; closed: boolean }[] = [
    { name: 'open polyline', anchors: [corner(0, 0), corner(10, 0), corner(5, 9)], closed: false },
    {
      name: 'open curve',
      anchors: [
        { point: { x: 0, y: 0 }, handleOut: { x: 3, y: 5 } },
        { point: { x: 10, y: 0 }, handleIn: { x: 7, y: 5 }, handleOut: { x: 13, y: -5 } },
        { point: { x: 20, y: 0 }, handleIn: { x: 17, y: -5 } },
      ],
      closed: false,
    },
    { name: 'closed polygon', anchors: [corner(0, 0), corner(10, 0), corner(10, 10), corner(0, 10)], closed: true },
    {
      name: 'closed curve',
      anchors: [
        { point: { x: 0, y: 0 }, handleIn: { x: -3, y: 3 }, handleOut: { x: 3, y: -3 } },
        { point: { x: 10, y: 0 }, handleIn: { x: 7, y: -3 }, handleOut: { x: 13, y: 3 } },
        { point: { x: 5, y: 10 }, handleIn: { x: 8, y: 9 }, handleOut: { x: 2, y: 9 } },
      ],
      closed: true,
    },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const segs = anchorsToSegments(c.anchors, c.closed)
      const back = segmentsToAnchors(segs)
      expect(back.closed).toBe(c.closed)
      expect(back.anchors).toEqual(c.anchors)
      // Idempotent: re-encoding the recovered anchors yields identical segments.
      expect(anchorsToSegments(back.anchors, back.closed)).toEqual(segs)
    })
  }
})

describe('anchorsBounds', () => {
  it('bounds the anchor points', () => {
    expect(anchorsBounds([corner(0, 0), corner(10, 4), corner(3, 12)])).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 12,
    })
  })

  it('extends to include handles that poke past the vertices', () => {
    const anchors: Anchor[] = [
      { point: { x: 0, y: 0 }, handleOut: { x: 5, y: -20 } },
      { point: { x: 10, y: 0 }, handleIn: { x: 5, y: -20 } },
    ]
    expect(anchorsBounds(anchors)).toEqual({ x: 0, y: -20, width: 10, height: 20 })
  })

  it('empty input → zero rect', () => {
    expect(anchorsBounds([])).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})

describe('nearestPointOnPath', () => {
  it('projects onto a straight edge', () => {
    const hit = nearestPointOnPath([corner(0, 0), corner(100, 0)], false, { x: 40, y: 10 })
    expect(hit).not.toBeNull()
    expect(hit!.edge).toBe(0)
    expect(hit!.t).toBeCloseTo(0.4, 5)
    expect(hit!.point.x).toBeCloseTo(40, 4)
    expect(hit!.point.y).toBeCloseTo(0, 4)
    expect(hit!.dist).toBeCloseTo(10, 4)
  })

  it('picks the nearest of several edges', () => {
    const square = [corner(0, 0), corner(100, 0), corner(100, 100), corner(0, 100)]
    const hit = nearestPointOnPath(square, true, { x: 105, y: 50 })
    expect(hit!.edge).toBe(1) // right edge, from (100,0) to (100,100)
    expect(hit!.point.x).toBeCloseTo(100, 3)
    expect(hit!.point.y).toBeCloseTo(50, 1)
  })

  it('finds a point on a curved edge near the cursor', () => {
    const anchors: Anchor[] = [
      { point: { x: 0, y: 0 }, handleOut: { x: 0, y: -60 } },
      { point: { x: 100, y: 0 }, handleIn: { x: 100, y: -60 } },
    ]
    // The curve bulges upward; sample its apex region.
    const hit = nearestPointOnPath(anchors, false, { x: 50, y: -50 })
    expect(hit!.edge).toBe(0)
    expect(hit!.t).toBeCloseTo(0.5, 1)
    expect(hit!.point.y).toBeLessThan(0)
  })

  it('returns null for under-two anchors', () => {
    expect(nearestPointOnPath([corner(0, 0)], false, { x: 0, y: 0 })).toBeNull()
  })
})

describe('insertAnchorOnEdge', () => {
  it('splits a straight edge at the midpoint into two corner anchors', () => {
    const out = insertAnchorOnEdge([corner(0, 0), corner(100, 0)], false, 0, 0.5)
    expect(out).toHaveLength(3)
    expect(out[1]).toEqual({ point: { x: 50, y: 0 } })
    expect(anchorsToSegments(out).map((s) => s.type)).toEqual(['move-to', 'line-to', 'line-to'])
  })

  it('splits a curved edge without moving the outline (De Casteljau)', () => {
    const anchors: Anchor[] = [
      { point: { x: 0, y: 0 }, handleOut: { x: 0, y: -60 } },
      { point: { x: 100, y: 0 }, handleIn: { x: 100, y: -60 } },
    ]
    const out = insertAnchorOnEdge(anchors, false, 0, 0.5)
    expect(out).toHaveLength(3)
    // The inserted point sits exactly on the original cubic at t=0.5: the curve
    // B(0.5) for these controls is (50, -45).
    expect(out[1].point.x).toBeCloseTo(50, 6)
    expect(out[1].point.y).toBeCloseTo(-45, 6)
    expect(out[1].handleIn).toBeDefined()
    expect(out[1].handleOut).toBeDefined()
    // Both halves are curves; endpoints keep their outer handles.
    expect(out[0].handleOut).toBeDefined()
    expect(out[2].handleIn).toBeDefined()
    expect(anchorsToSegments(out).map((s) => s.type)).toEqual(['move-to', 'curve-to', 'curve-to'])
  })

  it('splits the closing edge of a closed path (inserts at the end)', () => {
    const tri = [corner(0, 0), corner(100, 0), corner(50, 80)]
    const out = insertAnchorOnEdge(tri, true, 2, 0.5) // edge from anchor 2 back to anchor 0
    expect(out).toHaveLength(4)
    expect(out[3]).toEqual({ point: { x: 25, y: 40 } })
  })
})

describe('segmentsToSvgPath', () => {
  it('encodes move/line/curve/close', () => {
    const d = segmentsToSvgPath([
      { type: 'move-to', x: 0, y: 0 },
      { type: 'line-to', x: 10, y: 0 },
      { type: 'curve-to', x: 20, y: 10, c1x: 14, c1y: 0, c2x: 20, c2y: 4 },
      { type: 'close-path' },
    ])
    expect(d).toBe('M0 0L10 0C14 0 20 4 20 10Z')
  })
})
