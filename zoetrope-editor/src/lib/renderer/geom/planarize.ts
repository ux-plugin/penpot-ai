/**
 * Planarize a vector network: wherever two edges CROSS with no node at the
 * crossing, insert a node there and split both edges. Face extraction assumes a
 * planar embedding, so a single un-noded crossing corrupts the whole traversal —
 * this restores planarity first (the "expand intersections" step Figma runs before
 * computing fills).
 *
 * The result is a COPY used only to compute faces; the stored, editable network is
 * never changed, so crossings never become permanent points.
 *
 * Handles line–line, line–curve and curve–curve. Curves are flattened to polylines
 * to LOCATE crossings (so every edge reduces to segments), then the real curve is
 * split at the recovered parameter via De Casteljau, so sub-edges keep true curve
 * geometry. Flatten resolution bounds the crossing-point error to sub-pixel.
 */

import type { VectorNetwork, VNEdge, VNNode } from './vector-network'

const PARAM_EPS = 1e-6 // interior-vs-endpoint cutoff on an edge parameter
const MERGE_EPS = 1e-4 // crossing points / nodes closer than this are one node
const CURVE_SAMPLES = 24 // flatten resolution per cubic

type Pt = { x: number; y: number }
const isCurved = (e: VNEdge) => e.ha != null || e.hb != null
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const interior = (t: number) => t > PARAM_EPS && t < 1 - PARAM_EPS

function cubicAt(p0: Pt, c1: Pt, c2: Pt, p3: Pt, t: number): Pt {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const c = 3 * mt * t * t
  const d = t * t * t
  return { x: a * p0.x + b * c1.x + c * c2.x + d * p3.x, y: a * p0.y + b * c1.y + c * c2.y + d * p3.y }
}

const ctrls = (vn: VectorNetwork, e: VNEdge): [Pt, Pt, Pt, Pt] => [
  vn.nodes[e.a],
  e.ha ?? vn.nodes[e.a],
  e.hb ?? vn.nodes[e.b],
  vn.nodes[e.b],
]

/** Flatten an edge to sample points carrying their parameter `t`. */
function flatten(vn: VectorNetwork, e: VNEdge): { x: number; y: number; t: number }[] {
  if (!isCurved(e)) {
    return [
      { ...vn.nodes[e.a], t: 0 },
      { ...vn.nodes[e.b], t: 1 },
    ]
  }
  const [p0, c1, c2, p3] = ctrls(vn, e)
  const pts: { x: number; y: number; t: number }[] = []
  for (let k = 0; k <= CURVE_SAMPLES; k++) {
    const t = k / CURVE_SAMPLES
    pts.push({ ...cubicAt(p0, c1, c2, p3, t), t })
  }
  return pts
}

interface Hit {
  t: number
  u: number
  point: Pt
}
/** Strict segment×segment intersection (params in [0,1]). */
function segIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): Hit | null {
  const rx = p2.x - p1.x
  const ry = p2.y - p1.y
  const sx = p4.x - p3.x
  const sy = p4.y - p3.y
  const denom = rx * sy - ry * sx
  if (Math.abs(denom) < 1e-12) return null
  const qpx = p3.x - p1.x
  const qpy = p3.y - p1.y
  const t = (qpx * sy - qpy * sx) / denom
  const u = (qpx * ry - qpy * rx) / denom
  if (t < -PARAM_EPS || t > 1 + PARAM_EPS || u < -PARAM_EPS || u > 1 + PARAM_EPS) return null
  return { t, u, point: { x: p1.x + t * rx, y: p1.y + t * ry } }
}

/** De Casteljau split of a cubic at sorted params in (0,1) → list of sub-cubics. */
function splitCubic(p0: Pt, c1: Pt, c2: Pt, p3: Pt, ts: number[]): [Pt, Pt, Pt, Pt][] {
  const pieces: [Pt, Pt, Pt, Pt][] = []
  let cur: [Pt, Pt, Pt, Pt] = [p0, c1, c2, p3]
  let t0 = 0
  for (const t of ts) {
    const lt = (t - t0) / (1 - t0)
    const [q0, q1, q2, q3] = cur
    const a = lerp(q0, q1, lt)
    const b = lerp(q1, q2, lt)
    const c = lerp(q2, q3, lt)
    const d = lerp(a, b, lt)
    const e = lerp(b, c, lt)
    const m = lerp(d, e, lt)
    pieces.push([q0, a, d, m])
    cur = [m, e, c, q3]
    t0 = t
  }
  pieces.push(cur)
  return pieces
}

/**
 * Return a planarized copy of `vn`: crossing edges split at a shared inserted node,
 * curves preserved as sub-curves. Networks with no crossings come back unchanged.
 */
export function planarizeNetwork(vn: VectorNetwork): VectorNetwork {
  const nodes: VNNode[] = vn.nodes.map((n) => ({ x: n.x, y: n.y }))
  const splits: { t: number; node: number }[][] = vn.edges.map(() => [])

  const nodeAt = (p: Pt): number => {
    for (let k = 0; k < nodes.length; k++) {
      if (Math.abs(nodes[k].x - p.x) < MERGE_EPS && Math.abs(nodes[k].y - p.y) < MERGE_EPS) return k
    }
    nodes.push({ x: p.x, y: p.y })
    return nodes.length - 1
  }
  const addSplit = (edge: number, t: number, node: number) => {
    const list = splits[edge]
    if (list.some((s) => s.node === node || Math.abs(s.t - t) < PARAM_EPS)) return
    list.push({ t, node })
  }

  const flats = vn.edges.map((e) => flatten(vn, e))

  for (let i = 0; i < vn.edges.length; i++) {
    const ei = vn.edges[i]
    if (ei.a === ei.b) continue
    for (let j = i + 1; j < vn.edges.length; j++) {
      const ej = vn.edges[j]
      if (ej.a === ej.b) continue
      // endpoints the two edges share — meeting there is not a crossing
      const shared = [ei.a, ei.b].filter((n) => n === ej.a || n === ej.b)
      const Fi = flats[i]
      const Fj = flats[j]
      for (let a = 0; a < Fi.length - 1; a++) {
        for (let b = 0; b < Fj.length - 1; b++) {
          const hit = segIntersect(Fi[a], Fi[a + 1], Fj[b], Fj[b + 1])
          if (!hit) continue
          if (shared.some((n) => Math.abs(vn.nodes[n].x - hit.point.x) < MERGE_EPS && Math.abs(vn.nodes[n].y - hit.point.y) < MERGE_EPS)) {
            continue // crossing is the shared endpoint
          }
          const ti = lerp({ x: Fi[a].t, y: 0 }, { x: Fi[a + 1].t, y: 0 }, hit.t).x
          const tj = lerp({ x: Fj[b].t, y: 0 }, { x: Fj[b + 1].t, y: 0 }, hit.u).x
          const node = nodeAt(hit.point)
          if (interior(ti)) addSplit(i, ti, node)
          if (interior(tj)) addSplit(j, tj, node)
        }
      }
    }
  }

  const edges: VNEdge[] = []
  vn.edges.forEach((e, i) => {
    const sp = splits[i].slice().sort((x, y) => x.t - y.t)
    if (sp.length === 0) {
      edges.push({ a: e.a, b: e.b, ...(e.ha ? { ha: { ...e.ha } } : {}), ...(e.hb ? { hb: { ...e.hb } } : {}) })
      return
    }
    const nodeSeq = [e.a, ...sp.map((s) => s.node), e.b]
    if (!isCurved(e)) {
      let prev = nodeSeq[0]
      for (let k = 1; k < nodeSeq.length; k++) {
        if (nodeSeq[k] === prev) continue
        edges.push({ a: prev, b: nodeSeq[k] })
        prev = nodeSeq[k]
      }
      return
    }
    const [p0, c1, c2, p3] = ctrls(vn, e)
    const pieces = splitCubic(p0, c1, c2, p3, sp.map((s) => s.t))
    for (let k = 0; k < pieces.length; k++) {
      const a = nodeSeq[k]
      const b = nodeSeq[k + 1]
      if (a === b) continue
      const [, C1, C2] = pieces[k]
      edges.push({ a, b, ha: { x: C1.x, y: C1.y }, hb: { x: C2.x, y: C2.y } })
    }
  })

  return { nodes, edges }
}
