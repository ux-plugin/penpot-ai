import { describe, expect, it } from 'vitest'
import {
  networkContent,
  subpathsToVN,
  vnAddNode,
  vnConnectNodes,
  vnDeleteNode,
  vnFindNode,
  vnBounds,
  vnHasJunction,
  vnMoveNode,
  vnNodeDegree,
  vnPruneIsolatedNodes,
  vnPullHandles,
  vnSplitEdge,
  vnTightBounds,
  vnToSubpaths,
  vnToggleSmoothNode,
  type VectorNetwork,
} from '../../../../src/lib/renderer/geom/vector-network'
import type { Subpath } from '../../../../src/lib/renderer/geom/subpaths'
import type { Anchor } from '../../../../src/lib/renderer/geom/anchors'

const corner = (x: number, y: number): Anchor => ({ point: { x, y } })
const pts = (sp: Subpath) => sp.vertices.map((v) => [v.point.x, v.point.y])

const square: Subpath = {
  vertices: [corner(0, 0), corner(10, 0), corner(10, 10), corner(0, 10)],
  closed: true,
}
const line: Subpath = { vertices: [corner(0, 0), corner(-5, -5)], closed: false }

describe('subpathsToVN', () => {
  it('a plain closed polygon → one node per vertex, one edge per side', () => {
    const vn = subpathsToVN([square])
    expect(vn.nodes).toHaveLength(4)
    expect(vn.edges).toHaveLength(4) // closed → wraps
    expect(vn.nodes.every((_, i) => vnNodeDegree(vn, i) === 2)).toBe(true)
    expect(vnHasJunction(vn)).toBe(false)
  })

  it('an open polyline has one fewer edge than vertices', () => {
    const vn = subpathsToVN([line])
    expect(vn.edges).toHaveLength(1)
  })

  it('merges a coincident endpoint into a shared node → junction', () => {
    // `line` starts at (0,0), which is also corner 0 of the square.
    const vn = subpathsToVN([square, line])
    expect(vn.nodes).toHaveLength(5) // 4 square + 1 new tip; (0,0) shared
    expect(vnNodeDegree(vn, 0)).toBe(3) // the shared corner now has 3 edges
    expect(vnHasJunction(vn)).toBe(true)
  })

  it('merge:false keeps every vertex distinct (lossless)', () => {
    const vn = subpathsToVN([square, line], false)
    expect(vn.nodes).toHaveLength(6)
    expect(vnHasJunction(vn)).toBe(false)
  })

  it('carries bézier handles onto the edge ends', () => {
    const curved: Subpath = {
      vertices: [
        { point: { x: 0, y: 0 }, handleOut: { x: 3, y: 1 } },
        { point: { x: 10, y: 0 }, handleIn: { x: 7, y: 1 } },
      ],
      closed: false,
    }
    const vn = subpathsToVN([curved])
    expect(vn.edges[0].ha).toEqual({ x: 3, y: 1 })
    expect(vn.edges[0].hb).toEqual({ x: 7, y: 1 })
  })
})

describe('vnToSubpaths', () => {
  it('round-trips a plain closed polygon (no merge artifacts)', () => {
    const vn = subpathsToVN([square])
    const back = vnToSubpaths(vn)
    expect(back).toHaveLength(1)
    expect(back[0].closed).toBe(true)
    expect(pts(back[0])).toEqual(pts(square))
  })

  it('round-trips an open polyline as one open sub-path', () => {
    const back = vnToSubpaths(subpathsToVN([line]))
    expect(back).toHaveLength(1)
    expect(back[0].closed).toBe(false)
    expect(pts(back[0])).toEqual(pts(line))
  })

  it('splits a ring+spur into a closed loop and an open branch sharing the corner', () => {
    const vn = subpathsToVN([square, line]) // junction at (0,0)
    const back = vnToSubpaths(vn)
    expect(back).toHaveLength(2)
    const closed = back.find((s) => s.closed)
    const open = back.find((s) => !s.closed)
    expect(closed).toBeDefined()
    expect(open).toBeDefined()
    // the closed loop is the 4-corner square (still fills)
    expect(closed!.vertices).toHaveLength(4)
    // the branch runs from the shared corner (0,0) out to the tip (-5,-5)
    expect(open!.vertices).toHaveLength(2)
    expect(pts(open!)).toContainEqual([0, 0])
    expect(pts(open!)).toContainEqual([-5, -5])
  })

  it('preserves handles through decomposition', () => {
    const curved: Subpath = {
      vertices: [
        { point: { x: 0, y: 0 }, handleOut: { x: 3, y: 1 } },
        { point: { x: 10, y: 0 }, handleIn: { x: 7, y: 1 } },
      ],
      closed: false,
    }
    const back = vnToSubpaths(subpathsToVN([curved]))
    expect(back[0].vertices[0].handleOut).toEqual({ x: 3, y: 1 })
    expect(back[0].vertices[1].handleIn).toEqual({ x: 7, y: 1 })
  })

  it('ignores isolated (degree-0) nodes', () => {
    const vn: VectorNetwork = { nodes: [{ x: 0, y: 0 }, { x: 5, y: 5 }], edges: [] }
    expect(vnToSubpaths(vn)).toEqual([])
  })

  it('handles a figure-eight (two loops sharing one node) as two closed sub-paths', () => {
    // node 0 is shared by both loops → degree 4.
    const vn: VectorNetwork = {
      nodes: [
        { x: 0, y: 0 }, // 0 shared
        { x: 10, y: 0 }, // 1
        { x: 10, y: 10 }, // 2
        { x: -10, y: 0 }, // 3
        { x: -10, y: -10 }, // 4
      ],
      edges: [
        { a: 0, b: 1 },
        { a: 1, b: 2 },
        { a: 2, b: 0 },
        { a: 0, b: 3 },
        { a: 3, b: 4 },
        { a: 4, b: 0 },
      ],
    }
    expect(vnNodeDegree(vn, 0)).toBe(4)
    const back = vnToSubpaths(vn)
    expect(back).toHaveLength(2)
    expect(back.every((s) => s.closed)).toBe(true)
  })
})

describe('networkContent', () => {
  it('stores the network plus a derived sub-path / segment mirror', () => {
    const vn = subpathsToVN([square, line]) // ring + spur (junction)
    const c = networkContent(vn)
    expect(c.network.nodes).toHaveLength(5)
    expect(c.subpaths).toHaveLength(2) // closed ring + open spur
    expect(c.segments.filter((s) => s.type === 'move-to')).toHaveLength(2)
    expect(c.vertices).toBeUndefined() // multi sub-path → no single mirror
  })

  it('a lone ring also exposes the single vertices/closed mirror', () => {
    const c = networkContent(subpathsToVN([square]))
    expect(c.subpaths).toHaveLength(1)
    expect(c.closed).toBe(true)
    expect(c.vertices).toHaveLength(4)
  })

  it('deep-clones the network (mutating input does not touch output)', () => {
    const vn = subpathsToVN([square])
    const c = networkContent(vn)
    vn.nodes[0].x = 999
    expect(c.network.nodes[0].x).toBe(0)
  })
})

describe('vector-network editing ops', () => {
  // A closed square (nodes 0..3) — the canonical "closed shape".
  const squareVN = (): VectorNetwork => ({
    nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    edges: [{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }, { a: 3, b: 0 }],
  })

  it('vnFindNode hits within eps and misses beyond', () => {
    const vn = squareVN()
    expect(vnFindNode(vn, { x: 10.2, y: -0.1 }, 1)).toBe(1)
    expect(vnFindNode(vn, { x: 5, y: 5 }, 1)).toBe(-1)
  })

  it('branch off a closed shape: add node + connect — shape stays closed, corner gains degree 3', () => {
    const vn0 = squareVN()
    const { network: vn1, node: tip } = vnAddNode(vn0, { x: -6, y: -6 })
    const vn2 = vnConnectNodes(vn1, 0, tip) // branch from corner 0
    expect(vn2.nodes).toHaveLength(5)
    expect(vn2.edges).toHaveLength(5)
    expect(vnNodeDegree(vn2, 0)).toBe(3) // the junction
    // decomposes to a closed square + an open spur
    const subs = vnToSubpaths(vn2)
    expect(subs.filter((s) => s.closed)).toHaveLength(1)
    expect(subs.filter((s) => !s.closed)).toHaveLength(1)
  })

  it('vnConnectNodes is the same op for close (no duplicate node, no duplicate edge)', () => {
    // open chain 0-1-2
    const open: VectorNetwork = {
      nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 9 }],
      edges: [{ a: 0, b: 1 }, { a: 1, b: 2 }],
    }
    const closed = vnConnectNodes(open, 2, 0) // close the chain
    expect(closed.nodes).toHaveLength(3) // NO new node
    expect(closed.edges).toHaveLength(3)
    expect(vnToSubpaths(closed)[0].closed).toBe(true)
    // connecting again is a no-op (edge already exists)
    expect(vnConnectNodes(closed, 0, 2).edges).toHaveLength(3)
  })

  it('vnConnectNodes refuses a self-loop', () => {
    const vn = squareVN()
    expect(vnConnectNodes(vn, 1, 1).edges).toHaveLength(4)
  })

  it('vnMoveNode carries incident edge handles rigidly', () => {
    const vn: VectorNetwork = {
      nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      edges: [{ a: 0, b: 1, ha: { x: 3, y: 2 }, hb: { x: 7, y: 2 } }],
    }
    const moved = vnMoveNode(vn, 0, { x: 5, y: 5 })
    expect(moved.nodes[0]).toEqual({ x: 5, y: 5 })
    expect(moved.edges[0].ha).toEqual({ x: 8, y: 7 }) // a-end handle followed
    expect(moved.edges[0].hb).toEqual({ x: 7, y: 2 }) // b-end handle untouched
  })

  it('vnSplitEdge on a straight edge inserts the midpoint and two edges', () => {
    const vn = squareVN()
    const { network, node } = vnSplitEdge(vn, 0, 0.5) // split edge 0-1
    expect(network.nodes[node]).toEqual({ x: 5, y: 0 })
    expect(network.edges).toHaveLength(5)
    expect(network.edges.some((e) => e.a === 0 && e.b === node)).toBe(true)
    expect(network.edges.some((e) => e.a === node && e.b === 1)).toBe(true)
  })

  it('vnSplitEdge on a cubic preserves the curve (De Casteljau)', () => {
    const vn: VectorNetwork = {
      nodes: [{ x: 0, y: 0 }, { x: 12, y: 0 }],
      edges: [{ a: 0, b: 1, ha: { x: 0, y: 6 }, hb: { x: 12, y: 6 } }],
    }
    const { network, node } = vnSplitEdge(vn, 0, 0.5)
    // midpoint of this symmetric cubic is at x=6, y=4.5
    expect(network.nodes[node].x).toBeCloseTo(6)
    expect(network.nodes[node].y).toBeCloseTo(4.5)
    expect(network.edges).toHaveLength(2)
  })

  it('vnDeleteNode drops the node + its edges and re-indexes', () => {
    const vn0 = squareVN()
    const { network: vn1, node: tip } = vnAddNode(vn0, { x: -6, y: -6 })
    const vn2 = vnConnectNodes(vn1, 0, tip)
    const vn3 = vnDeleteNode(vn2, 0) // delete the junction corner
    expect(vn3.nodes).toHaveLength(4)
    // every remaining edge references a valid node
    expect(vn3.edges.every((e) => e.a < 4 && e.b < 4 && e.a >= 0 && e.b >= 0)).toBe(true)
    // the branch edge (to the tip) is gone with the corner
    expect(vn3.edges).toHaveLength(2)
  })

  it('vnPruneIsolatedNodes removes stray points', () => {
    const vn: VectorNetwork = {
      nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 99, y: 99 }],
      edges: [{ a: 0, b: 1 }],
    }
    const pruned = vnPruneIsolatedNodes(vn)
    expect(pruned.nodes).toHaveLength(2)
    expect(pruned.edges[0]).toMatchObject({ a: 0, b: 1 })
  })

  it('ops do not mutate their input', () => {
    const vn = squareVN()
    vnMoveNode(vn, 0, { x: 5, y: 5 })
    vnConnectNodes(vn, 0, 2)
    vnDeleteNode(vn, 0)
    expect(vn.nodes[0]).toEqual({ x: 0, y: 0 })
    expect(vn.edges).toHaveLength(4)
  })
})

describe('vnBounds + vnToggleSmoothNode', () => {
  it('vnBounds spans nodes and edge handles', () => {
    const vn: VectorNetwork = {
      nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      edges: [{ a: 0, b: 1, ha: { x: 2, y: -4 }, hb: { x: 8, y: 6 } }],
    }
    expect(vnBounds(vn)).toEqual({ x: 0, y: -4, width: 10, height: 10 })
  })

  it('vnToggleSmoothNode smooths then sharpens a degree-2 corner', () => {
    // 0-1-2 chain; node 1 is the corner.
    const vn: VectorNetwork = {
      nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
      edges: [{ a: 0, b: 1 }, { a: 1, b: 2 }],
    }
    const smooth = vnToggleSmoothNode(vn, 1)
    // both incident edges gain a handle at node 1, opposite directions along x
    const h0 = smooth.edges[0].hb // edge 0-1, handle at node 1 (b end)
    const h1 = smooth.edges[1].ha // edge 1-2, handle at node 1 (a end)
    expect(h0).toBeDefined()
    expect(h1).toBeDefined()
    expect(h0!.x).toBeCloseTo(10 - 10 / 3) // toward neighbour 0
    expect(h1!.x).toBeCloseTo(10 + 10 / 3) // toward neighbour 2
    // toggling again removes them
    const sharp = vnToggleSmoothNode(smooth, 1)
    expect(sharp.edges[0].hb).toBeUndefined()
    expect(sharp.edges[1].ha).toBeUndefined()
  })

  it('vnToggleSmoothNode is a no-op at a junction (degree 3)', () => {
    const vn: VectorNetwork = {
      nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 0 }],
      edges: [{ a: 0, b: 1 }, { a: 0, b: 2 }, { a: 0, b: 3 }],
    }
    expect(vnToggleSmoothNode(vn, 0).edges).toEqual(vn.edges)
  })
})

describe('vnPullHandles (Alt-drag bend)', () => {
  it('pulls symmetric handles out of a degree-2 node', () => {
    const vn: VectorNetwork = {
      nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
      edges: [{ a: 0, b: 1 }, { a: 1, b: 2 }],
    }
    const out = vnPullHandles(vn, 1, { x: 13, y: 5 }) // handle pulled up-right
    expect(out.edges[0].hb).toEqual({ x: 13, y: 5 }) // first incident edge, at node 1
    expect(out.edges[1].ha).toEqual({ x: 7, y: -5 }) // reflected through node 1 (10,0)
  })

  it('bends the single edge of a degree-1 end', () => {
    const vn: VectorNetwork = {
      nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      edges: [{ a: 0, b: 1 }],
    }
    const out = vnPullHandles(vn, 1, { x: 12, y: 4 })
    expect(out.edges[0].hb).toEqual({ x: 12, y: 4 })
  })
})

describe('vnPullHandles at a junction (3+ edges)', () => {
  it('brings out only the edge closest to the drag direction', () => {
    // node 0 has three edges (to 1 at +x, 2 at +y, 3 at -x).
    const vn: VectorNetwork = {
      nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 0 }],
      edges: [{ a: 0, b: 1 }, { a: 0, b: 2 }, { a: 0, b: 3 }],
    }
    // drag toward +x → edge 0 (neighbour at +x) wins; the others stay straight.
    const out = vnPullHandles(vn, 0, { x: 8, y: 1 })
    expect(out.edges[0].ha).toEqual({ x: 8, y: 1 })
    expect(out.edges[1].ha).toBeUndefined()
    expect(out.edges[2].ha).toBeUndefined()
  })

  it('drag toward another edge brings out that one instead', () => {
    const vn: VectorNetwork = {
      nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 0 }],
      edges: [{ a: 0, b: 1 }, { a: 0, b: 2 }, { a: 0, b: 3 }],
    }
    const out = vnPullHandles(vn, 0, { x: 1, y: 8 }) // toward +y → edge 1
    expect(out.edges[1].ha).toEqual({ x: 1, y: 8 })
    expect(out.edges[0].ha).toBeUndefined()
  })
})


describe('vnTightBounds', () => {
  it('hugs the curve where vnBounds spans the handle hull', () => {
    const vn: VectorNetwork = {
      nodes: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      edges: [{ a: 0, b: 1, ha: { x: 0, y: -40 }, hb: { x: 100, y: -40 } }],
    }
    expect(vnBounds(vn)).toEqual({ x: 0, y: -40, width: 100, height: 40 })
    const t = vnTightBounds(vn)
    expect(t.x).toBeCloseTo(0, 6)
    expect(t.y).toBeCloseTo(-30, 6)
    expect(t.width).toBeCloseTo(100, 6)
    expect(t.height).toBeCloseTo(30, 6)
  })
})
