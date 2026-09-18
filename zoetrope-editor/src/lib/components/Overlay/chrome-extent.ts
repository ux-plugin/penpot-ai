/**
 * Selection-chrome extent: how big the selection box actually is ON SCREEN, and
 * whether that is too small to hang the normal chrome off.
 *
 * The overlay lays its box + handles out inside
 * `translate(centre) matrix(a,b,c,d,0,0)`. The translate (the anchor) is always
 * valid, but the LINEAR part can be singular — an animated `scale 0` makes
 * a = d = 0, which collapses every child of that group to a single point no
 * matter what coordinates it was given. So flooring the rect is not enough: when
 * the linear part degenerates, the chrome has to be drawn from the anchor
 * instead (see CenterGizmo). This module is the pure test for that.
 *
 * The effective on-screen size folds three things together — the box's own
 * dimensions, the transform's scale factors (`hypot` of each mapped axis, which
 * is rotation-invariant), and the viewport zoom — so a shape is "degenerate"
 * whether it was scaled to nothing by an animation, is genuinely tiny, or is
 * just zoomed far out.
 */

import { MIN_SELRECT_SIDE_SCREEN } from './constants'
import type { Matrix } from 'penpot-exporter/types'

export interface ChromeExtent {
  /** On-screen width of the selection box, in CSS px. */
  screenWidth: number
  /** On-screen height of the selection box, in CSS px. */
  screenHeight: number
  /**
   * True when the box is too small on screen (or its transform is singular) for
   * the bounds-derived chrome to be usable. Consumers fall back to the
   * anchor-based gizmo.
   */
  degenerate: boolean
}

/** Length of the transform's mapped x-axis — the effective horizontal scale. */
function axisScaleX(t: Matrix): number {
  return Math.hypot(t.a, t.b)
}

/** Length of the transform's mapped y-axis — the effective vertical scale. */
function axisScaleY(t: Matrix): number {
  return Math.hypot(t.c, t.d)
}

/**
 * Effective on-screen extent of a selection box, and whether it is degenerate.
 * Non-finite inputs are treated as degenerate (nothing sane to lay out).
 */
export function chromeExtent(
  sel: { width: number; height: number; transform: Matrix } | null | undefined,
  zoom: number,
  minScreen: number = MIN_SELRECT_SIDE_SCREEN,
): ChromeExtent {
  const degenerateResult: ChromeExtent = { screenWidth: 0, screenHeight: 0, degenerate: true }
  if (!sel) return degenerateResult
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const screenWidth = sel.width * axisScaleX(sel.transform) * safeZoom
  const screenHeight = sel.height * axisScaleY(sel.transform) * safeZoom
  if (!Number.isFinite(screenWidth) || !Number.isFinite(screenHeight)) return degenerateResult
  return {
    screenWidth,
    screenHeight,
    degenerate: screenWidth < minScreen || screenHeight < minScreen,
  }
}
