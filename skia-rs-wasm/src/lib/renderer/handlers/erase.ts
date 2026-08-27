/**
 * Destructive brush eraser: drag a stroke over the path being edited and the
 * swept band (the drag polyline thickened by the brush radius) is boolean-
 * SUBTRACTED from the target — an eraser only ever removes area, never adds. The
 * band that overlaps the fill is cut out (a hole when it stays interior, a bite
 * when it crosses the outline); the part of the band outside the shape simply
 * subtracts nothing. The transient band shape is never added to the document.
 *
 * This is the `eraser` vector sub-tool (`pathEditingShapeId` is the target); the
 * capture is driven by PathEditorOverlay. The result is stored as a compound
 * sub-path list (rings), which the path editor still derives editable nodes from.
 *
 * The subtraction uses a robust polygon clipper (`polygon-clipping`) rather than
 * render-wasm's curve boolean: the latter re-stitches contours by fuzzy endpoint
 * matching and shatters into slivers / flips winding when the band crosses the
 * outline of an already-compound shape. Curves are flattened to fine polylines
 * for the cut — the preserved outline stays crisp within a sub-pixel tolerance,
 * and the cut boundary is polygonal anyway.
 */

import * as polygonClippingNs from 'polygon-clipping'
import type { MultiPolygon, Polygon, Ring } from 'polygon-clipping'

// `polygon-clipping` is CommonJS: Vite's dep pre-bundle hangs the operations off
// the default export, not as ES named exports, so reach through `default`.
const pc = (polygonClippingNs as unknown as { default?: typeof polygonClippingNs }).default ??
  polygonClippingNs
const { difference, union, xor } = pc
import { getPage } from '../store/doc-proxy'
import { getSubpaths, compoundContent, reverseSubpath, type Subpath } from '../geom/subpaths'
import { fitClosedRing, fitOpenRunIdx, rdpSimplify } from '../geom/fit-curve'
import type { Anchor, Pt } from '../geom/anchors'
import { anchorsTightBounds } from '../geom/anchors'
import { commitNodePartialUpdate, getCommittedNodeOnActivePage } from '../properties/commit-node-properties'
import { applyChanges } from '../../page-crud'
import type { AddObjChange, DelObjChange, PenpotNode } from 'penpot-exporter/types'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'

/** Below this removed area — measured in SCREEN px² so it means the same thing at
 *  any zoom — the drag erased nothing meaningful (a scribble that missed, or a
 *  hair-thin graze), so it's discarded. World-area thresholds would wrongly reject
 *  a legitimate cut when zoomed way in (a 22-px brush is <1 world px there). */
const MIN_REMOVED_SCREEN_AREA = 2

/** When a cut leaves less than this much fill (world units²) — and it wasn't a
 *  stray miss — the shape is treated as fully erased and deleted, so you can
 *  erase a shape down to nothing instead of getting stuck on a last speck. */
const DELETE_REMNANT_AREA = 40

/** Points sampled around a round brush cap / joint disc. */
const DISC_STEPS = 20

/** Max world-space chord when flattening a curved edge to a polyline. Small
 *  enough that the preserved outline reads as smooth. */
const FLATTEN_CHORD = 2

/** Douglas–Peucker tolerance (world units) for the committed cut geometry: drops
 *  near-collinear points so a curved or dense cut lands as a handful of editable
 *  nodes, not one per flattened sample. Applied to every result ring. */
const SIMPLIFY_EPS = 3

/**
 * Erase the swept brush band from one path shape. `worldPts` is the drag
 * polyline, `radius` the brush half-width (world units). Returns true when the
 * shape was fully erased away (so the caller can leave edit mode).
 */
export async function eraseBrush(
  worldPts: Pt[],
  shapeId: string,
  pageId: string,
  radius: number,
  zoom = 1,
  capStyle: 'round' | 'square' = 'round',
): Promise<boolean> {
  const band = brushBand(worldPts, radius, capStyle, zoom)
  if (band.length === 0) return false
  return subtractClips(shapeId, pageId, [band], zoom)
}

/**
 * The swept brush band as a clean MERGED region (self-overlaps unioned away): the
 * drag polyline, jitter-dropped, is thickened by the radius into ONE capsule
 * outline (not a union of per-point discs — that scallops the edge into dozens of
 * false corners), then `union`ed so a stroke that re-crosses itself becomes a
 * single area rather than a tangle of self-intersecting edges. Shared by the cut
 * ({@link eraseBrush}) and the live preview ({@link brushBandPath}) so they match.
 */
function brushBand(points: Pt[], radius: number, capStyle: 'round' | 'square', zoom: number): MultiPolygon {
  const r = Math.max(radius, 0.5)
  const pts = rdpSimplify(dedupePts(points), Math.max(r * 0.2, 0.5 / zoom))
  const outline = strokeToBandPolygon(pts, r, capStyle)
  if (outline.length < 3) return []
  const ring: Ring = outline.map((p): [number, number] => [p.x, p.y])
  ring.push([ring[0][0], ring[0][1]])
  return union([ring])
}

/**
 * The swept brush band as an SVG path `d` (all rings, sub-paths concatenated) — for
 * the live erase preview, so re-crossing the same area shows the union of the swept
 * region (one merged blob) instead of overlapping self-intersecting outlines. It is
 * exactly the geometry {@link eraseBrush} subtracts, so the preview never lies.
 */
export function brushBandPath(
  points: Pt[],
  radius: number,
  capStyle: 'round' | 'square' = 'round',
  zoom = 1,
): string {
  let d = ''
  for (const poly of brushBand(points, radius, capStyle, zoom)) {
    for (const ring of poly) {
      if (ring.length < 2) continue
      d += 'M' + ring.map(([x, y]) => `${x} ${y}`).join(' L ') + ' Z'
    }
  }
  return d
}

/**
 * Free-form ("vector") eraser: the drag polyline is CLOSED into a lasso polygon
 * and that whole enclosed region is subtracted — draw a shape over the fill and
 * it's cropped out. `worldPts` is the drag path; the loop auto-closes on release.
 * Subtract-only like the brush: a lasso that encloses no fill is a no-op.
 */
export async function eraseLasso(
  worldPts: Pt[],
  shapeId: string,
  pageId: string,
  zoom = 1,
): Promise<boolean> {
  const pts = dedupePts(worldPts)
  if (pts.length < 3) return false
  const ring: Ring = pts.map((p): [number, number] => [p.x, p.y])
  ring.push([ring[0][0], ring[0][1]])
  // Normalize the hand-drawn loop (self-intersections → valid polygons) so the
  // clip is well-formed before the difference.
  const lasso = union([ring])
  if (lasso.length === 0) return false
  return subtractClips(shapeId, pageId, [lasso], zoom)
}

/**
 * Free-form eraser with curves: the closed anchor loop (corners + bézier handles,
 * built pen-style by click-for-corner / drag-for-curve) is flattened to a fine
 * polygon and its enclosed region is subtracted. Same subtract-only, no-op-on-miss
 * contract as {@link eraseLasso}.
 */
export async function eraseLassoAnchors(
  vertices: Anchor[],
  shapeId: string,
  pageId: string,
  zoom = 1,
): Promise<boolean> {
  if (vertices.length < 3) return false
  const poly = flattenAnchorLoop(vertices, true)
  if (poly.length < 3) return false
  const ring: Ring = poly.map((p): [number, number] => [p.x, p.y])
  ring.push([ring[0][0], ring[0][1]])
  const lasso = union([ring])
  if (lasso.length === 0) return false
  return subtractClips(shapeId, pageId, [lasso], zoom)
}

/**
 * Shared subtract-and-commit core: build the shape's current filled region, cut
 * the given clip geometry out of it, and commit (or delete if fully erased).
 * Returns true when the shape was erased away.
 */
async function subtractClips(
  shapeId: string,
  pageId: string,
  clips: Array<Polygon | MultiPolygon>,
  zoom = 1,
): Promise<boolean> {
  if (clips.length === 0) return false
  // No-op floor in world units² for the current zoom (constant on screen).
  const minRemoved = MIN_REMOVED_SCREEN_AREA / (zoom * zoom)
  const page = getPage(pageId)
  if (!page) return false
  if ((page.objects[shapeId] as PenpotNode | undefined)?.type !== 'path') return false

  // Plain (non-proxy) snapshot for the commit: `commitNodePartialUpdate`
  // structuredClones `before` for the undo frame, which a valtio proxy can't.
  const before = getCommittedNodeOnActivePage(shapeId)
  if (!before) return false

  const subpaths = getSubpaths((before as { content?: unknown }).content as Parameters<typeof getSubpaths>[0])
  const closed = subpaths.filter((sp) => sp.closed && sp.vertices.length >= 2)
  const openSubpaths = subpaths.filter((sp) => !(sp.closed && sp.vertices.length >= 2))
  const canDelete = openSubpaths.length === 0

  // Current filled region as a clean MultiPolygon. XOR of the stored rings is the
  // even-odd (nesting-parity) fill — exactly how the shape paints — so nested
  // holes fall out without classifying exterior-vs-hole by hand.
  const polys = closed.map((sp): [Ring] => [subpathToRing(sp)])
  const subject = closed.length ? xor(polys[0], ...polys.slice(1)) : []
  // A path with no fillable area (no closed rings, or they collapse to ~zero) is
  // an invisible husk — an erase gesture on it removes it rather than no-op'ing.
  if (subject.length === 0) {
    if (canDelete) {
      await deleteShape(before, pageId)
      return true
    }
    return false
  }

  const subjectArea = mpArea(subject)
  const result = difference(subject, clips[0], ...clips.slice(1))
  const remaining = mpArea(result)
  // Re-fit ONLY the boundary the cut touched, reusing the shape's existing anchors
  // everywhere else — so erasing a new area doesn't reshuffle nodes computed for a
  // previous cut. `clips` supplies the cut boundary the arc is measured against.
  const outClosed = refitPreservingAnchors(result, closed, clips)

  // Erased away: what's left is a negligible sliver (or the fit dropped every
  // ring), AND this stroke actually consumed the shape (not a stray miss that
  // leaves the fill intact). Delete rather than commit an un-editable speck.
  if (
    canDelete &&
    remaining < subjectArea * 0.5 &&
    (outClosed.length === 0 || remaining < DELETE_REMNANT_AREA)
  ) {
    await deleteShape(before, pageId)
    return true
  }

  // Otherwise require a meaningful removal to commit a change (kills no-op scribbles).
  if (subjectArea - remaining < minRemoved) return false

  await commitNodePartialUpdate(
    shapeId,
    before,
    erasePartial(before, [...outClosed, ...openSubpaths]),
    pageId,
  )
  return false
}

/** Drop consecutive duplicate points (within a hair) from the raw drag. */
function dedupePts(pts: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-3) out.push({ x: p.x, y: p.y })
  }
  return out
}

function discRing(c: Pt, r: number): Ring {
  const out: Ring = []
  for (let k = 0; k <= DISC_STEPS; k++) {
    const a = (k / DISC_STEPS) * Math.PI * 2
    out.push([c.x + Math.cos(a) * r, c.y + Math.sin(a) * r])
  }
  return out
}

/**
 * A single closed capsule outline around the drag polyline — the exact swept
 * band, for the overlay to preview while the drag is in flight (cosmetic only;
 * the real cut unions {@link bandPieces}). Offsets both sides by `radius` and
 * rounds the two ends.
 */
export function strokeToBandPolygon(pts: Pt[], radius: number, capStyle: 'round' | 'square' = 'round'): Pt[] {
  const r = Math.max(radius, 0.5)
  if (pts.length === 0) return []
  if (pts.length === 1) {
    const c = pts[0]
    if (capStyle === 'square') {
      return [
        { x: c.x - r, y: c.y - r },
        { x: c.x + r, y: c.y - r },
        { x: c.x + r, y: c.y + r },
        { x: c.x - r, y: c.y + r },
      ]
    }
    return discRing(c, r).map(([x, y]) => ({ x, y }))
  }

  const n = pts.length
  const dirAt = (i: number): Pt => {
    const prev = pts[Math.max(0, i - 1)]
    const next = pts[Math.min(n - 1, i + 1)]
    const dx = next.x - prev.x
    const dy = next.y - prev.y
    const len = Math.hypot(dx, dy) || 1
    return { x: dx / len, y: dy / len }
  }
  const left: Pt[] = []
  const right: Pt[] = []
  for (let i = 0; i < n; i++) {
    const d = dirAt(i)
    const nx = -d.y
    const ny = d.x
    left.push({ x: pts[i].x + nx * r, y: pts[i].y + ny * r })
    right.push({ x: pts[i].x - nx * r, y: pts[i].y - ny * r })
  }
  const startDir = dirAt(0)
  const endDir = dirAt(n - 1)
  // A square cap extends the two side corners past the endpoint by `r` and joins
  // them flat, so a straight drag reads as a rectangle; a round cap rounds them.
  const endCap = (center: Pt, dir: Pt, a: Pt, b: Pt): Pt[] =>
    capStyle === 'square'
      ? [
          { x: a.x + dir.x * r, y: a.y + dir.y * r },
          { x: b.x + dir.x * r, y: b.y + dir.y * r },
        ]
      : cap(center, dir, r)
  const poly: Pt[] = []
  for (let i = 0; i < n; i++) poly.push(left[i])
  poly.push(...endCap(pts[n - 1], endDir, left[n - 1], right[n - 1]))
  for (let i = n - 1; i >= 0; i--) poly.push(right[i])
  poly.push(...endCap(pts[0], { x: -startDir.x, y: -startDir.y }, right[0], left[0]))
  return poly
}

/** Semicircle of `r` around `center`, bulging toward `dir`. */
function cap(center: Pt, dir: Pt, r: number): Pt[] {
  const base = Math.atan2(dir.y, dir.x)
  const out: Pt[] = []
  const steps = Math.round(DISC_STEPS / 2)
  for (let k = 0; k <= steps; k++) {
    const a = base + Math.PI / 2 - Math.PI * (k / steps)
    out.push({ x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r })
  }
  return out
}

/**
 * Flatten an anchor loop (lines + cubics) to a polyline, sampling curved edges so
 * the chord stays under `FLATTEN_CHORD`. With `closed`, the edge from the last
 * anchor back to the first is included. Exported so the overlay can preview the
 * exact curved outline the free-form eraser will cut.
 */
export function flattenAnchorLoop(vertices: Anchor[], closed: boolean): Pt[] {
  const n = vertices.length
  const out: Pt[] = []
  const lastEdge = closed ? n : n - 1
  for (let i = 0; i < n; i++) {
    const a = vertices[i]
    out.push({ x: a.point.x, y: a.point.y })
    if (i >= lastEdge) break
    const b = vertices[(i + 1) % n]
    if (a.handleOut || b.handleIn) {
      const p0 = a.point
      const p1 = a.handleOut ?? a.point
      const p2 = b.handleIn ?? b.point
      const p3 = b.point
      const steps = Math.max(2, Math.min(40, Math.round(cubicLen(p0, p1, p2, p3) / FLATTEN_CHORD)))
      for (let k = 1; k < steps; k++) out.push(cubicAt(p0, p1, p2, p3, k / steps))
    }
  }
  return out
}

/** Flatten a closed sub-path (lines + cubics) to a polygon ring. */
function subpathToRing(sp: Subpath): Ring {
  const poly = flattenAnchorLoop(sp.vertices, true)
  const ring: Ring = poly.map((p): [number, number] => [p.x, p.y])
  if (ring.length > 0) ring.push([ring[0][0], ring[0][1]])
  return ring
}

function cubicAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  }
}

/** Coarse control-polygon length — only used to pick a sample count. */
function cubicLen(p0: Pt, p1: Pt, p2: Pt, p3: Pt): number {
  return (
    Math.hypot(p1.x - p0.x, p1.y - p0.y) +
    Math.hypot(p2.x - p1.x, p2.y - p1.y) +
    Math.hypot(p3.x - p2.x, p3.y - p2.y)
  )
}

/** Signed shoelace area of a ring. */
function ringArea(ring: Ring): number {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  }
  return a / 2
}

/** Even-odd filled area of a clipper MultiPolygon: each polygon is exterior minus
 *  its holes, so |exterior| − Σ|holes|. */
function mpArea(mp: MultiPolygon): number {
  let total = 0
  for (const poly of mp) {
    poly.forEach((ring, i) => {
      total += i === 0 ? Math.abs(ringArea(ring)) : -Math.abs(ringArea(ring))
    })
  }
  return Math.max(0, total)
}

/**
 * Clipper MultiPolygon → compound sub-paths. Each polygon contributes its
 * exterior (wound positive) and one sub-path per hole (wound negative), so
 * render-wasm's non-zero fill cuts the holes; even-odd nesting would too.
 */
function mpToSubpaths(mp: MultiPolygon): Subpath[] {
  const out: Subpath[] = []
  for (const poly of mp) {
    poly.forEach((ring, i) => {
      const sp = ringToSubpath(ring, i === 0)
      if (sp) out.push(sp)
    })
  }
  return out
}

/** One clipper ring → a closed sub-path, oriented positive for an exterior and
 *  negative (opposite) for a hole. Drops the duplicated closing vertex and fits
 *  the dense ring to a few corner/smooth anchors (curvature kept via handles). */
function ringToSubpath(ring: Ring, exterior: boolean): Subpath | null {
  const pts = ring.slice()
  if (pts.length > 1) {
    const first = pts[0]
    const last = pts[pts.length - 1]
    if (first[0] === last[0] && first[1] === last[1]) pts.pop()
  }
  if (pts.length < 3) return null
  const anchors = fitClosedRing(pts.map((p) => ({ x: p[0], y: p[1] })), SIMPLIFY_EPS)
  if (anchors.length < 3) return null
  const positive = ringArea(anchors.map((a): [number, number] => [a.point.x, a.point.y])) > 0
  const sp: Subpath = { vertices: anchors, closed: true }
  return positive === exterior ? sp : reverseSubpath(sp)
}

/** World-px: a result-ring vertex this close to an existing anchor reuses it. */
const REFIT_MATCH_EPS = 0.5
/** World-px: a result-ring vertex this close to a cut edge is NEW boundary. */
const REFIT_CLIP_EPS = 0.6

type Seg = [readonly [number, number], readonly [number, number]]

/** Perp distance from a point to a segment (both endpoints as [x,y]). */
function segDistPt(p: Pt, a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  if (l2 === 0) return Math.hypot(p.x - a[0], p.y - a[1])
  let t = ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a[0] + t * dx), p.y - (a[1] + t * dy))
}

/** Recursively collect every ring (Array of [x,y]) out of clipper nesting. */
function collectRings(node: unknown, out: Ring[]): void {
  if (Array.isArray(node) && node.length > 0 && Array.isArray(node[0]) && typeof (node[0] as number[])[0] === 'number') {
    out.push(node as Ring)
    return
  }
  if (Array.isArray(node)) for (const child of node) collectRings(child, out)
}

function distToSegs(p: Pt, segs: Seg[]): number {
  let m = Infinity
  for (const [a, b] of segs) {
    const d = segDistPt(p, a, b)
    if (d < m) {
      m = d
      if (m < 1e-6) break
    }
  }
  return m
}

/**
 * Turn a cut result into sub-paths WITHOUT reshuffling the shape's existing
 * anchors: every result-ring vertex that still coincides with a prior anchor
 * reuses that anchor verbatim, and only the arcs the cut actually changed (their
 * vertices lie on the cut boundary) are re-fitted to fresh nodes. So erasing a new
 * area leaves the nodes from earlier cuts exactly where they were. Falls back to a
 * full {@link fitClosedRing} for a ring with no surviving anchors (fresh geometry).
 */
function refitPreservingAnchors(
  result: MultiPolygon,
  oldClosed: Subpath[],
  clips: Array<Polygon | MultiPolygon>,
): Subpath[] {
  const oldAnchors = oldClosed.flatMap((sp) => sp.vertices)
  if (oldAnchors.length === 0) return mpToSubpaths(result)
  const clipRings: Ring[] = []
  collectRings(clips, clipRings)
  const clipSegs: Seg[] = []
  for (const r of clipRings) for (let i = 0; i + 1 < r.length; i++) clipSegs.push([r[i], r[i + 1]])

  const out: Subpath[] = []
  for (const poly of result) {
    poly.forEach((ring, i) => {
      const sp = refitRing(ring, i === 0, oldAnchors, clipSegs)
      if (sp) out.push(sp)
    })
  }
  return out
}

function refitRing(ring: Ring, exterior: boolean, oldAnchors: Anchor[], clipSegs: Seg[]): Subpath | null {
  const pts = ring.slice()
  if (pts.length > 1) {
    const f = pts[0]
    const l = pts[pts.length - 1]
    if (f[0] === l[0] && f[1] === l[1]) pts.pop()
  }
  if (pts.length < 3) return null
  const V: Pt[] = pts.map((p) => ({ x: p[0], y: p[1] }))
  const n = V.length

  // Match each surviving anchor to its nearest ring vertex (one-to-one).
  type Seed = { idx: number; anchor: Anchor; corner: boolean }
  const seeds: Seed[] = []
  const used = new Set<number>()
  for (const oa of oldAnchors) {
    let best = -1
    let bd = REFIT_MATCH_EPS
    for (let i = 0; i < n; i++) {
      if (used.has(i)) continue
      const d = Math.hypot(V[i].x - oa.point.x, V[i].y - oa.point.y)
      if (d < bd) {
        bd = d
        best = i
      }
    }
    if (best >= 0) {
      used.add(best)
      seeds.push({ idx: best, anchor: oa, corner: !oa.handleIn && !oa.handleOut })
    }
  }
  // A ring with almost no surviving anchors is fresh geometry — fit it wholesale.
  if (seeds.length < 2) return ringToSubpath(ring, exterior)
  seeds.sort((a, b) => a.idx - b.idx)

  type Node = { p: Pt; corner: boolean; reuse?: Anchor }
  const nodes: Node[] = []
  const seedNodeIdx: number[] = []
  const arcChanged: boolean[] = []
  for (let s = 0; s < seeds.length; s++) {
    const cur = seeds[s]
    const nxt = seeds[(s + 1) % seeds.length]
    const interior: Pt[] = []
    for (let i = (cur.idx + 1) % n; i !== nxt.idx; i = (i + 1) % n) interior.push(V[i])
    const changed = interior.some((v) => distToSegs(v, clipSegs) < REFIT_CLIP_EPS)
    arcChanged.push(changed)
    seedNodeIdx.push(nodes.length)
    nodes.push({ p: { x: cur.anchor.point.x, y: cur.anchor.point.y }, corner: cur.corner, reuse: cur.anchor })
    if (changed && interior.length) {
      const withEnds = [V[cur.idx], ...interior, V[nxt.idx]]
      const { idx, corner } = fitOpenRunIdx(withEnds, SIMPLIFY_EPS)
      for (let k = 0; k < idx.length; k++) {
        const li = idx[k]
        if (li === 0 || li === withEnds.length - 1) continue
        nodes.push({ p: { x: withEnds[li].x, y: withEnds[li].y }, corner: corner[k] })
      }
    }
  }
  // A seed is reused whole only when BOTH its arcs are unchanged; if either arc was
  // cut, keep its position but recompute handles so they follow the new boundary.
  for (let s = 0; s < seeds.length; s++) {
    const prevCh = arcChanged[(s - 1 + seeds.length) % seeds.length]
    const nextCh = arcChanged[s]
    if (prevCh || nextCh) nodes[seedNodeIdx[s]].reuse = undefined
  }

  const m = nodes.length
  if (m < 3) return ringToSubpath(ring, exterior)
  const anchors: Anchor[] = nodes.map((nd, i) => {
    if (nd.reuse) return nd.reuse
    if (nd.corner) return { point: { x: nd.p.x, y: nd.p.y } }
    const prev = nodes[(i - 1 + m) % m].p
    const next = nodes[(i + 1) % m].p
    const tx = next.x - prev.x
    const ty = next.y - prev.y
    const tl = Math.hypot(tx, ty) || 1
    const ux = tx / tl
    const uy = ty / tl
    const dPrev = Math.hypot(nd.p.x - prev.x, nd.p.y - prev.y) / 3
    const dNext = Math.hypot(next.x - nd.p.x, next.y - nd.p.y) / 3
    return {
      point: { x: nd.p.x, y: nd.p.y },
      handleIn: { x: nd.p.x - ux * dPrev, y: nd.p.y - uy * dPrev },
      handleOut: { x: nd.p.x + ux * dNext, y: nd.p.y + uy * dNext },
    }
  })
  const positive = ringArea(anchors.map((a): [number, number] => [a.point.x, a.point.y])) > 0
  const sp: Subpath = { vertices: anchors, closed: true }
  return positive === exterior ? sp : reverseSubpath(sp)
}

/**
 * Node-geometry partial from the cut result: compound content (clearing the
 * single-path/network mirrors so holes survive) and a tight curve bbox.
 */
function erasePartial(before: PenpotNode, subpaths: Subpath[]): Partial<PenpotNode> {
  const compound = compoundContent(subpaths)
  const b = unionTightBounds(subpaths)
  const prev = (before as { content?: Record<string, unknown> }).content ?? {}
  return {
    content: {
      ...prev,
      network: undefined,
      vertices: undefined,
      closed: undefined,
      ...compound,
    } as PenpotNode['content'],
    points: [
      { x: b.x, y: b.y },
      { x: b.x + b.width, y: b.y },
      { x: b.x + b.width, y: b.y + b.height },
      { x: b.x, y: b.y + b.height },
    ],
    selrect: {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      x1: b.x,
      y1: b.y,
      x2: b.x + b.width,
      y2: b.y + b.height,
    },
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
  } as Partial<PenpotNode>
}

/** Union of each sub-path's tight (curve-hugging) bounds. */
function unionTightBounds(subpaths: Subpath[]): {
  x: number
  y: number
  width: number
  height: number
} {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const sp of subpaths) {
    const bb = anchorsTightBounds(sp.vertices, sp.closed)
    minX = Math.min(minX, bb.x)
    minY = Math.min(minY, bb.y)
    maxX = Math.max(maxX, bb.x + bb.width)
    maxY = Math.max(maxY, bb.y + bb.height)
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** Remove a shape whose fill the eraser fully covered, keeping it undoable. */
async function deleteShape(node: PenpotNode, pageId: string): Promise<void> {
  const page = getPage(pageId)
  const parentId = node.parentId ?? ROOT_UUID
  const parent = page ? (page.objects[parentId] as PenpotNode | undefined) : undefined
  const index = parent?.shapes?.indexOf(node.id) ?? 0
  const del: DelObjChange = { type: 'del-obj', id: node.id, pageId }
  const undo: AddObjChange = {
    type: 'add-obj',
    id: node.id,
    obj: node,
    frameId: parentId,
    parentId,
    index,
    pageId,
  }
  await applyChanges([del], { undoChanges: [undo] })
}
