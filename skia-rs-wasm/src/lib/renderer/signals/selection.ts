/**
 * Overlay rects at pointer rate; React reads via `useSignalCoalesced`.
 * `querySelectionRect` is the stateless WASM query used after selection/renderer changes and commits.
 */

import { effect, signal } from '@preact/signals-core'
import type { Fill, Gradient, Selrect } from 'penpot-exporter/types'
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

/** Which eraser sub-mode the Erase tool is in: a swept `brush` band, or a
 *  free-form `lasso` whose enclosed area is cropped. Written by PenEditFlyout,
 *  read by the PathEditorOverlay to pick the handler + preview. Persisted so the
 *  eraser reopens in the last-used mode. */
const ERASE_MODE_KEY = 'zoetrope.eraseMode'
const readEraseMode = (): 'brush' | 'lasso' => {
  try {
    const v = localStorage.getItem(ERASE_MODE_KEY)
    return v === 'lasso' || v === 'brush' ? v : 'brush'
  } catch {
    return 'brush'
  }
}
export const eraseMode = signal<'brush' | 'lasso'>(readEraseMode())
effect(() => {
  const v = eraseMode.value
  try {
    localStorage.setItem(ERASE_MODE_KEY, v)
  } catch {
    /* storage unavailable — mode just won't persist */
  }
})

/** Free-form (brush) eraser width, as the band's half-width in SCREEN px (so the
 *  felt size is zoom-independent). Persisted; edited from the path-edit flyout. */
const ERASE_WIDTH_KEY = 'zoetrope.eraseBrushRadius'
export const ERASE_BRUSH_MIN = 4
export const ERASE_BRUSH_MAX = 80
const readEraseBrushRadius = (): number => {
  try {
    const n = Number(localStorage.getItem(ERASE_WIDTH_KEY))
    if (Number.isFinite(n) && n > 0) return Math.min(ERASE_BRUSH_MAX, Math.max(ERASE_BRUSH_MIN, n))
  } catch {
    /* ignore */
  }
  return 22
}
export const eraseBrushRadius = signal<number>(readEraseBrushRadius())
effect(() => {
  const v = eraseBrushRadius.value
  try {
    localStorage.setItem(ERASE_WIDTH_KEY, String(v))
  } catch {
    /* storage unavailable */
  }
})

/** Free-form (brush) end/edge style: `round` sweeps a capsule, `square` a
 *  rectangle (flat, extended ends). Persisted; edited from the flyout. */
const ERASE_CAP_KEY = 'zoetrope.eraseBrushCap'
const readEraseBrushCap = (): 'round' | 'square' => {
  try {
    const v = localStorage.getItem(ERASE_CAP_KEY)
    return v === 'square' ? 'square' : 'round'
  } catch {
    return 'round'
  }
}
export const eraseBrushCap = signal<'round' | 'square'>(readEraseBrushCap())
effect(() => {
  const v = eraseBrushCap.value
  try {
    localStorage.setItem(ERASE_CAP_KEY, v)
  } catch {
    /* storage unavailable */
  }
})

/** Non-destructive erase (Phase 2): when on, an erase appends a live `subtract`
 *  operator to the shape instead of baking the cut into its points, so it stays
 *  re-editable and animatable. Off (default) = bake, the classic destructive cut. */
const ERASE_ND_KEY = 'zoetrope.eraseNonDestructive'
const readEraseNonDestructive = (): boolean => {
  try {
    return localStorage.getItem(ERASE_ND_KEY) === '1'
  } catch {
    return false
  }
}
export const eraseNonDestructive = signal<boolean>(readEraseNonDestructive())
effect(() => {
  const v = eraseNonDestructive.value
  try {
    localStorage.setItem(ERASE_ND_KEY, v ? '1' : '0')
  } catch {
    /* storage unavailable */
  }
})

/**
 * Live eraser stroke during an erase drag: the accumulated stroke as WORLD-space
 * points plus the brush radius (world units) and the active `mode`, or null when
 * no erase is in flight. Written at pointer rate by the PathEditorOverlay; read by
 * SelectionOverlay to preview the swept band (brush) or the lasso loop before the
 * destructive boolean commits on release.
 */
export const eraseStroke = signal<{
  /** The outline polyline to preview (curved edges already flattened). */
  points: Array<{ x: number; y: number }>
  radius: number
  mode: 'brush' | 'lasso'
  /** Brush only: end/edge style of the swept band. */
  cap?: 'round' | 'square'
  /** Free-form only: the placed anchor nodes (with any bézier handles) to draw as
   *  editable markers — distinct from the flattened `points`. */
  nodes?: Array<{
    x: number
    y: number
    hIn?: { x: number; y: number }
    hOut?: { x: number; y: number }
  }>
  /** Free-form only: the cursor is over the first node, so the next click CLOSES
   *  the loop — the overlay shows a scissors affordance there. */
  close?: boolean
} | null>(null)

/**
 * Live working vector network during a path-edit drag (R4), or null when no drag
 * is in flight (the overlay then reads the committed `content.network`). Written at
 * pointer rate so the node/edge markers track the cursor without a history commit
 * per frame. Typed loosely to avoid a geom import cycle here.
 */
export const pathEditNetwork = signal<{
  nodes: Array<{ x: number; y: number }>
  edges: Array<{ a: number; b: number; ha?: { x: number; y: number }; hb?: { x: number; y: number } }>
} | null>(null)

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
