/**
 * The sampler — the single interpolation path shared by timeline clips and
 * state transitions. `sampleClip` evaluates a clip at a time into a set of
 * property values; `blendStates` interpolates between two poses. Both reduce to
 * "interpolate property values over eased progress", which is what every
 * downstream consumer (Skia modifiers, the on-canvas path, exports) builds on.
 */

import type { Clip, PropertyTrack, SampledProperties, Easing } from './types'
import { resolveEasing } from './easing'

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * Sample one track at time `t` (ms). Clamps to the first/last keyframe outside
 * the keyframed range. Returns `undefined` for an empty track.
 */
export function sampleTrack(track: PropertyTrack, t: number): number | undefined {
  const kfs = track.keyframes
  if (kfs.length === 0) return undefined
  if (kfs.length === 1) return kfs[0].value
  if (t <= kfs[0].time) return kfs[0].value
  const last = kfs[kfs.length - 1]
  if (t >= last.time) return last.value

  // Find the segment [k0, k1] that contains t.
  let i = 0
  while (i < kfs.length - 1 && kfs[i + 1].time <= t) i++
  const k0 = kfs[i]
  const k1 = kfs[i + 1]

  const span = k1.time - k0.time
  const u = span <= 0 ? 0 : (t - k0.time) / span
  const eased = resolveEasing(k0.easing)(u)
  return lerp(k0.value, k1.value, eased)
}

/** Map clip time onto the playable range: wrap when looping, clamp otherwise. */
function normalizeTime(clip: Clip, t: number): number {
  if (clip.duration <= 0) return 0
  if (clip.loop) {
    const m = t % clip.duration
    return m < 0 ? m + clip.duration : m
  }
  return Math.max(0, Math.min(t, clip.duration))
}

/** Sample every track of a clip at time `t` (ms) into one property set. */
export function sampleClip(clip: Clip, t: number): SampledProperties {
  const local = normalizeTime(clip, t)
  const out: SampledProperties = {}
  for (const track of clip.tracks) {
    const v = sampleTrack(track, local)
    if (v !== undefined) out[track.property] = v
  }
  return out
}

/**
 * Blend two poses by eased progress `t` ∈ [0, 1]. Properties present in only one
 * side pass through unchanged. Same primitive as clip sampling — this is how a
 * state transition ("smart animate") tweens.
 */
export function blendStates(
  from: SampledProperties,
  to: SampledProperties,
  t: number,
  easing: Easing = 'linear'
): SampledProperties {
  const eased = resolveEasing(easing)(Math.max(0, Math.min(t, 1)))
  const out: SampledProperties = { ...from, ...to }
  for (const key of Object.keys(out) as (keyof SampledProperties)[]) {
    const a = from[key]
    const b = to[key]
    if (a !== undefined && b !== undefined) out[key] = lerp(a, b, eased)
  }
  return out
}
