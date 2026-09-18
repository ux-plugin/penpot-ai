import { describe, it, expect } from 'vitest'
import { planarizeNetwork } from '@/lib/renderer/geom/planarize'
import { vnToFaces } from '@/lib/renderer/geom/vector-network-faces'
import type { VectorNetwork } from '@/lib/renderer/geom/vector-network'

describe('planarizeNetwork', () => {
  it('an X of two segments → 1 crossing node, 4 sub-edges', () => {
    const net: VectorNetwork = {
      nodes: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
        { x: 100, y: 0 },
        { x: 0, y: 100 },
      ],
      edges: [
        { a: 0, b: 1 }, // ↘
        { a: 2, b: 3 }, // ↙
      ],
    }
    const p = planarizeNetwork(net)
    expect(p.nodes).toHaveLength(5) // 4 corners + crossing
    expect(p.edges).toHaveLength(4) // each diagonal split in two
    const cross = p.nodes[4]
    expect(cross.x).toBeCloseTo(50)
    expect(cross.y).toBeCloseTo(50)
  })

  it('no crossings → returned unchanged in shape', () => {
    const net: VectorNetwork = {
      nodes: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
      edges: [
        { a: 0, b: 1 },
        { a: 1, b: 2 },
      ],
    }
    const p = planarizeNetwork(net)
    expect(p.nodes).toHaveLength(3)
    expect(p.edges).toHaveLength(2)
  })

  it('adjacent edges sharing a node are not split', () => {
    const net: VectorNetwork = {
      nodes: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 50, y: 100 },
      ],
      edges: [
        { a: 0, b: 1 },
        { a: 1, b: 2 }, // shares node 1 with the first
      ],
    }
    expect(planarizeNetwork(net).edges).toHaveLength(2)
  })

  it('T-junction: an endpoint lying on another edge splits the through-edge', () => {
    const net: VectorNetwork = {
      nodes: [
        { x: 0, y: 0 },
        { x: 100, y: 0 }, // edge 0 along the x-axis
        { x: 50, y: 0 }, // edge 1 endpoint sits ON edge 0
        { x: 50, y: 80 },
      ],
      edges: [
        { a: 0, b: 1 }, // through-edge
        { a: 2, b: 3 }, // stem rising from the midpoint
      ],
    }
    const p = planarizeNetwork(net)
    // through-edge split at node 2; stem untouched → 3 edges, same 4 nodes
    expect(p.nodes).toHaveLength(4)
    expect(p.edges).toHaveLength(3)
  })

  it('line crossing a curve → both split (line–curve)', () => {
    const net: VectorNetwork = {
      nodes: [
        { x: 0, y: 50 },
        { x: 100, y: 50 }, // horizontal line
        { x: 50, y: 0 },
        { x: 50, y: 100 }, // curve bulging right, crosses the line once
      ],
      edges: [
        { a: 0, b: 1 },
        { a: 2, b: 3, ha: { x: 80, y: 33 }, hb: { x: 80, y: 66 } },
      ],
    }
    const p = planarizeNetwork(net)
    expect(p.nodes).toHaveLength(5) // 1 crossing node
    expect(p.edges).toHaveLength(4) // line→2, curve→2
    // the curve sub-edges still carry handles
    expect(p.edges.filter((e) => e.ha || e.hb).length).toBe(2)
  })

  it('two curves crossing → both split (curve–curve)', () => {
    const net: VectorNetwork = {
      nodes: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
        { x: 100, y: 0 },
      ],
      edges: [
        { a: 0, b: 1, ha: { x: 60, y: 10 }, hb: { x: 40, y: 90 } }, // ↘ bulge
        { a: 2, b: 3, ha: { x: 60, y: 90 }, hb: { x: 40, y: 10 } }, // ↗ bulge
      ],
    }
    const p = planarizeNetwork(net)
    expect(p.nodes.length).toBeGreaterThanOrEqual(5)
    expect(p.edges.length).toBeGreaterThanOrEqual(4)
  })

  it('a straight edge cutting a leaf curve yields fillable sub-faces', () => {
    // leaf between 0 and 1 (two curves) with a straight edge slicing through one
    // curve from an outside node — must produce at least one bounded face.
    const net: VectorNetwork = {
      nodes: [
        { x: 0, y: 0 },
        { x: 0, y: 100 },
        { x: 60, y: -20 },
        { x: 60, y: 60 },
      ],
      edges: [
        { a: 0, b: 1, ha: { x: 50, y: 30 }, hb: { x: 50, y: 70 } }, // right curve
        { a: 0, b: 1, ha: { x: -50, y: 30 }, hb: { x: -50, y: 70 } }, // left curve
        { a: 2, b: 3 }, // straight, slices the right curve
      ],
    }
    expect(vnToFaces(net).faces.length).toBeGreaterThanOrEqual(1)
  })
})

describe('vnToFaces with planarization — the screenshot topology', () => {
  it('two straight edges crossing + a curved leaf → leaf is detected', () => {
    // N0 top, N1 right, N2 bold, N3 dark, N4 mid-right, N5 bottom.
    // E1 (N1-N2) and E2 (N0-N3) cross with no node — this used to yield 0 faces.
    const net: VectorNetwork = {
      nodes: [
        { x: 203, y: 143 },
        { x: 470, y: 393 },
        { x: 250, y: 685 },
        { x: 487, y: 895 },
        { x: 540, y: 550 },
        { x: 420, y: 1245 },
      ],
      edges: [
        { a: 0, b: 1 },
        { a: 1, b: 2 }, // crosses E2
        { a: 0, b: 3 }, // crosses E1
        { a: 2, b: 3, ha: { x: 430, y: 650 }, hb: { x: 570, y: 760 } }, // leaf curve
        { a: 2, b: 3, ha: { x: 240, y: 880 }, hb: { x: 360, y: 1060 } }, // leaf curve
        { a: 3, b: 4 },
        { a: 3, b: 5 },
      ],
    }
    const r = vnToFaces(net)
    // The leaf (and the small faces created around the crossing) now fill.
    expect(r.faces.length).toBeGreaterThanOrEqual(1)
  })
})
