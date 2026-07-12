/**
 * Animated-pose provider — the single read-only source the paused-motion pick
 * and overlay share. For a node at the current (paused) playhead it exposes the
 * matrix actually drawn (rest -> animated) and derived bounds, plus the
 * predicates that gate the overlay. Values come from the exact per-frame
 * matrices the WasmModifierSink applied, so "where you click", "where the box
 * is", and "where it's drawn" can't disagree.
 *
 * Read-only glue for the overlay/selection layers; the producer that pushes the
 * matrices to the worker lives in ../motion/motion-store. Keeping this module a
 * pure consumer avoids an import cycle with the store.
 */

import type { Matrix } from 'penpot-exporter/types'
import { transformRectAABB } from '../geom/matrix'
import { lastAppliedModifiers, motionPlaying, motionPreviewActive, motionShapes } from './motion-store'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * True while a motion preview is applied AND playback is paused/stopped-at-a-
 * frame. This is the gate for modifier-aware picking and the on-canvas overlay:
 * during active playback we leave selection alone; when nothing is previewed the
 * shapes are at rest and the normal (rest) path is correct.
 */
export function motionOverlayActive(): boolean {
  return motionPreviewActive.value && !motionPlaying.value
}

/** Whether a node carries an authored motion (a timeline with at least one binding). */
export function hasMotion(id: string): boolean {
  return motionShapes.value.some((s) => s.targetId === id && s.timeline.bindings.length > 0)
}

/**
 * The rest -> animated matrix drawn for `id` at the current frame, or null when
 * it isn't animated. This is exactly what render-wasm was handed, so a query
 * inverse-mapped by it lands on the shape's rest geometry.
 */
export function getAnimatedTransform(id: string): Matrix | null {
  return lastAppliedModifiers().get(id) ?? null
}

/**
 * The node's world AABB at the current frame, given its rest bounds. Null when
 * the node isn't animated (the caller should fall back to the rest bounds).
 */
export function getAnimatedAABB(id: string, restBounds: Rect): Rect | null {
  const m = getAnimatedTransform(id)
  return m ? transformRectAABB(restBounds, m) : null
}
