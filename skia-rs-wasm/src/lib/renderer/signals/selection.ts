/**
 * Overlay rects at pointer rate; React reads via `useSignalCoalesced`.
 * `querySelectionRect` is the stateless WASM query used after selection/renderer changes and commits.
 */

import { signal } from '@preact/signals-core'
import type { Fill, Gradient, Selrect } from 'penpot-exporter/types'
import type { Anchor } from '../geom/anchors'
import type { Renderer } from '../renderer'
import type { SelectionRectResult } from '../types'

export const wasmSelectionRect = signal<SelectionRectResult | null>(null)

/** Gradient from the active color editor (fill or stroke). Written by RightSidePanel, read by SelectionOverlay. */
export const activeEditorGradient = signal<Gradient | null>(null)

/** Callback to push gradient changes from the overlay back to the editor. */
export const activeEditorOnChange = signal<((fill: Fill) => void) | null>(null)

export interface ActiveEditorTarget {
  kind: 'fill' | 'stroke'
  index: number
}

/** Fill or stroke target being edited in the active color editor. Written by RightSidePanel. */
export const activeEditorTarget = signal<ActiveEditorTarget | null>(null)
export const selectionRect = signal<Selrect | null>(null)
export const shapeDrawPreview = signal<Selrect | null>(null)

/** A pen anchor as seen by the overlay: a point plus optional bézier handles
 * (absolute world coords), mirroring the editable `Anchor` model. */
export interface PenAnchorView {
  point: { x: number; y: number }
  handleIn?: { x: number; y: number }
  handleOut?: { x: number; y: number }
}

/**
 * Live preview for the pen tool, in WORLD coordinates. `anchors` are the placed
 * points (with handles); `pending` is the anchor under the mouse button, whose
 * handles are being dragged out (null between clicks); `cursor` is the in-flight
 * free point trailing the mouse (null when off-canvas or while dragging a
 * handle); `willClose` is true when the cursor hovers the first anchor (so the
 * overlay can highlight the close target). Drives a bézier path + handle lines
 * rather than a rubber-band rect.
 */
export interface PenDrawPreview {
  anchors: PenAnchorView[]
  pending: PenAnchorView | null
  cursor: { x: number; y: number } | null
  willClose: boolean
}
export const penDrawPreview = signal<PenDrawPreview | null>(null)

/**
 * Live working anchors during a vector-edit drag (world coords), or null when no
 * drag is in flight (the PathEditorOverlay then reads the committed segments).
 * Written at pointer rate by the overlay's drag handler so the markers track the
 * cursor without a history commit per frame.
 */
export const pathEditAnchors = signal<Anchor[] | null>(null)

/** Synced from React: showHandles && showCornerHandles. Drives imperative corner-square `effect()`. */
export const selectionCornerHandlesVisible = signal(false)

/** Synced from React: false when isMoving is true. Drives imperative selection-rect outline `effect()`. */
export const selectionRectOutlineVisible = signal(true)

function isFiniteSelectionRect(value: SelectionRectResult | null): value is SelectionRectResult {
  if (!value) return false
  return (
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    Number.isFinite(value.center.x) &&
    Number.isFinite(value.center.y) &&
    Number.isFinite(value.transform.a) &&
    Number.isFinite(value.transform.b) &&
    Number.isFinite(value.transform.c) &&
    Number.isFinite(value.transform.d) &&
    Number.isFinite(value.transform.e) &&
    Number.isFinite(value.transform.f)
  )
}

export function querySelectionRect(renderer: Renderer, ids: Iterable<string>): SelectionRectResult | null {
  const result = renderer.getSelectionRect(Array.from(ids))
  return isFiniteSelectionRect(result) ? result : null
}
