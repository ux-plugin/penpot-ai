import { describe, it, expect } from 'vitest'
import { vnToFaces, interiorPoint } from '@/lib/renderer/geom/vector-network-faces'
import type { VectorNetwork } from '@/lib/renderer/geom/vector-network'

// ray-cast point-in-polygon (mirror of the module's, for assertions)
const inPoly = (pt: { x: number; y: number }, poly: { x: number; y: number }[]) => {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

describe('interiorPoint (hole-detection hardening)', () => {
  it('returns a point inside a non-convex polygon whose centroid escapes', () => {
    // A "C" opening right; its vertex average lands in the mouth (outside the C).
    const c = [
      { x: 0, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 30 }, { x: 10, y: 30 },
      { x: 10, y: 50 }, { x: 30, y: 50 }, { x: 30, y: 60 }, { x: 0, y: 60 },
    ]
    const centroid = { x: c.reduce((s, p) => s + p.x, 0) / c.length, y: c.reduce((s, p) => s + p.y, 0) / c.length }
    expect(inPoly(centroid, c)).toBe(false) // the naive centroid is OUTSIDE — would mislead nesting
    expect(inPoly(interiorPoint(c), c)).toBe(true) // the hardened point is genuinely inside
  })

  it('fast path: a convex polygon returns its centroid', () => {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
    expect(interiorPoint(sq)).toEqual({ x: 5, y: 5 })
  })
})

const sq = (): VectorNetwork => ({
  nodes: [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ],
  edges: [
    { a: 0, b: 1 },
    { a: 1, b: 2 },
    { a: 2, b: 3 },
    { a: 3, b: 0 },
  ],
})

describe('vnToFaces', () => {
  it('square → 1 bounded face, no branches', () => {
    const r = vnToFaces(sq())
    expect(r.faces).toHaveLength(1)
    expect(r.faces[0].closed).toBe(true)
    expect(r.faces[0].vertices).toHaveLength(4)
    expect(r.branches).toHaveLength(0)
  })

  it('quad split by a diagonal → 2 bounded faces sharing an edge', () => {
    const net: VectorNetwork = {
      nodes: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
      edges: [
        { a: 0, b: 1 },
        { a: 1, b: 2 },
        { a: 2, b: 3 },
        { a: 3, b: 0 },
        { a: 0, b: 2 }, // diagonal
      ],
    }
    const r = vnToFaces(net)
    expect(r.faces).toHaveLength(2)
    expect(r.faces.every((f) => f.closed && f.vertices.length === 3)).toBe(true)
    expect(r.branches).toHaveLength(0)
  })

  it('square + open branch → 1 face, branch excluded (stroke only)', () => {
    const net: VectorNetwork = sq()
    net.nodes.push({ x: -40, y: 50 }) // node 4
    net.edges.push({ a: 0, b: 4 }) // branch off corner 0
    const r = vnToFaces(net)
    expect(r.faces).toHaveLength(1)
    expect(r.faces[0].vertices).toHaveLength(4) // the square only
    expect(r.branches).toHaveLength(1)
    expect(r.branches[0].closed).toBe(false)
    expect(r.branches[0].vertices).toHaveLength(2) // node 0 → node 4
  })

  it('leaf: two curved edges between the same pair → 1 face', () => {
    // J0,J1 connected by two edges; tangents differ so they enclose a region.
    const net: VectorNetwork = {
      nodes: [
        { x: 0, y: 0 },
        { x: 0, y: 100 },
      ],
      edges: [
        { a: 0, b: 1, ha: { x: 40, y: 30 }, hb: { x: 40, y: 70 } }, // bulges right
        { a: 0, b: 1, ha: { x: -40, y: 30 }, hb: { x: -40, y: 70 } }, // bulges left
      ],
    }
    const r = vnToFaces(net)
    expect(r.faces).toHaveLength(1)
    expect(r.branches).toHaveLength(0)
  })

  it('figure-eight: two cycles sharing a node → 2 faces', () => {
    const net: VectorNetwork = {
      nodes: [
        { x: 50, y: 50 }, // shared center 0
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 0, y: 100 },
        { x: 100, y: 100 },
      ],
      edges: [
        { a: 0, b: 1 },
        { a: 1, b: 2 },
        { a: 2, b: 0 }, // top triangle 0-1-2
        { a: 0, b: 3 },
        { a: 3, b: 4 },
        { a: 4, b: 0 }, // bottom triangle 0-3-4
      ],
    }
    const r = vnToFaces(net)
    expect(r.faces).toHaveLength(2)
  })

  it('open chain → 0 faces, all branches', () => {
    const net: VectorNetwork = {
      nodes: [
        { x: 0, y: 0 },
        { x: 50, y: 80 },
        { x: 100, y: 0 },
      ],
      edges: [
        { a: 0, b: 1 },
        { a: 1, b: 2 },
      ],
    }
    const r = vnToFaces(net)
    expect(r.faces).toHaveLength(0)
    expect(r.branches).toHaveLength(1)
    expect(r.branches[0].vertices).toHaveLength(3)
  })

  it('isolated node / empty edges → nothing', () => {
    expect(vnToFaces({ nodes: [{ x: 0, y: 0 }], edges: [] })).toEqual({ faces: [], branches: [] })
  })

  // signed area of a sub-path's anchor ring (screen-coords shoelace)
  const ringArea = (sp: { vertices: { point: { x: number; y: number } }[] }) => {
    const p = sp.vertices.map((v) => v.point)
    let a = 0
    for (let i = 0; i < p.length; i++) {
      const q = p[(i + 1) % p.length]
      a += p[i].x * q.y - q.x * p[i].y
    }
    return a / 2
  }

  it('donut: a square inside a square → inner face becomes a hole (reversed winding)', () => {
    const net: VectorNetwork = {
      nodes: [
        { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, // outer
        { x: 25, y: 25 }, { x: 75, y: 25 }, { x: 75, y: 75 }, { x: 25, y: 75 }, // inner
      ],
      edges: [
        { a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }, { a: 3, b: 0 },
        { a: 4, b: 5 }, { a: 5, b: 6 }, { a: 6, b: 7 }, { a: 7, b: 4 },
      ],
    }
    const r = vnToFaces(net)
    expect(r.faces).toHaveLength(2)
    const areas = r.faces.map(ringArea).sort((a, b) => b - a)
    // outer stays positive (filled), inner flips negative (subtracts → hole)
    expect(areas[0]).toBeGreaterThan(0)
    expect(areas[1]).toBeLessThan(0)
  })

  it('bullseye: three concentric squares → fill, hole, fill', () => {
    const ring = (i: number, s: number): [number, number][] => [
      [50 - s, 50 - s], [50 + s, 50 - s], [50 + s, 50 + s], [50 - s, 50 + s],
    ].map(([x, y]) => [x + i * 0, y]) as [number, number][]
    const nodes = [...ring(0, 45), ...ring(0, 30), ...ring(0, 15)].map(([x, y]) => ({ x, y }))
    const edges = [0, 4, 8].flatMap((o) => [
      { a: o, b: o + 1 }, { a: o + 1, b: o + 2 }, { a: o + 2, b: o + 3 }, { a: o + 3, b: o },
    ])
    const r = vnToFaces({ nodes, edges })
    expect(r.faces).toHaveLength(3)
    const areas = r.faces.map(ringArea).sort((a, b) => Math.abs(b) - Math.abs(a))
    expect(areas[0]).toBeGreaterThan(0) // outer ring: fill
    expect(areas[1]).toBeLessThan(0) // middle: hole
    expect(areas[2]).toBeGreaterThan(0) // inner dot: fill
  })

  it('adjacent faces are NOT treated as holes (no false nesting)', () => {
    // quad split by a diagonal — two adjacent triangles, neither contains the other
    const net: VectorNetwork = {
      nodes: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
      edges: [{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }, { a: 3, b: 0 }, { a: 0, b: 2 }],
    }
    const r = vnToFaces(net)
    expect(r.faces).toHaveLength(2)
    expect(r.faces.every((f) => ringArea(f) > 0)).toBe(true) // both fill, none reversed
  })
})
