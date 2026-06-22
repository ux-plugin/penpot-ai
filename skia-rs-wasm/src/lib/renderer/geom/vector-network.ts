/**
 * Vector network (N) — the connectivity model behind junctions. Unlike a compound
 * path (a set of disjoint rings), a network is a graph: NODES are shared points and
 * EDGES connect two nodes. A node can have any degree, so a line can branch off a
 * corner of a closed shape while that shape stays closed — the thing sub-paths
 * alone can't express.
 *
 * The network never renders directly. It DECOMPOSES into the existing `Subpath`
 * list (`vnToSubpaths`): each graph cycle becomes a CLOSED sub-path (so it fills),
 * each open chain an OPEN sub-path (it strokes), and a shared node simply appears
 * in every sub-path that touches it — at the same coordinates. Everything
 * downstream (segments, fills, transform baking, recognizeShape) keeps consuming
 * sub-paths/segments unchanged; the network only adds the editing-time
 * connectivity the editor needs to branch and to move a shared node rigidly.
 */

import type { PathSegment } from '../types'
import type { Anchor } from './anchors'
import { cubicBounds } from './anchors'
import { compoundContent, subpathsToSegments, type Subpath } from './subpaths'
import { vnToFaces } from './vector-network-faces'

export interface VNNode {
  x: number
  y: number
}

/**
 * An edge between nodes `a` and `b`. `ha`/`hb` are the cubic control points near
 * the `a`/`b` ends (absolute world coords); omitted means that end is straight.
 * The edge is undirected for connectivity, but its handles are pinned to specific
 * node ends, so traversal direction never changes which handle belongs where.
 */
export interface VNEdge {
  a: number
  b: number
  ha?: { x: number; y: number }
  hb?: { x: number; y: number }
}

export interface VectorNetwork {
  nodes: VNNode[]
  edges: VNEdge[]
}

/** Coordinate quantum for treating two points as the same shared node. */
const MERGE_EPS = 1e-3

const clonePt = (p: { x: number; y: number }) => ({ x: p.x, y: p.y })

/** Adjacency (node → incident edge indices), ignoring self-loops. */
function adjacency(vn: VectorNetwork): number[][] {
  const adj: number[][] = vn.nodes.map(() => [])
  vn.edges.forEach((e, i) => {
    if (e.a === e.b) return
    if (adj[e.a]) adj[e.a].push(i)
    if (adj[e.b]) adj[e.b].push(i)
  })
  return adj
}

/** Number of edges incident to a node (self-loops excluded). */
export function vnNodeDegree(vn: VectorNetwork, node: number): number {
  return adjacency(vn)[node]?.length ?? 0
}

/** True when any node carries 3+ edges — i.e. the network has a real junction
 *  that a plain compound path can't represent. */
export function vnHasJunction(vn: VectorNetwork): boolean {
  return adjacency(vn).some((l) => l.length >= 3)
}

/**
 * Decompose a network into sub-paths. Trails are walked from every non-degree-2
 * node (endpoints and junctions) through chains of degree-2 nodes until they hit
 * another non-degree-2 node or return to the start; whatever closes becomes a
 * closed sub-path, the rest open. Leftover all-degree-2 edges form pure cycles.
 */
export function vnToSubpaths(vn: VectorNetwork): Subpath[] {
  const { nodes, edges } = vn
  const adj = adjacency(vn)
  const deg = adj.map((l) => l.length)
  const used = new Array(edges.length).fill(false)
  const out: Subpath[] = []

  const other = (e: VNEdge, u: number) => (e.a === u ? e.b : e.a)
  // The control point at node `u`'s end of edge `e` (independent of travel dir).
  const handleAt = (e: VNEdge, u: number) => (e.a === u ? e.ha : e.hb)

  // Turn an oriented trail (node indices + the edges between them) into a sub-path,
  // reconstructing each anchor's handleIn/handleOut from its incident edges.
  const emit = (chainNodes: number[], chainEdges: number[], closed: boolean) => {
    const m = closed ? chainNodes.length - 1 : chainNodes.length
    const verts: Anchor[] = []
    for (let idx = 0; idx < m; idx++) {
      const ni = chainNodes[idx]
      const a: Anchor = { point: { x: nodes[ni].x, y: nodes[ni].y } }
      let outE: number | undefined
      let inE: number | undefined
      if (closed) {
        outE = chainEdges[idx]
        inE = chainEdges[(idx - 1 + chainEdges.length) % chainEdges.length]
      } else {
        outE = idx < chainEdges.length ? chainEdges[idx] : undefined
        inE = idx > 0 ? chainEdges[idx - 1] : undefined
      }
      if (outE !== undefined) {
        const h = handleAt(edges[outE], ni)
        if (h) a.handleOut = clonePt(h)
      }
      if (inE !== undefined) {
        const h = handleAt(edges[inE], ni)
        if (h) a.handleIn = clonePt(h)
      }
      verts.push(a)
    }
    if (verts.length > 0) out.push({ vertices: verts, closed })
  }

  const trailFrom = (start: number, firstEdge: number) => {
    const chainNodes = [start]
    const chainEdges: number[] = []
    let u = start
    let e = firstEdge
    for (;;) {
      used[e] = true
      chainEdges.push(e)
      const v = other(edges[e], u)
      chainNodes.push(v)
      if (v === start) {
        emit(chainNodes, chainEdges, true)
        return
      }
      if (deg[v] !== 2) {
        emit(chainNodes, chainEdges, false)
        return
      }
      const nextE = adj[v].find((ei) => !used[ei])
      if (nextE === undefined) {
        emit(chainNodes, chainEdges, false)
        return
      }
      u = v
      e = nextE
    }
  }

  // Trails anchored at endpoints / junctions (split the graph at degree ≠ 2).
  for (let n = 0; n < nodes.length; n++) {
    if (deg[n] === 2 || deg[n] === 0) continue
    for (const ei of adj[n]) {
      if (!used[ei]) trailFrom(n, ei)
    }
  }
  // Remaining edges are pure degree-2 cycles (e.g. a plain closed polygon).
  for (let ei = 0; ei < edges.length; ei++) {
    if (used[ei] || edges[ei].a === edges[ei].b) continue
    trailFrom(edges[ei].a, ei)
  }
  return out
}

/**
 * Build a network from sub-paths. With `merge` (default), endpoints that coincide
 * within `MERGE_EPS` collapse to one shared node — that's how a separately drawn
 * line that starts on a shape's corner becomes a real junction. With `merge: false`
 * every vertex is its own node (a faithful, lossless 1:1 mapping).
 */
export function subpathsToVN(subpaths: Subpath[], merge = true): VectorNetwork {
  const nodes: VNNode[] = []
  const edges: VNEdge[] = []
  const map = new Map<string, number>()
  const keyOf = (x: number, y: number) => `${Math.round(x / MERGE_EPS)}:${Math.round(y / MERGE_EPS)}`
  const nodeFor = (p: { x: number; y: number }): number => {
    if (merge) {
      const k = keyOf(p.x, p.y)
      const ex = map.get(k)
      if (ex !== undefined) return ex
      const i = nodes.length
      nodes.push({ x: p.x, y: p.y })
      map.set(k, i)
      return i
    }
    const i = nodes.length
    nodes.push({ x: p.x, y: p.y })
    return i
  }

  for (const sp of subpaths) {
    const vs = sp.vertices
    if (vs.length === 0) continue
    const idxs = vs.map((v) => nodeFor(v.point))
    const segCount = sp.closed ? vs.length : vs.length - 1
    for (let i = 0; i < segCount; i++) {
      const aV = vs[i]
      const bV = vs[(i + 1) % vs.length]
      const e: VNEdge = { a: idxs[i], b: idxs[(i + 1) % vs.length] }
      if (aV.handleOut) e.ha = clonePt(aV.handleOut)
      if (bV.handleIn) e.hb = clonePt(bV.handleIn)
      edges.push(e)
    }
  }
  return { nodes, edges }
}

/** Serialize a network to render-ready segments (via its sub-path decomposition). */
export function vnToSegments(vn: VectorNetwork): PathSegment[] {
  return subpathsToSegments(vnToSubpaths(vn))
}

// ── Editing operations ──────────────────────────────────────────────────────
// All return a NEW network; inputs are never mutated. These give nodes a stable
// identity (their index) for the duration of an edit, so "branch", "close", and
// "join" collapse into one operation — `vnConnectNodes` — and a shared node is a
// real shared node, not a coincident duplicate.

const cloneNode = (n: VNNode): VNNode => ({ x: n.x, y: n.y })
const cloneEdge = (e: VNEdge): VNEdge => ({
  a: e.a,
  b: e.b,
  ...(e.ha ? { ha: clonePt(e.ha) } : {}),
  ...(e.hb ? { hb: clonePt(e.hb) } : {}),
})
const cloneVN = (vn: VectorNetwork): VectorNetwork => ({
  nodes: vn.nodes.map(cloneNode),
  edges: vn.edges.map(cloneEdge),
})

/** Index of the node nearest `point` within `eps`, or -1. */
export function vnFindNode(vn: VectorNetwork, point: { x: number; y: number }, eps: number): number {
  let best = -1
  let bestD = eps
  vn.nodes.forEach((n, i) => {
    const d = Math.hypot(n.x - point.x, n.y - point.y)
    if (d <= bestD) {
      bestD = d
      best = i
    }
  })
  return best
}

/** Move node `i` by `delta`, carrying the bézier handles of its incident edges
 *  at that node's end — so every edge touching the node follows rigidly. */
export function vnMoveNode(vn: VectorNetwork, i: number, delta: { x: number; y: number }): VectorNetwork {
  const shift = (p: { x: number; y: number }) => ({ x: p.x + delta.x, y: p.y + delta.y })
  return {
    nodes: vn.nodes.map((n, k) => (k === i ? shift(n) : cloneNode(n))),
    edges: vn.edges.map((e) => {
      const ne = cloneEdge(e)
      if (e.a === i && e.ha) ne.ha = shift(e.ha)
      if (e.b === i && e.hb) ne.hb = shift(e.hb)
      return ne
    }),
  }
}

/** Append a node at `point`; returns the new network and the new node's index. */
export function vnAddNode(
  vn: VectorNetwork,
  point: { x: number; y: number },
): { network: VectorNetwork; node: number } {
  const network = cloneVN(vn)
  network.nodes.push({ x: point.x, y: point.y })
  return { network, node: network.nodes.length - 1 }
}

/**
 * Connect two existing nodes with an edge — the single operation behind branch
 * (one end is a fresh node), close (both ends of one open chain), and join (ends
 * of two chains). A no-op for a self-loop or an already-present edge. `ha`/`hb`
 * are optional control points near the `a`/`b` ends.
 */
export function vnConnectNodes(
  vn: VectorNetwork,
  a: number,
  b: number,
  ha?: { x: number; y: number },
  hb?: { x: number; y: number },
): VectorNetwork {
  const out = cloneVN(vn)
  if (a === b || a < 0 || b < 0 || a >= out.nodes.length || b >= out.nodes.length) return out
  const exists = out.edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))
  if (!exists) {
    out.edges.push({ a, b, ...(ha ? { ha: clonePt(ha) } : {}), ...(hb ? { hb: clonePt(hb) } : {}) })
  }
  return out
}

/** Split edge `edgeIdx` at parameter `t` (0..1), inserting a node on it. Straight
 *  edges split by lerp; cubic edges (with handles) by De Casteljau, preserving the
 *  curve. Returns the new network and the inserted node's index (-1 if invalid). */
export function vnSplitEdge(
  vn: VectorNetwork,
  edgeIdx: number,
  t: number,
): { network: VectorNetwork; node: number } {
  const e = vn.edges[edgeIdx]
  if (!e) return { network: cloneVN(vn), node: -1 }
  const A = vn.nodes[e.a]
  const B = vn.nodes[e.b]
  if (!A || !B) return { network: cloneVN(vn), node: -1 }

  const lerp = (p: { x: number; y: number }, q: { x: number; y: number }, u: number) => ({
    x: p.x + (q.x - p.x) * u,
    y: p.y + (q.y - p.y) * u,
  })

  const out = cloneVN(vn)
  let mid: { x: number; y: number }
  let leftHa: { x: number; y: number } | undefined
  let leftHb: { x: number; y: number } | undefined
  let rightHa: { x: number; y: number } | undefined
  let rightHb: { x: number; y: number } | undefined

  if (e.ha || e.hb) {
    // Cubic [A, P1, P2, B] → De Casteljau split.
    const P1 = e.ha ?? A
    const P2 = e.hb ?? B
    const ab = lerp(A, P1, t)
    const bc = lerp(P1, P2, t)
    const cd = lerp(P2, B, t)
    const abbc = lerp(ab, bc, t)
    const bccd = lerp(bc, cd, t)
    mid = lerp(abbc, bccd, t)
    leftHa = ab
    leftHb = abbc
    rightHa = bccd
    rightHb = cd
  } else {
    mid = lerp(A, B, t)
  }

  out.nodes.push({ x: mid.x, y: mid.y })
  const m = out.nodes.length - 1
  out.edges.splice(edgeIdx, 1, {
    a: e.a,
    b: m,
    ...(leftHa ? { ha: leftHa } : {}),
    ...(leftHb ? { hb: leftHb } : {}),
  }, {
    a: m,
    b: e.b,
    ...(rightHa ? { ha: rightHa } : {}),
    ...(rightHb ? { hb: rightHb } : {}),
  })
  return { network: out, node: m }
}

/** Remove node `i` and every edge touching it, re-indexing the rest. */
export function vnDeleteNode(vn: VectorNetwork, i: number): VectorNetwork {
  const remap = (k: number) => (k > i ? k - 1 : k)
  return {
    nodes: vn.nodes.filter((_, k) => k !== i).map(cloneNode),
    edges: vn.edges
      .filter((e) => e.a !== i && e.b !== i)
      .map((e) => ({ ...cloneEdge(e), a: remap(e.a), b: remap(e.b) })),
  }
}

/** Remove edge `edgeIdx`. */
export function vnDeleteEdge(vn: VectorNetwork, edgeIdx: number): VectorNetwork {
  return {
    nodes: vn.nodes.map(cloneNode),
    edges: vn.edges.filter((_, k) => k !== edgeIdx).map(cloneEdge),
  }
}

/** Bounding box spanning every node and edge control point. */
export function vnBounds(vn: VectorNetwork): { x: number; y: number; width: number; height: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const acc = (p?: { x: number; y: number }) => {
    if (!p) return
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  for (const n of vn.nodes) acc(n)
  for (const e of vn.edges) {
    acc(e.ha)
    acc(e.hb)
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: minX, y: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) }
}

/** Tight curve bounds of the network — the selection-box version. Unlike
 * {@link vnBounds} (which spans the handle control points and so leaves slack
 * between box and curve), this unions each edge's exact {@link cubicBounds}, so
 * the box hugs the rendered path. Isolated nodes still count (they're curve
 * points). Use this for selrect; keep `vnBounds` only where the handle hull is
 * actually wanted. */
export function vnTightBounds(vn: VectorNetwork): { x: number; y: number; width: number; height: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const accPt = (p?: { x: number; y: number }) => {
    if (!p) return
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  for (const n of vn.nodes) accPt(n) // endpoints / isolated nodes are on the curve
  for (const e of vn.edges) {
    const a = vn.nodes[e.a]
    const b = vn.nodes[e.b]
    if (!a || !b) continue
    const cb = cubicBounds(a, e.ha ?? a, e.hb ?? b, b)
    accPt({ x: cb.minX, y: cb.minY })
    accPt({ x: cb.maxX, y: cb.maxY })
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: minX, y: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) }
}

/**
 * Toggle a degree-2 node between corner and smooth. Smoothing pulls a symmetric
 * pair of handles along the line through its two neighbours (length ⅓ of the
 * shorter incident edge); sharpening clears the handles at this node. No-op for a
 * node that isn't degree-2 (junctions/endpoints have no single smooth tangent).
 */
export function vnToggleSmoothNode(vn: VectorNetwork, i: number): VectorNetwork {
  const adj = adjacency(vn)[i] ?? []
  if (adj.length !== 2) return cloneVN(vn)
  const other = (e: VNEdge) => (e.a === i ? e.b : e.a)
  const handleAtI = (e: VNEdge) => (e.a === i ? e.ha : e.hb)
  const e0 = vn.edges[adj[0]]
  const e1 = vn.edges[adj[1]]
  const out = cloneVN(vn)
  const o0 = out.edges[adj[0]]
  const o1 = out.edges[adj[1]]
  const setHandleAtI = (e: VNEdge, h: { x: number; y: number } | undefined) => {
    if (e.a === i) {
      if (h) e.ha = h
      else delete e.ha
    } else if (h) e.hb = h
    else delete e.hb
  }

  // Already smooth here → sharpen (drop both handles at this node).
  if (handleAtI(e0) || handleAtI(e1)) {
    setHandleAtI(o0, undefined)
    setHandleAtI(o1, undefined)
    return out
  }

  // Sharp → smooth: tangent along the line between the two neighbours.
  const p = vn.nodes[i]
  const n0 = vn.nodes[other(e0)]
  const n1 = vn.nodes[other(e1)]
  const tx = n1.x - n0.x
  const ty = n1.y - n0.y
  const tlen = Math.hypot(tx, ty)
  if (tlen < 1e-9) return out
  const ux = tx / tlen
  const uy = ty / tlen
  const len0 = Math.hypot(n0.x - p.x, n0.y - p.y) / 3
  const len1 = Math.hypot(n1.x - p.x, n1.y - p.y) / 3
  // Handle toward n0 on edge e0, toward n1 on edge e1 (opposite directions).
  setHandleAtI(o0, { x: p.x - ux * len0, y: p.y - uy * len0 })
  setHandleAtI(o1, { x: p.x + ux * len1, y: p.y + uy * len1 })
  return out
}

/**
 * Pull bézier handles out of node `i` toward `handle` (Alt-drag), turning a corner
 * into a curve. The node itself doesn't move. A degree-2 point gets a SYMMETRIC
 * pair (one toward `handle`, the other reflected through the node) so it stays
 * smooth. At a JUNCTION (3+ edges) only ONE handle is brought out — on the edge
 * whose direction is closest to the drag — so you curve the edge you reach toward
 * (drag toward another edge to bring its handle out, leaving the rest untouched).
 * A degree-1 end bends its single edge.
 */
export function vnPullHandles(vn: VectorNetwork, i: number, handle: { x: number; y: number }): VectorNetwork {
  const adj = adjacency(vn)[i] ?? []
  const p = vn.nodes[i]
  if (!p || adj.length === 0) return cloneVN(vn)
  const out = cloneVN(vn)
  const setAtI = (ei: number, h: { x: number; y: number }) => {
    const e = out.edges[ei]
    if (e.a === i) e.ha = { x: h.x, y: h.y }
    else e.hb = { x: h.x, y: h.y }
  }
  if (adj.length === 2) {
    setAtI(adj[0], handle)
    setAtI(adj[1], { x: 2 * p.x - handle.x, y: 2 * p.y - handle.y })
    return out
  }
  // degree-1 or junction: bring out the edge whose direction best matches the drag.
  const dx = handle.x - p.x
  const dy = handle.y - p.y
  const dl = Math.hypot(dx, dy) || 1
  let bestEi = adj[0]
  let bestDot = -Infinity
  for (const ei of adj) {
    const e = vn.edges[ei]
    const nb = vn.nodes[e.a === i ? e.b : e.a]
    const nl = Math.hypot(nb.x - p.x, nb.y - p.y) || 1
    const dot = ((dx / dl) * (nb.x - p.x)) / nl + ((dy / dl) * (nb.y - p.y)) / nl
    if (dot > bestDot) {
      bestDot = dot
      bestEi = ei
    }
  }
  setAtI(bestEi, handle)
  return out
}

/** Drop nodes with no incident edge (stray points), re-indexing edges. */
export function vnPruneIsolatedNodes(vn: VectorNetwork): VectorNetwork {
  const deg = adjacency(vn).map((l) => l.length)
  const keep: number[] = []
  const newIndex = new Array(vn.nodes.length).fill(-1)
  vn.nodes.forEach((_, i) => {
    if (deg[i] > 0) {
      newIndex[i] = keep.length
      keep.push(i)
    }
  })
  return {
    nodes: keep.map((i) => cloneNode(vn.nodes[i])),
    edges: vn.edges.map((e) => ({ ...cloneEdge(e), a: newIndex[e.a], b: newIndex[e.b] })),
  }
}

/**
 * Build path content from a network: stores the (cloned) network as the canonical
 * editing model plus its derived sub-paths / segments (and the single-path
 * vertices+closed mirror when it decomposes to one ring), so every existing reader
 * keeps working off `subpaths`/`segments` without knowing about the graph.
 */
export function networkContent(vn: VectorNetwork): {
  network: VectorNetwork
  subpaths: Subpath[]
  segments: PathSegment[]
  vertices?: Anchor[]
  closed?: boolean
} {
  const network: VectorNetwork = {
    nodes: vn.nodes.map((n) => ({ x: n.x, y: n.y })),
    edges: vn.edges.map((e) => ({
      a: e.a,
      b: e.b,
      ...(e.ha ? { ha: clonePt(e.ha) } : {}),
      ...(e.hb ? { hb: clonePt(e.hb) } : {}),
    })),
  }
  // FILL model: the network's bounded faces become closed sub-paths (they fill),
  // and branches that enclose no area become open sub-paths (stroke only). This is
  // the planar face decomposition (`vnToFaces`) — it fills regions enclosed through
  // junctions (a "leaf" of two curves, a diagonal-split quad) that the trail
  // decomposition (`vnToSubpaths`, still used for editing/stroke geometry) can't.
  const { faces, branches } = vnToFaces(network)
  return { network, ...compoundContent([...faces, ...branches]) }
}
