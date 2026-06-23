import { describe, expect, it } from 'vitest'
import {
  anchorsToSegments,
  anchorsBounds,
  anchorsTightBounds,
  cubicBounds,
  segmentsToAnchors,
  segmentsToSvgPath,
  nearestPointOnPath,
  insertAnchorOnEdge,
  toggleAnchorSmooth,
  deleteAnchor,
  pathContent,
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

describe('toggleAnchorSmooth', () => {
  it('corner → smooth grows a symmetric handle pair along the neighbour tangent', () => {
    // Middle of an L: prev (0,0), this (100,0), next (100,100). Chord prev→next
    // is (100,100) → tangent 45°; shorter edge length 100 → d = 100/3.
    const anchors = [corner(0, 0), corner(100, 0), corner(100, 100)]
    const out = toggleAnchorSmooth(anchors, false, 1)
    const a = out[1]
    expect(a.handleOut).toBeDefined()
    expect(a.handleIn).toBeDefined()
    const d = 100 / 3
    const u = Math.SQRT1_2
    expect(a.handleOut!.x).toBeCloseTo(100 + u * d, 4)
    expect(a.handleOut!.y).toBeCloseTo(0 + u * d, 4)
    // in-handle is the mirror about the point
    expect(a.handleIn!.x).toBeCloseTo(2 * 100 - a.handleOut!.x, 6)
    expect(a.handleIn!.y).toBeCloseTo(2 * 0 - a.handleOut!.y, 6)
  })

  it('smooth → corner drops both handles', () => {
    const anchors: Anchor[] = [
      corner(0, 0),
      { point: { x: 100, y: 0 }, handleIn: { x: 70, y: 0 }, handleOut: { x: 130, y: 0 } },
      corner(100, 100),
    ]
    const out = toggleAnchorSmooth(anchors, false, 1)
    expect(out[1]).toEqual({ point: { x: 100, y: 0 } })
  })

  it('open endpoint smooths along its single edge', () => {
    const out = toggleAnchorSmooth([corner(0, 0), corner(90, 0)], false, 0)
    // direction to the only neighbour is +x; d = 90/3 = 30
    expect(out[0].handleOut).toEqual({ x: 30, y: 0 })
    expect(out[0].handleIn).toEqual({ x: -30, y: 0 })
  })
})

describe('deleteAnchor', () => {
  it('removes a middle anchor and rejoins its neighbours straight', () => {
    const out = deleteAnchor([corner(0, 0), corner(50, 0), corner(100, 0)], false, 1)
    expect(out).toEqual([{ point: { x: 0, y: 0 } }, { point: { x: 100, y: 0 } }])
  })

  it('drops the handles that faced the removed anchor, keeps the far ones', () => {
    const anchors: Anchor[] = [
      { point: { x: 0, y: 0 }, handleIn: { x: -5, y: 0 }, handleOut: { x: 10, y: 0 } },
      { point: { x: 50, y: 0 }, handleIn: { x: 40, y: 0 }, handleOut: { x: 60, y: 0 } },
      { point: { x: 100, y: 0 }, handleIn: { x: 90, y: 0 }, handleOut: { x: 110, y: 0 } },
    ]
    const out = deleteAnchor(anchors, false, 1)
    expect(out).toHaveLength(2)
    // prev keeps its in-handle, loses the out-handle that pointed at the deleted node
    expect(out[0].handleIn).toEqual({ x: -5, y: 0 })
    expect(out[0].handleOut).toBeUndefined()
    // next keeps its out-handle, loses the in-handle that pointed at the deleted node
    expect(out[1].handleIn).toBeUndefined()
    expect(out[1].handleOut).toEqual({ x: 110, y: 0 })
  })

  it('deleting an open endpoint shortens the path', () => {
    const out = deleteAnchor([corner(0, 0), corner(50, 0), corner(100, 0)], false, 0)
    expect(out).toEqual([{ point: { x: 50, y: 0 } }, { point: { x: 100, y: 0 } }])
  })

  it('on a closed path the wrap-around neighbour handles are dropped', () => {
    const sq: Anchor[] = [
      { point: { x: 0, y: 0 }, handleIn: { x: -5, y: 0 } },
      { point: { x: 100, y: 0 } },
      { point: { x: 100, y: 100 } },
      { point: { x: 0, y: 100 }, handleOut: { x: -5, y: 100 } },
    ]
    const out = deleteAnchor(sq, true, 0) // neighbours are index 3 (prev) and 1 (next)
    expect(out).toHaveLength(3)
    // index 3 was prev → its out-handle (faced index 0) is dropped
    expect(out[2].handleOut).toBeUndefined()
  })

  it('refuses to drop below a viable path (returns unchanged)', () => {
    expect(deleteAnchor([corner(0, 0), corner(10, 0)], false, 0)).toHaveLength(2)
    expect(deleteAnchor([corner(0, 0), corner(10, 0), corner(5, 9)], true, 1)).toHaveLength(3)
  })
})

describe('pathContent', () => {
  it('stores cloned vertices + closed and a derived sharp segment mirror', () => {
    const verts: Anchor[] = [corner(0, 0), corner(10, 0), corner(5, 9)]
    const c = pathContent(verts, true)
    expect(c.closed).toBe(true)
    expect(c.vertices).toEqual(verts)
    expect(c.vertices).not.toBe(verts) // cloned
    expect(c.segments).toEqual(anchorsToSegments(verts, true))
  })

  it('round-trips: segmentsToAnchors(pathContent(v).segments) recovers v', () => {
    const verts: Anchor[] = [
      { point: { x: 0, y: 0 }, handleOut: { x: 3, y: 5 } },
      { point: { x: 10, y: 0 }, handleIn: { x: 7, y: 5 } },
    ]
    const back = segmentsToAnchors(pathContent(verts, false).segments)
    expect(back.anchors).toEqual(verts)
    expect(back.closed).toBe(false)
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


describe('cubicBounds / anchorsTightBounds (tight curve, not control hull)', () => {
  it('a symmetric cubic peaks at 3/4 of the handle, not the handle itself', () => {
    const b = cubicBounds({ x: 0, y: 0 }, { x: 0, y: -40 }, { x: 100, y: -40 }, { x: 100, y: 0 })
    expect(b.minY).toBeCloseTo(-30, 6)
    expect(b.maxY).toBeCloseTo(0, 6)
    expect(b.minX).toBeCloseTo(0, 6)
    expect(b.maxX).toBeCloseTo(100, 6)
  })

  it('a straight edge (no handles) bounds its endpoints', () => {
    const b = cubicBounds({ x: 2, y: 5 }, { x: 2, y: 5 }, { x: 8, y: 1 }, { x: 8, y: 1 })
    expect(b).toEqual({ minX: 2, minY: 1, maxX: 8, maxY: 5 })
  })

  it('anchorsTightBounds hugs the curve where anchorsBounds spans the handles', () => {
    const anchors: Anchor[] = [
      { point: { x: 0, y: 0 }, handleOut: { x: 0, y: -40 } },
      { point: { x: 100, y: 0 }, handleIn: { x: 100, y: -40 } },
    ]
    expect(anchorsBounds(anchors)).toMatchObject({ y: -40, height: 40 })
    expect(anchorsTightBounds(anchors)).toMatchObject({ x: 0, y: -30, width: 100, height: 30 })
  })
})
