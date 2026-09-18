/**
 * Convert a primitive shape (rect, ellipse/circle) into an editable `path` node,
 * so double-clicking it drops into vector-edit the same way a star does. The
 * baked geometry is pixel-identical to how the primitive rendered (sharp corners
 * → 4 anchors; rounded corners and ellipses → cubic arcs), and the change is a
 * normal undoable property update, so Undo restores the primitive.
 *
 * Only the `type` and `content` flip; x/y/size/selrect/fills/strokes are already
 * correct and carried through untouched.
 */

import type { PenpotNode } from 'penpot-exporter/types'
import type { Anchor } from '../geom/anchors'
import { compoundContent, type Subpath } from '../geom/subpaths'

/** Circular-arc control-point pull for a 90° cubic segment. */
const KAPPA = 0.5522847498307936

type Rectish = {
  x?: number
  y?: number
  width?: number
  height?: number
  r1?: number
  r2?: number
  r3?: number
  r4?: number
  selrect?: { x: number; y: number; width: number; height: number }
}

/** True for primitives we can turn into an editable path. */
export function isConvertibleToPath(node: { type?: string } | null | undefined): boolean {
  const t = node?.type
  return t === 'rect' || t === 'circle' || t === 'ellipse'
}

/**
 * The `{ type:'path', content }` partial that turns `node` into an editable path,
 * or null if it isn't a convertible primitive. `content` carries `segments` (for
 * render-wasm) plus `vertices`/`subpaths` (for the path editor's node derivation).
 */
export function primitiveToPathPartial(
  node: PenpotNode | null | undefined,
): Partial<PenpotNode> | null {
  if (!node || !isConvertibleToPath(node)) return null
  const subpath =
    node.type === 'rect' ? rectSubpath(node as Rectish) : ellipseSubpath(node as Rectish)
  if (!subpath || subpath.vertices.length < 2) return null
  const prev = (node as { content?: Record<string, unknown> }).content ?? {}
  return {
    type: 'path',
    content: {
      ...prev,
      network: undefined,
      ...compoundContent([subpath]),
    } as PenpotNode['content'],
  } as Partial<PenpotNode>
}

/** Bounds of a primitive, preferring the selrect (already the tight bbox). */
function bounds(node: Rectish): { x: number; y: number; w: number; h: number } {
  const sr = node.selrect
  if (sr) return { x: sr.x, y: sr.y, w: sr.width, h: sr.height }
  return { x: node.x ?? 0, y: node.y ?? 0, w: node.width ?? 0, h: node.height ?? 0 }
}

/**
 * Rectangle → closed sub-path. Sharp when every corner radius is ~0 (four
 * anchors); otherwise each rounded corner becomes a cubic quarter-arc between its
 * two edge-tangent points (`r1..r4` = TL, TR, BR, BL, clamped to half the box).
 */
function rectSubpath(node: Rectish): Subpath {
  const { x, y, w, h } = bounds(node)
  const cap = Math.min(w, h) / 2
  const clamp = (r: number | undefined) => Math.max(0, Math.min(r ?? 0, cap))
  const tl = clamp(node.r1)
  const tr = clamp(node.r2)
  const br = clamp(node.r3)
  const bl = clamp(node.r4)

  if (tl < 0.01 && tr < 0.01 && br < 0.01 && bl < 0.01) {
    return {
      closed: true,
      vertices: [
        { point: { x, y } },
        { point: { x: x + w, y } },
        { point: { x: x + w, y: y + h } },
        { point: { x, y: y + h } },
      ],
    }
  }

  const vertices: Anchor[] = []
  // corner K, entry point P (arriving along the edge), exit point Q (leaving).
  const arc = (P: { x: number; y: number }, K: { x: number; y: number }, Q: { x: number; y: number }) => {
    const entry = vertices[vertices.length - 1]
    if (entry) entry.handleOut = { x: P.x + (K.x - P.x) * KAPPA, y: P.y + (K.y - P.y) * KAPPA }
    else vertices.push({ point: P })
    vertices.push({
      point: Q,
      handleIn: { x: Q.x + (K.x - Q.x) * KAPPA, y: Q.y + (K.y - Q.y) * KAPPA },
    })
  }

  // Start on the top edge just after the TL corner, walk clockwise.
  vertices.push({ point: { x: x + tl, y } })
  // Top edge → TR arc
  vertices.push({ point: { x: x + w - tr, y } })
  if (tr > 0.01) arc({ x: x + w - tr, y }, { x: x + w, y }, { x: x + w, y: y + tr })
  else vertices.push({ point: { x: x + w, y } })
  // Right edge → BR arc
  vertices.push({ point: { x: x + w, y: y + h - br } })
  if (br > 0.01) arc({ x: x + w, y: y + h - br }, { x: x + w, y: y + h }, { x: x + w - br, y: y + h })
  else vertices.push({ point: { x: x + w, y: y + h } })
  // Bottom edge → BL arc
  vertices.push({ point: { x: x + bl, y: y + h } })
  if (bl > 0.01) arc({ x: x + bl, y: y + h }, { x, y: y + h }, { x, y: y + h - bl })
  else vertices.push({ point: { x, y: y + h } })
  // Left edge → TL arc (closes back to the first anchor)
  vertices.push({ point: { x, y: y + tl } })
  if (tl > 0.01) {
    const first = vertices[0]
    const P = { x, y: y + tl }
    const K = { x, y }
    vertices[vertices.length - 1].handleOut = { x: P.x + (K.x - P.x) * KAPPA, y: P.y + (K.y - P.y) * KAPPA }
    first.handleIn = { x: first.point.x + (K.x - first.point.x) * KAPPA, y: first.point.y + (K.y - first.point.y) * KAPPA }
  }
  return { closed: true, vertices: dedupeAnchors(vertices) }
}

/** Ellipse/circle → four cubic quarter-arcs (the standard kappa approximation). */
function ellipseSubpath(node: Rectish): Subpath {
  const { x, y, w, h } = bounds(node)
  const cx = x + w / 2
  const cy = y + h / 2
  const rx = w / 2
  const ry = h / 2
  const ox = rx * KAPPA
  const oy = ry * KAPPA
  const top = { x: cx, y: cy - ry }
  const right = { x: cx + rx, y: cy }
  const bottom = { x: cx, y: cy + ry }
  const left = { x: cx - rx, y: cy }
  return {
    closed: true,
    vertices: [
      { point: top, handleIn: { x: cx - ox, y: cy - ry }, handleOut: { x: cx + ox, y: cy - ry } },
      { point: right, handleIn: { x: cx + rx, y: cy - oy }, handleOut: { x: cx + rx, y: cy + oy } },
      { point: bottom, handleIn: { x: cx + ox, y: cy + ry }, handleOut: { x: cx - ox, y: cy + ry } },
      { point: left, handleIn: { x: cx - rx, y: cy + oy }, handleOut: { x: cx - rx, y: cy - oy } },
    ],
  }
}

/** Drop anchors that coincide with their predecessor (radius-0 corners collapse
 *  two edge points onto one), keeping any handles that were attached. */
function dedupeAnchors(vertices: Anchor[]): Anchor[] {
  const out: Anchor[] = []
  for (const v of vertices) {
    const last = out[out.length - 1]
    if (last && Math.hypot(last.point.x - v.point.x, last.point.y - v.point.y) < 1e-3) {
      if (v.handleOut) last.handleOut = v.handleOut
      continue
    }
    out.push(v)
  }
  if (out.length > 1) {
    const first = out[0]
    const last = out[out.length - 1]
    if (Math.hypot(first.point.x - last.point.x, first.point.y - last.point.y) < 1e-3) {
      if (last.handleIn) first.handleIn = last.handleIn
      out.pop()
    }
  }
  return out
}
