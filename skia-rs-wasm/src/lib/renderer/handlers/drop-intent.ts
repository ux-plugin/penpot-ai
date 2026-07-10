/**
 * Drop intent — the per-frame "where would this land" resolution shared by the
 * drag preview overlay (Slice 1: red insertion line + target highlight) and the
 * commit path (so the drop lands where the line showed).
 *
 * Pure + read-only: this never touches WASM modifiers or commits anything. It's
 * the reusable seam the drop-preview pipeline is built on — a later variant will
 * resolve a slot target into a view-mirror preview.
 */
import type { Point } from 'penpot-exporter/types'
import type { IndexedPage, IndexedShape } from '../../worker/types'
import { findContainerAtPoint } from '../../components/LayersPanel/reparent'

type Axis = 'x' | 'y'

interface FlexInfo {
  axis: Axis
  reverse: boolean
}

/** Flex main axis + direction, or null when the node isn't a flex container. */
function flexAxis(node: IndexedShape): FlexInfo | null {
  const dir = (node as { layoutFlexDir?: string }).layoutFlexDir
  if (!dir) return null
  return { axis: dir.startsWith('row') ? 'x' : 'y', reverse: dir.endsWith('reverse') }
}

/** Any layout (flex OR grid) — used for the target highlight even when we don't draw a line. */
function hasAnyLayout(node: IndexedShape): boolean {
  const n = node as { layoutFlexDir?: unknown; layoutGridDir?: unknown }
  return Boolean(n.layoutFlexDir || n.layoutGridDir)
}

interface ChildRect {
  x: number
  y: number
  width: number
  height: number
  cx: number
  cy: number
}

/** Immediate children (in `shapes` order) that have a selrect, with centers precomputed. */
function orderedChildRects(
  target: IndexedShape,
  objects: Record<string, IndexedShape>,
): ChildRect[] {
  const ids = (target as { shapes?: string[] }).shapes ?? []
  const out: ChildRect[] = []
  for (const id of ids) {
    const sr = objects[id]?.selrect
    if (!sr) continue
    const width = sr.width ?? 0
    const height = sr.height ?? 0
    out.push({ x: sr.x, y: sr.y, width, height, cx: sr.x + width / 2, cy: sr.y + height / 2 })
  }
  return out
}

/** One child's laid-out geometry along the container's main and cross axes. */
interface DropItem {
  /** Index in the container's `shapes` array — the value returned for insertion. */
  docIndex: number
  mainLo: number
  mainHi: number
  mainC: number
  crossLo: number
  crossHi: number
}

/**
 * Insertion index for `point` among a flex container's children — a wrap-aware
 * port of the frontend's `get-drop-index` (drop_area.cljc), computed on the
 * container's RESTING child positions (each child's `selrect` in `objects`).
 *
 * Resting is the whole point: the drag preview's placeholder is a WASM-only shape
 * that never enters `objects`, so here the children sit where they rest — a stable
 * reference. (Measuring against the live, gapped layout is what made earlier
 * versions unstable.) Because we read the real laid-out rects, all spacing —
 * padding, gaps, margins, differing sizes, justify/align — is already baked in; we
 * never model it.
 *
 * Algorithm: group children into wrap lines by clustering overlapping cross-axis
 * intervals; tile the cross axis into per-line bands split at the middle of each
 * inter-line gap; within the cursor's line, count children whose center precedes
 * the cursor on the main axis. Map that visual position back to a document index
 * (reverse flips visual↔document order on the main axis). Non-flex: append.
 */
export function computeDropIndex(
  target: IndexedShape,
  objects: Record<string, IndexedShape>,
  point: Point,
): number {
  const flex = flexAxis(target)
  const shapeIds = (target as { shapes?: string[] }).shapes ?? []
  if (!flex) return shapeIds.length

  const main: 'x' | 'y' = flex.axis
  const cross: 'x' | 'y' = main === 'x' ? 'y' : 'x'

  // Resting geometry per child, keyed by its real position in `shapes`.
  const items: DropItem[] = []
  for (let i = 0; i < shapeIds.length; i++) {
    const sr = objects[shapeIds[i]]?.selrect
    if (!sr) continue
    const w = sr.width ?? 0
    const h = sr.height ?? 0
    const lo = { x: sr.x, y: sr.y }
    const hi = { x: sr.x + w, y: sr.y + h }
    const c = { x: sr.x + w / 2, y: sr.y + h / 2 }
    items.push({
      docIndex: i,
      mainLo: lo[main],
      mainHi: hi[main],
      mainC: c[main],
      crossLo: lo[cross],
      crossHi: hi[cross],
    })
  }
  if (items.length === 0) return 0

  // Cluster into wrap lines: sort by cross start, break where a child begins past
  // the running cross extent (a gap). Overlapping intervals merge, so differing
  // child heights / align-items on the same row still land in one line.
  const byCross = [...items].sort((a, b) => a.crossLo - b.crossLo)
  const lines: DropItem[][] = []
  let cur: DropItem[] = []
  let runHi = -Infinity
  for (const it of byCross) {
    if (cur.length === 0 || it.crossLo <= runHi) {
      cur.push(it)
      runHi = Math.max(runHi, it.crossHi)
    } else {
      lines.push(cur)
      cur = [it]
      runHi = it.crossHi
    }
  }
  if (cur.length > 0) lines.push(cur)
  // Children within a line run along the main axis in visual order.
  for (const line of lines) line.sort((a, b) => a.mainLo - b.mainLo)

  const pMain = point[main]
  const pCross = point[cross]

  // Tiled cross bands: line i owns everything up to the midpoint of the gap to
  // line i+1; the last line owns the rest. Every cross position maps to a line.
  const crossLoOf = lines.map((l) => Math.min(...l.map((it) => it.crossLo)))
  const crossHiOf = lines.map((l) => Math.max(...l.map((it) => it.crossHi)))
  let lineIdx = lines.length - 1
  for (let i = 0; i < lines.length; i++) {
    const upper = i + 1 < lines.length ? (crossHiOf[i] + crossLoOf[i + 1]) / 2 : Infinity
    if (pCross < upper) {
      lineIdx = i
      break
    }
  }

  // Visual insertion position: children in earlier lines + children in this line
  // whose center precedes the cursor on the main axis.
  const before = lines.slice(0, lineIdx).reduce((n, l) => n + l.length, 0)
  const local = lines[lineIdx].filter((it) => it.mainC < pMain).length
  const p = before + local

  const vis = lines.flat()
  // Map the visual insertion position `p` to a `shapes`-array index. Penpot stores
  // children in the OPPOSITE order to their visual layout for NON-reverse containers
  // (the engine iterates children reversed when not reverse; the frontend does
  // `(cond->> (enumerate children) (not reverse?) reverse)`). So for a non-reverse
  // layout, "insert before the child at visual position p" means insert AFTER it in
  // the array (index+1), and the visual end maps to array index 0. Reverse layouts
  // lay out in array order, so the mapping is the natural forward one.
  if (p >= vis.length) return flex.reverse ? shapeIds.length : 0
  const doc = vis[p].docIndex
  return flex.reverse ? doc : doc + 1
}

/**
 * The insertion line in WORLD coords (authored in world space; the overlay's parent
 * applies the viewport transform). Perpendicular to the main axis, at the boundary
 * before child `index`, spanning the container's cross-axis extent. Null when the
 * target isn't a flex container. Assumes visual order matches `shapes` order
 * (exact for non-reverse; reverse is approximate).
 */
export function insertionLineWorld(
  target: IndexedShape,
  objects: Record<string, IndexedShape>,
  index: number,
): { x1: number; y1: number; x2: number; y2: number } | null {
  const flex = flexAxis(target)
  const sr = target.selrect
  if (!flex || !sr) return null
  const sx = sr.x
  const sy = sr.y
  const sw = sr.width ?? 0
  const sh = sr.height ?? 0
  const pad = 4
  const kids = orderedChildRects(target, objects)

  if (flex.axis === 'x') {
    let x: number
    if (kids.length === 0) x = sx + sw / 2
    else if (index <= 0) x = kids[0].x
    else if (index >= kids.length) x = kids[kids.length - 1].x + kids[kids.length - 1].width
    else x = (kids[index - 1].x + kids[index - 1].width + kids[index].x) / 2
    return { x1: x, y1: sy + pad, x2: x, y2: sy + sh - pad }
  }
  let y: number
  if (kids.length === 0) y = sy + sh / 2
  else if (index <= 0) y = kids[0].y
  else if (index >= kids.length) y = kids[kids.length - 1].y + kids[kids.length - 1].height
  else y = (kids[index - 1].y + kids[index - 1].height + kids[index].y) / 2
  return { x1: sx + pad, y1: y, x2: sx + sw - pad, y2: y }
}

export interface DropIntent {
  targetId: string
  /** True for flex OR grid — drives the target highlight. */
  hasLayout: boolean
  /** Where a reparent into `targetId` should insert (feeds both overlay + commit). */
  index: number
  /** Red insertion line (world coords), or null (no line: grid / no layout / empty). */
  line: { x1: number; y1: number; x2: number; y2: number } | null
  /** Target container rect (world) for the highlight. */
  targetRect: { x: number; y: number; width: number; height: number }
  /**
   * Ghost footprint (world coords) — where the dragged shape will sit in the slot,
   * drawn as a contour. Provisional here (centered on the insertion line, spanning
   * the container's cross-axis); Slice 2's spacer replaces it with the engine's
   * exact reflowed rect. Null for non-flex targets.
   */
  footprint: { x: number; y: number; width: number; height: number } | null
}

/** First selected shape that has a selrect — used to size the ghost footprint. */
function primarySize(
  selectedIds: ReadonlySet<string>,
  objects: Record<string, IndexedShape>,
): { width: number; height: number } | null {
  for (const id of selectedIds) {
    const sr = objects[id]?.selrect
    if (sr) return { width: sr.width ?? 0, height: sr.height ?? 0 }
  }
  return null
}

/**
 * Provisional ghost footprint: a rect the size of the dragged shape, centered on the
 * insertion point along the main axis and centered in the container on the cross
 * axis. Overlaps a neighbour (nothing shifts yet) — the spacer step opens a real gap
 * and replaces this with the engine's exact reflowed rect.
 */
function provisionalFootprint(
  target: IndexedShape,
  line: { x1: number; y1: number; x2: number; y2: number },
  size: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const sr = target.selrect!
  const cx = sr.x + (sr.width ?? 0) / 2
  const cy = sr.y + (sr.height ?? 0) / 2
  const flex = flexAxis(target)
  if (flex?.axis === 'y') {
    // column: insertion is along y (line is horizontal); center x in the container.
    return { x: cx - size.width / 2, y: line.y1 - size.height / 2, width: size.width, height: size.height }
  }
  // row: insertion is along x (line is vertical); center y in the container.
  return { x: line.x1 - size.width / 2, y: cy - size.height / 2, width: size.width, height: size.height }
}

/**
 * Resolve the drop intent for a drag at `point` (the primary dragged shape's
 * projected center, in world coords). Returns null when the point isn't over a
 * droppable container. `selectedIds` only feeds the exclude set so a shape can't
 * target itself/its descendants.
 */
export function resolveDropIntent(
  selectedIds: ReadonlySet<string>,
  page: IndexedPage,
  point: Point,
): DropIntent | null {
  if (selectedIds.size === 0) return null
  const objects = page.objects as Record<string, IndexedShape>
  const targetId = findContainerAtPoint(objects, point, Array.from(selectedIds))
  if (!targetId) return null
  const target = objects[targetId]
  if (!target?.selrect) return null

  // The page root is findContainerAtPoint's fallback when the cursor is over empty
  // canvas — dropping there is just "top level", not a container worth highlighting.
  // (root is the node with no parent.)
  if (target.parentId == null) return null

  // Intra-parent moves don't reparent, and in-place reorder isn't wired yet, so a
  // drop over the shapes' own current parent wouldn't change anything — suppress
  // the indicator there to keep it honest (matches detectReparentTargets skipping
  // same-parent). Cross-container drops still show.
  let allSameParent = true
  for (const id of selectedIds) {
    if (objects[id]?.parentId !== targetId) {
      allSameParent = false
      break
    }
  }
  if (allSameParent) return null
  const index = computeDropIndex(target, objects, point)
  const line = flexAxis(target) ? insertionLineWorld(target, objects, index) : null
  const size = primarySize(selectedIds, objects)
  const footprint = line && size ? provisionalFootprint(target, line, size) : null
  return {
    targetId,
    hasLayout: hasAnyLayout(target),
    index,
    line,
    targetRect: {
      x: target.selrect.x,
      y: target.selrect.y,
      width: target.selrect.width ?? 0,
      height: target.selrect.height ?? 0,
    },
    footprint,
  }
}
