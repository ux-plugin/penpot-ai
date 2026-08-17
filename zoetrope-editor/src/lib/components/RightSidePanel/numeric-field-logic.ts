/**
 * Pure interaction policy for {@link NumericField} — no React, no app imports,
 * so it runs under the node-env vitest suite and stays trivially testable.
 */

export interface NumericBounds {
  min?: number
  max?: number
  precision?: number
}

/** Round to `precision` decimals (default 2), clearing binary float noise. */
export function roundTo(n: number, precision = 2): number {
  const f = 10 ** precision
  return Math.round(n * f) / f
}

/** Clamp to [min, max] (either side optional) then round. */
export function clampRound(n: number, { min, max, precision = 2 }: NumericBounds): number {
  let v = n
  if (min != null && v < min) v = min
  if (max != null && v > max) v = max
  return roundTo(v, precision)
}

/**
 * Parse a raw input string to a number, or null when it isn't a committable
 * value yet: empty, a lone sign/dot, or non-numeric. A trailing dot ("12.") is
 * treated as the integer so mid-typing doesn't reject.
 */
export function parseNumericInput(raw: string): number | null {
  const s = raw.trim()
  if (s === '' || s === '-' || s === '.' || s === '-.') return null
  const n = parseFloat(s.replace(/\.$/, ''))
  return Number.isFinite(n) ? n : null
}

export interface StepModifiers {
  shift?: boolean
  alt?: boolean
}

/** Step multiplier: Shift = 10×, Alt = 0.1×, else 1× (matches frontend numeric-input*). */
export function stepMultiplier({ shift, alt }: StepModifiers = {}): number {
  if (shift) return 10
  if (alt) return 0.1
  return 1
}

/** Next value for one arrow/wheel step. Does NOT clamp or round — caller does. */
export function stepValue(
  current: number,
  step: number,
  direction: 1 | -1,
  mods: StepModifiers = {},
): number {
  return current + direction * step * stepMultiplier(mods)
}

/** Format a committed number for display: at most `precision` decimals, no trailing zeros. */
export function formatNumber(value: number, precision = 2): string {
  return String(roundTo(value, precision))
}
