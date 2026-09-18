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
const { union } = pc
import { getPage } from '../store/doc-proxy'
import { getSubpaths, compoundContent, segmentsToSubpaths, type Subpath } from '../geom/subpaths'
import { fitClosedRing, rdpSimplify } from '../geom/fit-curve'
import { pathBoolean } from '../api/boolean'
import { getWasmModule } from '../wasm-module'
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

/** The axis-perpendicular rectangle swept by a disc of radius `r` along segment a→b
 *  (flat ends; joints/caps are added separately as discs). */
function segmentRect(a: Pt, b: Pt, r: number): Ring {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const nx = (-dy / len) * r
  const ny = (dx / len) * r
  return [
    [a.x + nx, a.y + ny],
    [b.x + nx, b.y + ny],
    [b.x - nx, b.y - ny],
    [a.x - nx, a.y - ny],
    [a.x + nx, a.y + ny],
  ]
}

/** A square of side 2r centred on `c` (single-point square cap). */
function squareRing(c: Pt, r: number): Ring {
  return [
    [c.x - r, c.y - r],
    [c.x + r, c.y - r],
    [c.x + r, c.y + r],
    [c.x - r, c.y + r],
    [c.x - r, c.y - r],
  ]
}

/** A square end cap: the r-deep rectangle extending past endpoint `p` along `dir`. */
function squareEndCap(p: Pt, dir: Pt, r: number): Ring {
  const nx = -dir.y * r
  const ny = dir.x * r
  const ex = dir.x * r
  const ey = dir.y * r
  return [
    [p.x + nx, p.y + ny],
    [p.x + nx + ex, p.y + ny + ey],
    [p.x - nx + ex, p.y - ny + ey],
    [p.x - nx, p.y - ny],
    [p.x + nx, p.y + ny],
  ]
}

/**
 * The swept brush band as a clean MERGED region, built from CONVEX pieces — a
 * rectangle per segment, a disc at every interior joint (round joins), and a chosen
 * cap at each end — then `union`ed. Because every piece is convex, the union is
 * hole-free and smooth-jointed even when the stroke crosses itself many times
 * (scribbling over one spot), unlike offsetting a single self-intersecting ring,
 * which leaves even-odd slivers and rough concave kinks. Shared by the cut
 * ({@link eraseBrush}) and the live preview ({@link brushBandPath}) so they match.
 */
function brushBand(points: Pt[], radius: number, capStyle: 'round' | 'square', zoom: number): MultiPolygon {
  const r = Math.max(radius, 0.5)
  const pts = rdpSimplify(dedupePts(points), Math.max(r * 0.4, 0.5 / zoom))
  if (pts.length === 0) return []
  if (pts.length === 1) {
    return union([capStyle === 'square' ? squareRing(pts[0], r) : discRing(pts[0], r)])
  }
  const dir = (a: Pt, b: Pt): Pt => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l = Math.hypot(dx, dy) || 1
    return { x: dx / l, y: dy / l }
  }
  const parts: Polygon[] = []
  for (let i = 0; i + 1 < pts.length; i++) parts.push([segmentRect(pts[i], pts[i + 1], r)])
  for (let i = 1; i + 1 < pts.length; i++) parts.push([discRing(pts[i], r)])
  const n = pts.length
  if (capStyle === 'round') {
    parts.push([discRing(pts[0], r)], [discRing(pts[n - 1], r)])
  } else {
    parts.push([squareEndCap(pts[0], dir(pts[1], pts[0]), r)], [squareEndCap(pts[n - 1], dir(pts[n - 2], pts[n - 1]), r)])
  }
  return union(parts[0], ...parts.slice(1))
}

/** A closed cubic-Bézier SVG path from fitted anchors (handles carry the curve;
 *  a handleless anchor is a sharp corner). */
function anchorsToClosedPathD(anchors: Anchor[]): string {
  const n = anchors.length
  if (n < 2) return ''
  let d = `M ${anchors[0].point.x} ${anchors[0].point.y}`
  for (let i = 0; i < n; i++) {
    const cur = anchors[i]
    const nxt = anchors[(i + 1) % n]
    const c1 = cur.handleOut ?? cur.point
    const c2 = nxt.handleIn ?? nxt.point
    d += ` C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${nxt.point.x} ${nxt.point.y}`
  }
  return d + ' Z'
}

/**
 * The swept brush band as an SVG path `d` for the live preview. The union rings are
 * run through the SAME curve fit the commit uses ({@link fitClosedRing}), so the
 * preview is smoothed Béziers — not a raw faceted polyline that wobbles as points
 * stream in — and it matches how the erased edge will actually look on release.
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
      const closed = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      const pts = closed ? ring.slice(0, -1) : ring.slice()
      if (pts.length < 3) continue
      d += anchorsToClosedPathD(fitClosedRing(pts.map(([x, y]) => ({ x, y })), SIMPLIFY_EPS))
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
/**
 * Subtract the given clip regions from a path shape's fill, curve-native.
 *
 * The shape's real béziers are the subject and the clip (brush band or lasso) is
 * differenced out by linesweeper in Rust (`pathBoolean`) — no flattening to
 * polygons and no re-fitting afterward — so the cut edge is exact and the
 * surviving anchors stay clean. An erase that consumes the whole fill (or leaves
 * only a negligible speck) deletes the shape rather than committing an
 * un-editable remnant; one that removes nothing meaningful is a no-op. Returns
 * true when the shape was deleted. The area thresholds are screen-relative via
 * `zoom`, so the eraser behaves identically at any magnification.
 */
async function subtractClips(
  shapeId: string,
  pageId: string,
  clips: Array<Polygon | MultiPolygon>,
  zoom = 1,
): Promise<boolean> {
  if (clips.length === 0) return false
  const minRemoved = MIN_REMOVED_SCREEN_AREA / (zoom * zoom)
  const page = getPage(pageId)
  if (!page) return false
  if ((page.objects[shapeId] as PenpotNode | undefined)?.type !== 'path') return false

  const before = getCommittedNodeOnActivePage(shapeId)
  if (!before) return false

  const subpaths = getSubpaths((before as { content?: unknown }).content as Parameters<typeof getSubpaths>[0])
  const closed = subpaths.filter((sp) => sp.closed && sp.vertices.length >= 2)
  const openSubpaths = subpaths.filter((sp) => !(sp.closed && sp.vertices.length >= 2))
  const canDelete = openSubpaths.length === 0

  const subjectArea = subpathsArea(closed)
  if (subjectArea <= 0) {
    if (canDelete) {
      await deleteShape(before, pageId)
      return true
    }
    return false
  }

  const module = getWasmModule()
  if (!module) return false
  const clipSubpaths = clipsToSubpaths(clips)
  if (clipSubpaths.length === 0) return false

  const result = pathBoolean(
    module,
    compoundContent(closed),
    compoundContent(clipSubpaths),
    'difference',
    'evenodd',
  )
  const outClosed = result
    ? segmentsToSubpaths(result.segments ?? []).filter((sp) => sp.closed && sp.vertices.length >= 3)
    : []
  const remaining = subpathsArea(outClosed)

  if (
    canDelete &&
    remaining < subjectArea * 0.5 &&
    (outClosed.length === 0 || remaining < DELETE_REMNANT_AREA)
  ) {
    await deleteShape(before, pageId)
    return true
  }

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

/**
 * Even-odd filled area of closed sub-paths, flattened only for measurement (the
 * committed geometry keeps its béziers). Rings wound opposite to their exterior —
 * i.e. holes — subtract, so a shape with a hole reports its true painted area.
 * Used purely to drive the erase-to-delete and no-op thresholds.
 */
function subpathsArea(subpaths: Subpath[]): number {
  let total = 0
  for (const sp of subpaths) {
    if (!sp.closed) continue
    const poly = flattenAnchorLoop(sp.vertices, true)
    let a = 0
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      a += poly[j].x * poly[i].y - poly[i].x * poly[j].y
    }
    total += a / 2
  }
  return Math.abs(total)
}

/**
 * Flatten the clipper Polygon/MultiPolygon nesting the brush band and lasso emit
 * into closed line sub-paths for the boolean's clip operand. The eraser stroke is
 * a transient cutter, not user geometry, so approximating its arcs as line rings
 * costs nothing — only the subject's curves must stay exact.
 */
function clipsToSubpaths(clips: Array<Polygon | MultiPolygon>): Subpath[] {
  const rings: Ring[] = []
  const walk = (node: unknown): void => {
    if (
      Array.isArray(node) &&
      node.length > 0 &&
      Array.isArray(node[0]) &&
      typeof (node[0] as number[])[0] === 'number'
    ) {
      rings.push(node as Ring)
      return
    }
    if (Array.isArray(node)) for (const child of node) walk(child)
  }
  walk(clips)

  const out: Subpath[] = []
  for (const ring of rings) {
    const pts = ring.slice()
    if (pts.length > 1) {
      const first = pts[0]
      const last = pts[pts.length - 1]
      if (first[0] === last[0] && first[1] === last[1]) pts.pop()
    }
    if (pts.length < 3) continue
    out.push({ vertices: pts.map((p) => ({ point: { x: p[0], y: p[1] } })), closed: true })
  }
  return out
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
    // Re-emit `fills` (unchanged) alongside the new content: the renderer only
    // re-tessellates a path's FILL when its fills are (re)pushed, so a content-only
    // update leaves the fill stale — the cut commits but doesn't show — most visibly
    // on a shape whose last stroke was removed. Pushing fills forces the rebuild.
    fills: (before as { fills?: PenpotNode['fills'] }).fills ?? [],
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
