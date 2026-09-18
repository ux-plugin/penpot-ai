/**
 * Basic-tab stroke settings (custom dashes + dash cap + join + miter angle).
 *
 * These fields are not yet part of the upstream `penpot-exporter` `Stroke`
 * type, so we extend it locally rather than editing the submodule. They ride
 * along as plain optional props on the stroke object and are read by the
 * renderer bridge (`api/strokes.ts`) + the floating stroke-settings panel.
 */

import type { Stroke } from 'penpot-exporter/types'

export type StrokeDashCap = 'butt' | 'round' | 'square'
export type StrokeBasicJoin = 'miter' | 'round' | 'bevel'

/** Rendering engine that draws a stroke. `basic` = the standard Skia vector
 *  outline; the rest are the phased brush engines (see the brush plan). */
export type StrokeBrushEngine =
  | 'basic'
  | 'power'
  | 'roughen'
  | 'sketch'
  | 'texture-dab'
  | 'texture-stretch'

/**
 * Selected brush snapshot stored on the stroke. Absent = the default `basic`
 * outline. We snapshot id + engine + params (rather than referencing a brush
 * library by id) so a shared document stays renderable without the author's
 * library present.
 */
export interface StrokeBrush {
  id: string
  engine: StrokeBrushEngine
  params?: Record<string, number | string | number[]>
}

/** "Dynamic" stroke — procedural hand-drawn perturbation. All fields 0..1. */
export interface StrokeDynamic {
  /** Wiggle wavelength (higher = shorter waves / more wiggles). */
  frequency: number
  /** Perpendicular displacement amplitude. */
  wiggle: number
  /** Corner rounding of the result. */
  smoothen: number
}

export interface StrokeBasicSettings {
  /** Custom dash pattern `[dash, gap, …]` in px. Absent/empty = derive from `strokeStyle`. */
  strokeDashes?: number[]
  /** Cap applied to each dash/line end. */
  strokeDashCap?: StrokeDashCap
  /** Corner join. */
  strokeJoin?: StrokeBasicJoin
  /** Miter limit ratio (Skia default 4 ≈ 28.96°). */
  strokeMiterLimit?: number
  /** Procedural "Dynamic" perturbation. Absent = off. */
  strokeDynamic?: StrokeDynamic
  /** Selected brush. Absent = the default `basic` outline. */
  strokeBrush?: StrokeBrush
  /** Hand-authored variable-width points `[t, left, right, mode, …]`
   *  (arc-fraction, per-side half-width multipliers, and the interpolation mode
   *  of the segment leaving the point: `0` smooth / `1` corner / `2` stepped).
   *  A stroke-level property — any ribbon-drawn stroke (incl. plain `basic`)
   *  renders variable width when present; overrides a PowerStroke preset.
   *  Absent = uniform / preset. */
  strokeWidthPoints?: number[]
}

export type StrokeWithSettings = Stroke & StrokeBasicSettings

/**
 * SVG-style dash normalization: clamp non-finite/negative to 0, duplicate an
 * odd-length pattern (SVG repeats it to an even count), and collapse an
 * all-zero pattern to solid (`[]`).
 */
export function normalizeDashes(dashes: number[]): number[] {
  const clean = dashes.map((d) => (Number.isFinite(d) ? Math.max(0, d) : 0))
  const even = clean.length % 2 === 1 ? clean.concat(clean) : clean
  return even.some((d) => d > 0) ? even : []
}

/** Figma "miter angle" (degrees) ↔ Skia miter limit (ratio = 1 / sin(angle / 2)). */
export function miterAngleToLimit(deg: number): number {
  const halfRad = (deg * Math.PI) / 180 / 2
  const s = Math.sin(halfRad)
  return s <= 0 ? 4 : 1 / s
}

export function miterLimitToAngle(limit: number): number {
  if (limit <= 0) return 0
  return (2 * Math.asin(Math.min(1, 1 / limit)) * 180) / Math.PI
}
