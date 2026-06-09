/**
 * Pure pixel-grid snapping helpers for interactive gestures.
 *
 * Kept dependency-light (only viewport math + selrect construction) so they can
 * be unit-tested without booting the renderer. Mirrors the Penpot frontend's
 * `:snap-pixel-grid` behaviour:
 * - move snaps the selection's top-left to the whole-pixel grid (transforms.cljs)
 * - draw snaps both world endpoints, `round-step 1` (drawing/box.cljs)
 */

import { screenToWorld, worldToScreen } from '../viewport'
import type { ViewportData } from '../viewport'
import { makeSelrect } from '@skia-rs-wasm/common/conversions'

export type DrawRect = { x: number; y: number; width: number; height: number }

/**
 * Snap a world-space move delta so the selection's top-left lands on the
 * whole-pixel grid (the move steps pixel-by-pixel).
 *
 * A shift-constrained drag leaves the locked axis untouched (mirrors the
 * frontend's `snap-ignore-axis`): the locked axis arrives as exactly `0` from
 * `constrainDeltaByShift`, so we preserve it instead of snapping it to the grid.
 *
 * @param baseTopLeft Pre-drag selection top-left in world units, or `null` to
 *   disable snapping (returns the delta unchanged).
 */
export function snapMoveDeltaToGrid(
  delta: { x: number; y: number },
  baseTopLeft: { x: number; y: number } | null,
  shift: boolean
): { x: number; y: number } {
  if (!baseTopLeft) return delta
  return {
    x: shift && delta.x === 0 ? 0 : Math.round(baseTopLeft.x + delta.x) - baseTopLeft.x,
    y: shift && delta.y === 0 ? 0 : Math.round(baseTopLeft.y + delta.y) - baseTopLeft.y,
  }
}

/**
 * Snap a screen-space rubber-band rect to the integer world (pixel) grid.
 *
 * Rounds both world endpoints — equivalent to rounding the drag's start and
 * current points (Penpot box.cljs `round-step 1`), since `round` is monotonic so
 * `min`/`max` commute with it. The size is the difference of the snapped edges
 * (not origin + size rounded independently), which avoids direction-dependent
 * off-by-one. Returns the snapped rect in screen space (for the live preview, so
 * it steps pixel-by-pixel) and the snapped world geometry (for the commit, so the
 * created shape matches the preview exactly).
 */
export function snapDrawRectToGrid(
  rect: DrawRect,
  vp: ViewportData
): { screenRect: ReturnType<typeof makeSelrect>; world: DrawRect } {
  const tl = screenToWorld(vp, rect.x, rect.y)
  const br = screenToWorld(vp, rect.x + rect.width, rect.y + rect.height)
  const x1 = Math.round(tl.x)
  const y1 = Math.round(tl.y)
  const x2 = Math.round(br.x)
  const y2 = Math.round(br.y)
  const sTl = worldToScreen(vp, x1, y1)
  const sBr = worldToScreen(vp, x2, y2)
  return {
    screenRect: makeSelrect(sTl.x, sTl.y, sBr.x - sTl.x, sBr.y - sTl.y),
    world: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
  }
}
