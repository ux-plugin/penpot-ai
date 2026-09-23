/**
 * Which slot the cursor is over, for the empty-slot hover affordance.
 *
 * An empty slot paints nothing — it reserves its space and stays out of the
 * design's way — so without this it would be invisible on canvas and reachable
 * only from the Layers panel. Hovering reveals it.
 *
 * This is deliberately *editor chrome*: resolved here, drawn by the overlay, and
 * never written to the document, so it can't leak into the preview or the
 * generated code.
 *
 * Purely geometric — the cursor against slot boxes — so it needs no worker
 * round-trip and stays in step with the pointer.
 */
import { findSlotAtPoint } from '../../components/LayersPanel/reparent'
import { getNode } from '../../doc'
import type { Point } from 'penpot-exporter/types'

export interface HoveredSlot {
  id: string
  name: string
  rect: { x: number; y: number; width: number; height: number }
}

/**
 * The slot under `point`, or null.
 *
 * Returns null while a drag is in flight: the drop-intent overlay already draws
 * feedback for the slot being targeted, and two sets of chrome on one box reads
 * as a bug.
 *
 * Every node still typed `'slot'` is by definition empty — filling one swaps it
 * in place for the content — so there is no separate emptiness test.
 */
export function resolveHoveredSlot(
  pageId: string | null | undefined,
  point: Point | null | undefined,
  isDragging: boolean,
): HoveredSlot | null {
  if (!pageId || !point || isDragging) return null
  const id = findSlotAtPoint(pageId, point, [])
  if (!id) return null
  const node = getNode(id)
  const sr = node?.selrect
  if (!sr) return null
  return {
    id,
    name: node.name ?? 'Slot',
    rect: { x: sr.x, y: sr.y, width: sr.width ?? 0, height: sr.height ?? 0 },
  }
}
