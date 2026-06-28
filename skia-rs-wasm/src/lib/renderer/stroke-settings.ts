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

export interface StrokeBasicSettings {
  /** Custom dash pattern `[dash, gap, …]` in px. Absent/empty = derive from `strokeStyle`. */
  strokeDashes?: number[]
  /** Cap applied to each dash/line end. */
  strokeDashCap?: StrokeDashCap
  /** Corner join. */
  strokeJoin?: StrokeBasicJoin
  /** Miter limit ratio (Skia default 4 ≈ 28.96°). */
  strokeMiterLimit?: number
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
