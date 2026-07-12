/**
 * The timeline evaluator: turn a `Timeline` into the per-frame property writes
 * it produces for one `EvalContext`. This is the layer above the single-curve
 * atom (./sample) -- it walks every `Binding`, samples it, and folds the results
 * into a per-node property bag the render adapter consumes.
 *
 * Time normalization (clamp / loop-wrap by the timeline's `duration`) lives HERE,
 * so the `Timeline` is the single owner of its own loop semantics -- portable
 * across the wasm boundary when this ports to Rust. Only the *time* domain wraps;
 * param-domain bindings read live parameter values untouched.
 *
 * Output is layered: `evaluateWrites` returns the general flat `Write[]` (grows
 * to bone / param targets later); `evaluateTimeline` folds the node writes into
 * `Map<nodeId, props>` for `propsToModifier`. Pure + self-contained.
 */

import { sampleBinding, type EvalContext } from './sample'
import type { Target, Timeline } from './types'

/** One resolved property write: a target property and its sampled value. */
export interface Write {
  target: Target
  value: number
}

/** A node's sampled properties this frame, keyed by property name (`x`, `opacity`, ...). */
export type PropertyBag = Record<string, number>

/** Map a master time onto the timeline's playable range: wrap when looping, clamp otherwise. */
export function normalizeTime(t: number, duration: number, loop?: boolean): number {
  if (duration <= 0) return 0
  if (loop) {
    const m = t % duration
    return m < 0 ? m + duration : m
  }
  return t < 0 ? 0 : t > duration ? duration : t
}

/**
 * Sample every binding of a timeline at `ctx` into a flat list of writes. Time
 * is normalized to the timeline's range first (loop/clamp); params pass through.
 * Bindings whose curve is empty contribute nothing.
 */
export function evaluateWrites(timeline: Timeline, ctx: EvalContext): Write[] {
  const local: EvalContext = {
    time: normalizeTime(ctx.time, timeline.duration, timeline.loop),
    params: ctx.params,
  }
  const writes: Write[] = []
  for (const binding of timeline.bindings) {
    const w = sampleBinding(binding, local)
    if (w !== undefined) writes.push(w)
  }
  return writes
}

/**
 * Fold writes onto their node targets: `Map<nodeId, props>`. Non-node targets
 * (bone / param -- driver composition) are skipped here; their evaluators land
 * in later slices and consume the raw `Write[]` instead.
 */
export function foldNodeWrites(writes: Write[]): Map<string, PropertyBag> {
  const out = new Map<string, PropertyBag>()
  for (const w of writes) {
    if (w.target.object.kind !== 'node') continue
    const id = w.target.object.id
    let props = out.get(id)
    if (props === undefined) {
      props = {}
      out.set(id, props)
    }
    props[w.target.prop] = w.value
  }
  return out
}

/** Evaluate a timeline to per-node property bags for the render adapter. */
export function evaluateTimeline(timeline: Timeline, ctx: EvalContext): Map<string, PropertyBag> {
  return foldNodeWrites(evaluateWrites(timeline, ctx))
}
