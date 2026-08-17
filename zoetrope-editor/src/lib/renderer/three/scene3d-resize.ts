/**
 * scene3d-resize — resize a 3D-scene container box *while editing* it.
 *
 * The scene's placeholder rect is normally resized via the 2D selection handles (in
 * `idle`), but those are unreachable while the edit surface owns the pointer. So edit
 * mode draws its own handles; dragging one previews live through `scene3dResizePreview`
 * (which the overlay reads to reframe the 3D content) and commits the final bounds as
 * one undoable `mod-obj` on release. The rect stays the document source of truth.
 */

import { signal } from '@preact/signals-core'
import type { PenpotNode } from 'penpot-exporter/types'
import { getActiveOrSinglePageId } from '../store/doc-proxy'
import {
  commitNodePartialUpdate,
  getCommittedNodeOnActivePage,
  rectLayoutPartial,
} from '../properties/commit-node-properties'

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

/** Live bounds of the scene being resized (world space), or null when not resizing.
 *  The overlay's `sceneRectWorld` reads this so the 3D reframes during the drag. */
export const scene3dResizePreview = signal<{ sceneId: string; bounds: Bounds } | null>(null)

/** Smallest box a resize can produce (world units). */
export const RESIZE_MIN = 12

/**
 * Apply a world-space drag delta to `start` bounds for the given handle, anchoring the
 * opposite edge/corner and clamping to a minimum size (a `w`/`n` handle pins the far
 * edge so the box can't invert). Pure — the whole resize geometry lives here.
 */
export function applyResize(handle: ResizeHandle, start: Bounds, dx: number, dy: number): Bounds {
  let { x, y, w, h } = start
  if (handle.includes('e')) w = start.w + dx
  if (handle.includes('s')) h = start.h + dy
  if (handle.includes('w')) {
    x = start.x + dx
    w = start.w - dx
  }
  if (handle.includes('n')) {
    y = start.y + dy
    h = start.h - dy
  }
  if (w < RESIZE_MIN) {
    if (handle.includes('w')) x = start.x + start.w - RESIZE_MIN
    w = RESIZE_MIN
  }
  if (h < RESIZE_MIN) {
    if (handle.includes('n')) y = start.y + start.h - RESIZE_MIN
    h = RESIZE_MIN
  }
  return { x, y, w, h }
}

/** Commit a scene container's new bounds (selrect + points + w/h) as one undoable
 *  `mod-obj`, preserving its rotation. No-op without a committed node / page. */
export async function commitSceneBounds(sceneId: string, b: Bounds): Promise<void> {
  const before = getCommittedNodeOnActivePage(sceneId)
  const pid = getActiveOrSinglePageId()
  if (!before || !pid) return
  const rot = (before as { rotation?: number }).rotation ?? 0
  await commitNodePartialUpdate(
    sceneId,
    before as PenpotNode,
    rectLayoutPartial(b.x, b.y, b.w, b.h, rot),
    pid,
  )
}
