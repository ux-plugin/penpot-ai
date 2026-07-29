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
