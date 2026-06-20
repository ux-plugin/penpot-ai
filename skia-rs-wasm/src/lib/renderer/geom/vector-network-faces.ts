/**
 * Vector-network FACE extraction (the fill model).
 *
 * A vector network fills its *bounded faces* — the regions enclosed by edges —
 * exactly like Figma. This is the classic planar-graph face traversal (the
 * minimal-cycle-basis / half-edge method, e.g. Eberly's "Minimal Cycle Basis for
 * a Planar Graph"):
 *
 *   1. Split every edge into two directed HALF-EDGES.
 *   2. At each node, sort outgoing half-edges by departure ANGLE (the bézier
 *      tangent, so two curved edges between the same pair are distinguishable).
 *   3. `next(h)` for a half-edge arriving at v is the outgoing half-edge that is
 *      the most-CLOCKWISE neighbour of the reverse twin in v's angular order.
 *   4. Following `next` from each unused half-edge enumerates every face. The one
 *      UNBOUNDED (outer) face per component is dropped by signed area; what's left
 *      are the fillable regions. Branch/filament edges bound no region, so they
 *      end up only in dropped faces and are emitted as open sub-paths (stroke).
 *
 * Pure geometry: no wasm, fully unit-tested. Output feeds the existing
 * sub-path → fill pipeline (closed sub-paths fill, open sub-paths stroke).
 */

import type { Anchor } from './anchors'
import { planarizeNetwork } from './planarize'
import { reverseSubpath, type Subpath } from './subpaths'
import type { VectorNetwork, VNEdge } from './vector-network'

const clonePt = (p: { x: number; y: number }) => ({ x: p.x, y: p.y })
const HANDLE_EPS = 1e-6
const AREA_EPS = 1e-9

interface HalfEdge {
  from: number
  to: number
  edge: number // index into vn.edges
  twin: number // index into the half-edge array
  angle: number // departure tangent at `from`
  next: number // face successor (filled in by linkNext)
}

/** Departure tangent angle at `from` along `edge` heading toward `to`. Uses the
 *  bézier handle near `from` when present, else the straight chord. */
function departureAngle(vn: VectorNetwork, from: number, to: number, edge: VNEdge): number {
  const p = vn.nodes[from]
  const t = vn.nodes[to]
  const handle = edge.a === from ? edge.ha : edge.hb
  let dx = (handle ? handle.x : t.x) - p.x
  let dy = (handle ? handle.y : t.y) - p.y
  if (handle && Math.hypot(dx, dy) < HANDLE_EPS) {
    dx = t.x - p.x
    dy = t.y - p.y
  }
  return Math.atan2(dy, dx)
}

/** Build the directed half-edge list (two per non-self-loop edge). */
function buildHalfEdges(vn: VectorNetwork): HalfEdge[] {
  const hes: HalfEdge[] = []
  vn.edges.forEach((e, ei) => {
    if (e.a === e.b) return // skip self-loops
    const i = hes.length
    hes.push({ from: e.a, to: e.b, edge: ei, twin: i + 1, angle: departureAngle(vn, e.a, e.b, e), next: -1 })
    hes.push({ from: e.b, to: e.a, edge: ei, twin: i, angle: departureAngle(vn, e.b, e.a, e), next: -1 })
  })
  return hes
}

/** CCW-sorted outgoing half-edge ids per node, plus each half-edge's slot index. */
function angularOrder(vn: VectorNetwork, hes: HalfEdge[]): { outByNode: number[][]; pos: number[] } {
  const outByNode: number[][] = vn.nodes.map(() => [])
  hes.forEach((h, idx) => outByNode[h.from]?.push(idx))
  for (const list of outByNode) list.sort((x, y) => hes[x].angle - hes[y].angle)
  const pos = new Array<number>(hes.length).fill(0)
  outByNode.forEach((list) => list.forEach((he, slot) => (pos[he] = slot)))
  return { outByNode, pos }
}

/** Link `next` for face traversal: most-clockwise neighbour of the reverse twin. */
function linkNext(hes: HalfEdge[], outByNode: number[][], pos: number[]): void {
  hes.forEach((h) => {
    const list = outByNode[h.to]
    const k = list.length
    const p = pos[h.twin]
    h.next = list[(p - 1 + k) % k] // previous in CCW order == clockwise neighbour
  })
}

/** Trace every face cycle by following `next`. */
function traceFaces(hes: HalfEdge[]): number[][] {
  const visited = new Array<boolean>(hes.length).fill(false)
  const faces: number[][] = []
  for (let s = 0; s < hes.length; s++) {
    if (visited[s]) continue
    const face: number[] = []
    let cur = s
    let guard = 0
    while (!visited[cur] && guard++ <= hes.length) {
      visited[cur] = true
      face.push(cur)
      cur = hes[cur].next
    }
    if (face.length > 0) faces.push(face)
  }
  return faces
}

/** Signed area over a face, approximating each cubic by its control polygon
 *  (from → handle-out → handle-in). Straight edges reduce to the node ring; curved
 *  edges contribute their bulge, so a 2-node "leaf" of two curves isn't degenerate. */
function signedArea(vn: VectorNetwork, hes: HalfEdge[], face: number[]): number {
  const pts: { x: number; y: number }[] = []
  for (const hIdx of face) {
    const h = hes[hIdx]
    const e = vn.edges[h.edge]
    pts.push(vn.nodes[h.from])
    const ho = e.a === h.from ? e.ha : e.hb // leaving `from`
    if (ho) pts.push(ho)
    const hi = e.a === h.to ? e.ha : e.hb // arriving at `to`
    if (hi) pts.push(hi)
  }
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/** Turn a face's half-edge cycle into a closed sub-path, carrying handles. */
function faceToSubpath(vn: VectorNetwork, hes: HalfEdge[], face: number[]): Subpath {
  const n = face.length
  const vertices: Anchor[] = []
  for (let i = 0; i < n; i++) {
    const h = hes[face[i]]
    const prev = hes[face[(i - 1 + n) % n]]
    const node = h.from
    const a: Anchor = { point: clonePt(vn.nodes[node]) }
    const eOut = vn.edges[h.edge]
    const ho = eOut.a === node ? eOut.ha : eOut.hb // handle leaving `node`
    if (ho) a.handleOut = clonePt(ho)
    const eIn = vn.edges[prev.edge]
    const hi = eIn.a === node ? eIn.ha : eIn.hb // handle arriving at `node`
    if (hi) a.handleIn = clonePt(hi)
    vertices.push(a)
  }
  return { vertices, closed: true }
}

const centroid = (poly: { x: number; y: number }[]) => {
  let x = 0
  let y = 0
  for (const p of poly) {
    x += p.x
    y += p.y
  }
  return { x: x / poly.length, y: y / poly.length }
}

/** Ray-cast point-in-polygon. */
function pointInPolygon(pt: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

/**
 * A point GUARANTEED to lie inside a simple polygon (used for nesting tests). The
 * vertex centroid is correct for convex/typical faces and is the cheap fast path;
 * for a non-convex face whose centroid escapes into a concavity, fall back to a
 * horizontal scan line placed between two distinct vertex y's (so it hits no
 * vertex) and return the midpoint of its widest interior span.
 */
export function interiorPoint(poly: { x: number; y: number }[]): { x: number; y: number } {
  const c = centroid(poly)
  if (pointInPolygon(c, poly)) return c
  const ys = Array.from(new Set(poly.map((p) => p.y))).sort((a, b) => a - b)
  if (ys.length < 2) return c // degenerate (zero-height) — nothing to fill anyway
  const mid = Math.floor((ys.length - 1) / 2)
  const y = (ys[mid] + ys[mid + 1]) / 2
  const xs: number[] = []
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j]
    const b = poly[i]
    if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
      xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x))
    }
  }
  xs.sort((p, q) => p - q)
  let best = c
  let bestW = -1
  for (let k = 0; k + 1 < xs.length; k += 2) {
    const w = xs[k + 1] - xs[k]
    if (w > bestW) {
      bestW = w
      best = { x: (xs[k] + xs[k + 1]) / 2, y }
    }
  }
  return best
}

/** Walk a forest of edges into OPEN trails (branches that bound no face). */
function openTrails(vn: VectorNetwork, edgeIds: number[]): Subpath[] {
  const adj: number[][] = vn.nodes.map(() => [])
  for (const ei of edgeIds) {
    const e = vn.edges[ei]
    if (e.a === e.b) continue
    adj[e.a].push(ei)
    adj[e.b].push(ei)
  }
  const deg = adj.map((l) => l.length)
  const used = new Set<number>()
  const out: Subpath[] = []
  const other = (e: VNEdge, u: number) => (e.a === u ? e.b : e.a)
  const handleAt = (e: VNEdge, u: number) => (e.a === u ? e.ha : e.hb)
  const emit = (chainNodes: number[], chainEdges: number[]) => {
    const verts: Anchor[] = []
    for (let i = 0; i < chainNodes.length; i++) {
      const ni = chainNodes[i]
      const a: Anchor = { point: clonePt(vn.nodes[ni]) }
      const outE = i < chainEdges.length ? chainEdges[i] : undefined
      const inE = i > 0 ? chainEdges[i - 1] : undefined
      if (outE !== undefined) {
        const h = handleAt(vn.edges[outE], ni)
        if (h) a.handleOut = clonePt(h)
      }
      if (inE !== undefined) {
        const h = handleAt(vn.edges[inE], ni)
        if (h) a.handleIn = clonePt(h)
      }
      verts.push(a)
    }
    if (verts.length > 0) out.push({ vertices: verts, closed: false })
  }
  const trailFrom = (start: number, firstEdge: number) => {
    const chainNodes = [start]
    const chainEdges: number[] = []
    let u = start
    let e = firstEdge
    for (;;) {
      used.add(e)
      chainEdges.push(e)
      const v = other(vn.edges[e], u)
      chainNodes.push(v)
      if (deg[v] !== 2) {
        emit(chainNodes, chainEdges)
        return
      }
      const nextE = adj[v].find((x) => !used.has(x))
      if (nextE === undefined) {
        emit(chainNodes, chainEdges)
        return
      }
      u = v
      e = nextE
    }
  }
  for (let n = 0; n < vn.nodes.length; n++) {
    if (deg[n] === 2 || deg[n] === 0) continue
    for (const ei of adj[n]) if (!used.has(ei)) trailFrom(n, ei)
  }
  for (const ei of edgeIds) {
    if (!used.has(ei) && vn.edges[ei].a !== vn.edges[ei].b) trailFrom(vn.edges[ei].a, ei)
  }
  return out
}

/**
 * Decompose a network into FILLABLE faces (closed sub-paths) and BRANCHES (open
 * sub-paths, stroke only). With this traversal a BOUNDED interior face winds with
 * POSITIVE signed area (screen-coords shoelace); the single outer face per
 * component winds negative (largest magnitude) and is dropped. An edge that lands
 * in no bounded face is a branch.
 */
export function vnToFaces(input: VectorNetwork): { faces: Subpath[]; branches: Subpath[] } {
  // Restore planarity first: an un-noded crossing breaks the face traversal.
  const vn = planarizeNetwork(input)
  const hes = buildHalfEdges(vn)
  if (hes.length === 0) return { faces: [], branches: [] }
  const { outByNode, pos } = angularOrder(vn, hes)
  linkNext(hes, outByNode, pos)
  const rawFaces = traceFaces(hes)

  const bounded = rawFaces.filter((f) => signedArea(vn, hes, f) > AREA_EPS)

  // Which edges participate in a bounded face? The rest are branches.
  const edgeBounded = new Array<boolean>(vn.edges.length).fill(false)
  for (const f of bounded) for (const h of f) edgeBounded[hes[h].edge] = true
  const branchEdges = vn.edges
    .map((_, i) => i)
    .filter((i) => vn.edges[i].a !== vn.edges[i].b && !edgeBounded[i])

  // Holes: a face geometrically inside another (a disjoint inner ring) must
  // subtract, not fill solid. Reverse the winding of faces at ODD containment
  // depth so the existing nonzero fill turns them into holes (outer CCW + inner
  // CW = donut). A face j contains face i only if j is strictly larger AND i's
  // interior point falls inside j (the size test breaks the concentric symmetry).
  const areas = bounded.map((f) => Math.abs(signedArea(vn, hes, f)))
  const subs = bounded.map((f) => faceToSubpath(vn, hes, f))
  const polys = subs.map((sp) => sp.vertices.map((v) => v.point))
  const pts = polys.map(interiorPoint)
  const faces = subs.map((sp, i) => {
    let depth = 0
    for (let j = 0; j < polys.length; j++) {
      if (j !== i && areas[j] > areas[i] && pointInPolygon(pts[i], polys[j])) depth++
    }
    return depth % 2 === 1 ? reverseSubpath(sp) : sp
  })

  return { faces, branches: openTrails(vn, branchEdges) }
}
