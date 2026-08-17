/**
 * The IR evaluator's atom: sample a `Curve` at a position along its domain, and
 * resolve a `Binding` against an evaluation context. This is the single
 * interpolation path the whole engine builds on -- timelines (domain = time),
 * parameter bindings (domain = a param), and later blend spaces all reduce to
 * "sample a curve at a domain value". The motion editor's delta authoring
 * (../motion/edit) builds on this single path. Pure + self-contained.
 */

import type { Binding, Curve, Domain, Interp, Key, Target } from './types'

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/** Named easing presets as cubic-bezier control points (CSS shape). */
const PRESETS: Record<'linear' | 'easeIn' | 'easeOut' | 'easeInOut', readonly [number, number, number, number]> = {
  linear: [0, 0, 1, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
}

/** Evaluate a cubic-bezier component at parameter t. */
const bezier1 = (t: number, p1: number, p2: number): number => {
  const u = 1 - t
  // control points c0 = 0, c3 = 1; c1 = p1, c2 = p2.
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t
}

/**
 * A cubic-bezier easing `(x1,y1,x2,y2)` as a progress remap `u -> eased(u)`.
 * Solves bezierX(t) = u for t (Newton + bisection fallback), then returns
 * bezierY(t). Handles the linear identity fast.
 */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (u: number) => number {
  if (x1 === 0 && y1 === 0 && x2 === 1 && y2 === 1) return (u) => u
  return (u: number): number => {
    const x = clamp01(u)
    let t = x
    for (let i = 0; i < 8; i++) {
      const dx = bezier1(t, x1, x2) - x
      if (Math.abs(dx) < 1e-6) break
      const d = 3 * (1 - t) * (1 - t) * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2)
      if (Math.abs(d) < 1e-6) break
      t -= dx / d
    }
    if (t < 0 || t > 1) {
      let lo = 0
      let hi = 1
      t = x
      for (let i = 0; i < 20; i++) {
        t = (lo + hi) / 2
        const bx = bezier1(t, x1, x2)
        if (Math.abs(bx - x) < 1e-6) break
        if (bx < x) lo = t
        else hi = t
      }
    }
    return bezier1(t, y1, y2)
  }
}

/** Turn an `Interp` into a `u -> eased(u)` progress remap. `hold` is handled by the caller. */
export function resolveInterp(interp: Interp | undefined): (u: number) => number {
  if (interp === undefined || interp === 'linear') return (u) => u
  if (interp === 'hold') return () => 0 // step: stay on the start value until the next key
  if (Array.isArray(interp)) return cubicBezier(interp[0], interp[1], interp[2], interp[3])
  const p = PRESETS[interp as 'easeIn' | 'easeOut' | 'easeInOut']
  return cubicBezier(p[0], p[1], p[2], p[3])
}

/**
 * Sample a curve at domain position `x`. Clamps to the first/last key outside
 * the keyed range. Returns `undefined` for an empty curve. Keys are assumed
 * ascending in `at` (authoring keeps them sorted).
 */
export function sampleCurve(curve: Curve, x: number): number | undefined {
  const ks = curve.keys
  if (ks.length === 0) return undefined
  if (ks.length === 1) return ks[0].value
  if (x <= ks[0].at) return ks[0].value
  const last = ks[ks.length - 1]
  if (x >= last.at) return last.value

  let i = 0
  while (i < ks.length - 1 && ks[i + 1].at <= x) i++
  const k0: Key = ks[i]
  const k1: Key = ks[i + 1]
  const span = k1.at - k0.at
  const u = span <= 0 ? 0 : (x - k0.at) / span
  const eased = resolveInterp(k0.interp)(u)
  return lerp(k0.value, k1.value, eased)
}

/** What a curve is sampled against: the current time (ms) and live param values. */
export interface EvalContext {
  time: number
  params: Record<string, number>
}

/** Resolve a domain to its current independent-variable value from the context. */
export function domainValue(domain: Domain, ctx: EvalContext): number {
  return domain.kind === 'time' ? ctx.time : (ctx.params[domain.param] ?? 0)
}

/** Evaluate a binding: the target property and its sampled value, or `undefined` if the curve is empty. */
export function sampleBinding(binding: Binding, ctx: EvalContext): { target: Target; value: number } | undefined {
  const value = sampleCurve(binding.curve, domainValue(binding.curve.domain, ctx))
  return value === undefined ? undefined : { target: binding.target, value }
}
