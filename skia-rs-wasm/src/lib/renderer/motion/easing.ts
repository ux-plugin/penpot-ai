/**
 * Easing functions. Named presets map to cubic-bézier control points (the same
 * curves CSS uses); `resolveEasing` returns a `(u) => number` that maps linear
 * segment progress u ∈ [0, 1] to eased progress.
 */

import type { Easing } from './types'

const PRESETS: Record<'linear' | 'easeIn' | 'easeOut' | 'easeInOut', readonly [number, number, number, number]> = {
  linear: [0, 0, 1, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
}

/**
 * Cubic-bézier easing y(x) with P0 = (0, 0), P3 = (1, 1) and the given control
 * points, evaluated at x = u. Solves x(s) = u for the bézier parameter s with a
 * few Newton iterations (bisection fallback), then returns y(s).
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (u: number) => number {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by

  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s
  const sampleDX = (s: number) => (3 * ax * s + 2 * bx) * s + cx

  const solveS = (u: number) => {
    let s = u
    for (let i = 0; i < 8; i++) {
      const x = sampleX(s) - u
      if (Math.abs(x) < 1e-6) return s
      const dx = sampleDX(s)
      if (Math.abs(dx) < 1e-6) break
      s -= x / dx
    }
    let lo = 0
    let hi = 1
    s = u
    for (let i = 0; i < 32; i++) {
      const x = sampleX(s)
      if (Math.abs(x - u) < 1e-6) break
      if (x < u) lo = s
      else hi = s
      s = (lo + hi) / 2
    }
    return s
  }

  return (u: number) => {
    if (u <= 0) return 0
    if (u >= 1) return 1
    return sampleY(solveS(u))
  }
}

const IDENTITY = (u: number) => u

/** Resolve an Easing descriptor to a progress-mapping function. */
export function resolveEasing(easing: Easing = 'linear'): (u: number) => number {
  if (easing === 'linear') return IDENTITY
  const cp = typeof easing === 'string' ? PRESETS[easing] : easing
  return cubicBezier(cp[0], cp[1], cp[2], cp[3])
}
