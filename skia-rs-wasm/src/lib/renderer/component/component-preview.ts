/**
 * A component's thumbnail, derived from its main instance.
 *
 * Deliberately NOT rendered by the real renderer. Shader thumbnails need it —
 * a shader is only itself when a GPU runs it — but a component is just shapes,
 * and flattening its subtree to a handful of rects reads perfectly at 32px while
 * costing nothing: no GL context, no surface contention with the focus stage, no
 * animation loop, and it works in any environment the panel does.
 *
 * Coordinates come out relative to the main's own box, so the caller only has to
 * set a viewBox.
 */
import { subtreeWithRoot } from '../../common/subtree'
import type { IndexedShape } from '../../worker/types'

/** One flattened box in the preview, in main-local coordinates. */
export interface PreviewItem {
  x: number
  y: number
  width: number
  height: number
  /** Corner radius, clamped so it can't swallow the box at thumbnail scale. */
  rx: number
  fill?: string
  stroke?: string
  /** Text renders as a bar — glyphs are illegible at this size anyway. */
  isText: boolean
}

export interface ComponentPreview {
  width: number
  height: number
  items: PreviewItem[]
}

/** Deep trees add nothing at 32px; stop before the walk becomes the expensive part. */
const MAX_ITEMS = 60

interface FillLike {
  fillColor?: string
  fillOpacity?: number
  n?: string
}

function firstColor(fills: unknown): string | undefined {
  if (!Array.isArray(fills)) return undefined
  for (const fill of fills as FillLike[]) {
    const color = fill?.fillColor ?? fill?.n
    if (color) return color
  }
  return undefined
}

/**
 * Flatten the main's subtree into positioned boxes.
 *
 * Returns null when the main is missing or has no measurable box — the caller
 * shows a generic icon rather than an empty frame.
 */
export function buildComponentPreview(
  objects: Record<string, IndexedShape> | undefined,
  mainId: string,
): ComponentPreview | null {
  const main = objects?.[mainId]
  const box = main?.selrect
  if (!objects || !main || !box || !(box.width > 0) || !(box.height > 0)) return null

  const items: PreviewItem[] = []
  for (const id of subtreeWithRoot(objects, mainId)) {
    if (items.length >= MAX_ITEMS) break
    const node = objects[id] as (IndexedShape & { hidden?: boolean }) | undefined
    const sr = node?.selrect
    if (!node || !sr || node.hidden) continue
    const width = sr.width ?? 0
    const height = sr.height ?? 0
    if (width <= 0 || height <= 0) continue

    const isText = node.type === 'text'
    const fill = firstColor((node as { fills?: unknown }).fills)
    const stroke = firstColor((node as { strokes?: unknown }).strokes)
    // A box with neither fill nor stroke contributes nothing visible.
    if (!fill && !stroke) continue

    const radius = (node as { r1?: number }).r1 ?? 0
    items.push({
      x: sr.x - box.x,
      y: sr.y - box.y,
      width,
      height,
      rx: Math.min(radius, width / 2, height / 2),
      fill,
      stroke,
      isText,
    })
  }

  return { width: box.width, height: box.height, items }
}
