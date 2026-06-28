/**
 * The ONE function that decides the canvas surface cursor, for every mode. It used
 * to be ~10 scattered `surface.style.cursor = …` writes across mousemove / enter /
 * leave / up / keydown / keyup, which is why Alt didn't update the surface without
 * a mouse-move (the bug that kicked off B.5). Now a single reactive effect (in the
 * viewport hook) is the sole writer, calling this pure resolver — so machine state
 * and modifiers can never disagree with the overlay, which already calls the same
 * path resolver. The path case delegates to `resolvePathInteraction` (one source
 * of truth for "Alt = transient Bend").
 */

import type { CanvasActorRef } from '../machine/canvas-actor-types'
import type { SelectionRectResult } from '../types'
import { getResizeCursor, matrixHasHalfFlip, matrixToRotationDeg } from '../../components/Overlay/constants'
import { PEN_CURSOR, SELECT_CURSOR } from '../../components/cursors'
import { resolvePathInteraction } from '../../components/Overlay/path-interaction'

type Snapshot = ReturnType<CanvasActorRef['getSnapshot']>

export interface CursorMods {
  /** Alt held — transient Bend override while editing a path. */
  alt: boolean
  /** The configured pan modifier is held (Space/Shift/…): arrow → grab. */
  panHeld: boolean
}

/** Cursor for the active draw tool: pen → nib, select → arrow, else crosshair. */
export function toolCursor(drawTool: string | null): string {
  if (drawTool === 'pen') return PEN_CURSOR
  if (drawTool != null) return 'crosshair'
  return SELECT_CURSOR
}

/** Resolve the surface cursor from machine + modifier state. `wasmRect` is only
 *  read for the resize cursor's rotation/flip. Hover over individual nodes/handles
 *  is owned by the overlay's own elements, so the surface uses hover:'empty'. */
export function resolveCanvasCursor(
  snap: Snapshot,
  mods: CursorMods,
  wasmRect: SelectionRectResult | null,
): string {
  if (snap.matches('resizing') && snap.context.resizeHandle) {
    const rotation = wasmRect != null ? matrixToRotationDeg(wasmRect.transform) : undefined
    const halfFlip = wasmRect != null ? matrixHasHalfFlip(wasmRect.transform) : false
    return getResizeCursor(snap.context.resizeHandle, rotation, halfFlip)
  }
  if (snap.matches('pathEditing')) {
    return resolvePathInteraction({
      subTool: snap.context.pathSubTool,
      panHeld: mods.panHeld,
      altHeld: mods.alt,
      hover: 'empty',
    }).cursor
  }
  if (snap.context.drawTool != null) return toolCursor(snap.context.drawTool)
  if (snap.matches('textEditing')) return 'text'
  return mods.panHeld ? 'grab' : SELECT_CURSOR
}
