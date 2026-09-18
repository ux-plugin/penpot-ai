/**
 * scene3d-viewframe — what a 3D scene's box shows, and what resizing it does.
 *
 * The scene stores ONE thing: the `Scene3DViewWindow` currently on screen, in units of the
 * camera's reference frustum. Rendering reads it and nothing else — there is no per-mode
 * derivation, so the two resize modes always display exactly the same picture and switching
 * between them is a no-op by construction.
 *
 * The mode governs what a RESIZE does to that window:
 *
 *   Scale  the window is untouched and simply re-fitted to the new box, so the whole scene
 *          stays in view and changes size with the box. Nothing enters or leaves.
 *   Crop   the window grows and shrinks WITH the box, so the world keeps a fixed size on
 *          screen and the moving edge reveals or hides more of it.
 *
 * That split is the whole design. An earlier version stored a fixed reference "frame" and
 * let each mode derive its own window from it, which meant the modes genuinely showed
 * different regions once the box and frame had parted company — a jump on every flip that
 * no amount of tuning could remove. Storing the view instead of the reference designs it out.
 *
 * Everything here is pure and engine-free — no three, no document access.
 */

import type { Scene3DDocument, Scene3DViewWindow } from './scene3d-store'

/** A box rectangle in document units. */
export interface BoxRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * A render plan: what to hand the camera, and where inside the box it lands.
 *
 * `fullW/fullH/offX/offY/subW/subH` map 1:1 onto `camera.setViewOffset`, with the camera's
 * aspect set to `fullW / fullH`. The reference frustum is the unit square, so a window is
 * read directly as the sub-rect.
 *
 * `fx/fy/fw/fh` place the render inside the box as fractions of it, `fy` measured from the
 * TOP (document convention — GL callers flip it). They cover the whole box whenever the
 * window's proportions match it; otherwise the remainder is empty.
 */
export interface CropPlan {
  fullW: number
  fullH: number
  offX: number
  offY: number
  subW: number
  subH: number
  fx: number
  fy: number
  fw: number
  fh: number
}

/** The canonical framing: the reference frustum, shaped to the box so it fills it exactly. */
export function defaultWindow(boxW: number, boxH: number): Scene3DViewWindow {
  if (!(boxW > 0) || !(boxH > 0)) return { x: 0, y: 0, w: 1, h: 1 }
  const w = boxW / boxH // height is the reference; width follows the box's proportions
  return { x: (1 - w) / 2, y: 0, w, h: 1 }
}

/**
 * How to draw `win` inside a box — the ONE render rule, shared by both modes.
 *
 * The window is drawn at the largest size that fits, centred, preserving its proportions.
 * A crop-resized window always matches the box's proportions, so this fills the box; a
 * scale-resized one keeps whatever proportions it had, so changing the box's shape leaves
 * the remainder empty. Filling it would mean revealing world the window doesn't cover
 * (that's crop) or squashing the render.
 */
export function viewPlan(
  win: Scene3DViewWindow,
  boxW: number,
  boxH: number,
): CropPlan | null {
  if (!(win.w > 0) || !(win.h > 0) || !(boxW > 0) || !(boxH > 0)) return null
  const scale = Math.min(boxW / win.w, boxH / win.h) // document units per reference unit
  const drawnW = win.w * scale
  const drawnH = win.h * scale
  return {
    fullW: 1,
    fullH: 1,
    offX: win.x,
    offY: win.y,
    subW: win.w,
    subH: win.h,
    fx: (boxW - drawnW) / 2 / boxW,
    fy: (boxH - drawnH) / 2 / boxH,
    fw: drawnW / boxW,
    fh: drawnH / boxH,
  }
}

/**
 * The window after a CROP resize. In crop the box IS the window, so this is just the new box
 * expressed in window units — at the scale the view is CURRENTLY drawn at, which is what
 * keeps the world the same size on screen and makes the moving edge reveal or hide.
 *
 * The subtlety is where the box's edges sit. When the window fills the box they coincide,
 * but a Scale resize can leave the window letterboxed, and then the box is LARGER than the
 * window and centred on it. Anchoring the new window at the old window's corner in that
 * state is wrong by half a band: the bands fill from one side only and the content visibly
 * jumps. So measure the box itself, then move its edges.
 */
export function windowAfterCropResize(
  win: Scene3DViewWindow,
  before: BoxRect,
  after: BoxRect,
): Scene3DViewWindow {
  const scale = Math.min(before.w / win.w, before.h / win.h) // document units per window unit
  if (!(scale > 0) || !Number.isFinite(scale)) return win
  // The box's own top-left in window units. Identical to the window's when it fills the box;
  // outside it, symmetrically, when it doesn't.
  const boxX = win.x + win.w / 2 - before.w / (2 * scale)
  const boxY = win.y + win.h / 2 - before.h / (2 * scale)
  return {
    // Each edge of the box moves the matching edge of the window by the same world amount,
    // so the un-dragged edge holds still.
    x: boxX + (after.x - before.x) / scale,
    y: boxY + (after.y - before.y) / scale,
    w: after.w / scale,
    h: after.h / scale,
  }
}

/**
 * Reshape the window to the box's proportions, keeping its centre — "Fit view to box".
 * Only ever REVEALS: the short axis is widened to meet the box rather than the long one
 * being trimmed, so nothing on screen is lost, the empty bands just fill with scene.
 */
export function windowFittedToBox(
  win: Scene3DViewWindow,
  boxW: number,
  boxH: number,
): Scene3DViewWindow {
  if (!(win.w > 0) || !(win.h > 0) || !(boxW > 0) || !(boxH > 0)) return win
  const boxAspect = boxW / boxH
  const cx = win.x + win.w / 2
  const cy = win.y + win.h / 2
  const w = Math.max(win.w, win.h * boxAspect)
  const h = Math.max(win.h, win.w / boxAspect)
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

/**
 * Narrow a plan to the part of the box that is actually on screen — the ONE mechanism
 * behind viewport-clipped baking.
 *
 * A placed scene is baked into a texture, and a texture is raster: zoom past the render
 * target's resolution and Skia magnifies texels. Rendering only the visible slice, at that
 * slice's own device pixels, keeps the bake 1:1 however far you zoom — the target then
 * bounds the SCREEN rather than the node, so it stops being a resolution ceiling.
 *
 * The slice is a sub-rect of the box; the answer is a sub-rect of the window. That is the
 * whole trick, and it is why a clip composes with a resize for free: both are windows onto
 * the same reference frustum, so the camera never learns which one it is looking through.
 * An earlier version framed the clip on the NODE's aspect instead — a different reference
 * frame from the one the window lives in — and every scene whose window wasn't the default
 * rendered stretched, which is why the feature sat behind a flag.
 *
 * The camera does NOT move. A dolly would change parallax and foreshortening, so the scene
 * would look different at different zooms; cropping the frustum yields the identical image
 * with more pixels in it.
 *
 * `slice` is in box-local coords. Returns null when it misses what's drawn entirely, and
 * otherwise the plan to render plus the box-local rect to place it at — the intersection,
 * NOT the slice, since a letterboxed window doesn't reach the box's edges.
 */
export function narrowPlanToSlice(
  plan: CropPlan,
  boxW: number,
  boxH: number,
  slice: BoxRect,
): { plan: CropPlan; dest: BoxRect } | null {
  if (!(boxW > 0) || !(boxH > 0) || !(plan.fw > 0) || !(plan.fh > 0)) return null
  // Where the window actually lands in the box: the box itself when the proportions agree,
  // inset by the letterbox bands when they don't — which is why the slice is clamped to
  // THIS rect rather than to the box.
  const dx = plan.fx * boxW
  const dy = plan.fy * boxH
  const dw = plan.fw * boxW
  const dh = plan.fh * boxH
  const l = Math.max(dx, slice.x)
  const t = Math.max(dy, slice.y)
  const r = Math.min(dx + dw, slice.x + slice.w)
  const b = Math.min(dy + dh, slice.y + slice.h)
  if (!(r > l) || !(b > t)) return null
  return {
    plan: {
      fullW: plan.fullW,
      fullH: plan.fullH,
      offX: plan.offX + ((l - dx) / dw) * plan.subW,
      offY: plan.offY + ((t - dy) / dh) * plan.subH,
      subW: ((r - l) / dw) * plan.subW,
      subH: ((b - t) / dh) * plan.subH,
      // The sub-window is a proportional sub-rect of what was drawn, so it matches the
      // dest's proportions exactly: no letterbox, the render fills its whole target.
      fx: 0,
      fy: 0,
      fw: 1,
      fh: 1,
    },
    dest: { x: l, y: t, w: r - l, h: b - t },
  }
}

/**
 * Snap a slice OUTWARD to a grid and clamp it to the box — what keeps panning affordable
 * once a node has outgrown the viewport.
 *
 * Only that case needs it. While the whole node still fits on screen the bake covers all of
 * it and panning is already free: the render is cached and merely re-composited, because
 * nothing in its content key moves with the viewport. It is at extreme zoom, where the node
 * is larger than the screen, that a pan starts revealing scene the last render didn't cover.
 *
 * There, rendering a quantised SUPERSET means a pan within a cell still needs no new render:
 * the last one already reaches where the view moved to. At 60fps a fast drag crosses a 512px
 * cell every ten frames or so, an order of magnitude fewer renders for one rect comparison.
 *
 * It is never a freshness tradeoff — the region always contains the view or it is replaced.
 * The only price is slack: up to one cell per EDGE, so two per axis on the render target.
 *
 * `cell` is in the same units as the box. Callers convert from device pixels, so the grid is
 * anchored in screen space and a cell always costs the same amount of render work.
 */
export function quantiseSlice(slice: BoxRect, boxW: number, boxH: number, cell: number): BoxRect {
  if (!(cell > 0) || !Number.isFinite(cell)) return slice
  const l = Math.max(0, Math.floor(slice.x / cell) * cell)
  const t = Math.max(0, Math.floor(slice.y / cell) * cell)
  const r = Math.min(boxW, Math.ceil((slice.x + slice.w) / cell) * cell)
  const b = Math.min(boxH, Math.ceil((slice.y + slice.h) / cell) * cell)
  return { x: l, y: t, w: Math.max(0, r - l), h: Math.max(0, b - t) }
}

/** Whether `inner` is fully covered by `outer` — the test that decides if a pan can reuse
 *  the region already rendered instead of asking for a new one. */
export function rectCovers(outer: BoxRect | null | undefined, inner: BoxRect): boolean {
  if (!outer) return false
  const eps = 0.01
  return (
    inner.x >= outer.x - eps &&
    inner.y >= outer.y - eps &&
    inner.x + inner.w <= outer.x + outer.w + eps &&
    inner.y + inner.h <= outer.y + outer.h + eps
  )
}

/** Whether this scene crops rather than scales on resize. */
export function isCropMode(doc: Scene3DDocument | undefined | null): boolean {
  return doc?.resizeMode === 'crop'
}

/** Whether two boxes disagree on SIZE — i.e. a resize, not a move. */
export function boxSizeDiffers(a: { w: number; h: number }, b: { w: number; h: number }): boolean {
  return Math.abs(a.w - b.w) > 0.01 || Math.abs(a.h - b.h) > 0.01
}

/**
 * The scene's window as it stands, materialising the canonical one from the COMMITTED box
 * when the scene has none yet — never from the live box, so a first resize is measured from
 * where it started rather than from wherever the drag had already reached.
 */
export function sceneWindow(
  doc: Scene3DDocument | undefined | null,
  committed: BoxRect,
): Scene3DViewWindow {
  const stored = doc?.viewWindow
  return stored && stored.w > 0 && stored.h > 0 ? stored : defaultWindow(committed.w, committed.h)
}

/**
 * What to draw for a scene right now — the single call both renderers make.
 *
 * `committed` is the box as the DOCUMENT has it; `live` is the box as it's being drawn,
 * which a resize gesture previews ahead of the document. Mid-drag the two differ, and a
 * CROP has to apply its window update per frame to keep the world still while the box moves
 * under it; the matching write to the document happens once, when the resize commits (see
 * scene3d-crop-resize). A SCALE drag needs nothing — its window doesn't move.
 */
export function sceneViewPlan(
  doc: Scene3DDocument | undefined | null,
  live: BoxRect,
  committed?: BoxRect | null,
): CropPlan | null {
  const base = committed ?? live
  if (!(base.w > 0) || !(base.h > 0)) return null
  const win = sceneWindow(doc, base)
  const resizing = !!committed && isCropMode(doc) && boxSizeDiffers(committed, live)
  return viewPlan(resizing ? windowAfterCropResize(win, committed, live) : win, live.w, live.h)
}
