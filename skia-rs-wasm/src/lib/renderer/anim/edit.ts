/**
 * Pure editing primitives over a single `Timeline`'s bindings and keys. These
 * are the IR-level authoring atoms (find / set / remove / move a key on a
 * target's curve) that the editor builds higher-level operations on. Every
 * function is a reducer: it takes a `Timeline` and returns a new one, never
 * mutating the input, so it composes with signals and React state.
 *
 * A binding is identified by its target AND its domain, so one property can be
 * driven independently over time and over a parameter (they are separate curves).
 * The `domain` argument defaults to time, keeping the common keyframe path terse.
 * Domain-agnostic and rest-agnostic on purpose -- the delta/rest authoring
 * convention lives one layer up in ../motion/edit. This layer only knows curves
 * and keys, which is what ports cleanly to the Rust runtime later.
 */

import type { Binding, Domain, Interp, Key, Target, Timeline } from './types'

const EPS = 1e-6
const TIME: Domain = { kind: 'time' }

/** Two targets refer to the same animatable channel. */
export function sameTarget(a: Target, b: Target): boolean {
  return a.prop === b.prop && a.object.kind === b.object.kind && a.object.id === b.object.id
}

/** Two domains are the same independent variable (time, or the same named param). */
export function sameDomain(a: Domain, b: Domain): boolean {
  if (a.kind !== b.kind) return false
  return a.kind === 'time' ? true : a.param === (b as { param: string }).param
}

/** The binding driving `target` over `domain`, if any. */
export function findBindingOn(timeline: Timeline, target: Target, domain: Domain = TIME): Binding | undefined {
  return timeline.bindings.find((b) => sameTarget(b.target, target) && sameDomain(b.curve.domain, domain))
}

/** The key at position `at` on `target`'s `domain` curve, if any. */
export function findKey(timeline: Timeline, target: Target, at: number, domain: Domain = TIME): Key | undefined {
  return findBindingOn(timeline, target, domain)?.curve.keys.find((k) => Math.abs(k.at - at) <= EPS)
}

/**
 * The timeline's duration = the largest `at` across its TIME-domain keys. Param-
 * domain positions are parameter values, not times, so they never extend it.
 */
export function timeDuration(bindings: readonly Binding[]): number {
  let max = 0
  for (const b of bindings) {
    if (b.curve.domain.kind !== 'time') continue
    for (const k of b.curve.keys) if (k.at > max) max = k.at
  }
  return max
}

/** An empty time-domain timeline to accumulate bindings into. */
export function emptyTimeline(id: string): Timeline {
  return { id, duration: 0, bindings: [] }
}

/**
 * Set (add or update) a key at `at` on `target`'s `domain` curve, creating the
 * binding on a fresh curve of that domain if it doesn't exist yet. Updating an
 * existing key preserves its `interp` unless a new one is given. Keys stay
 * sorted; duration is recomputed from the time-domain keys.
 */
export function setKey(
  timeline: Timeline,
  target: Target,
  at: number,
  value: number,
  interp?: Interp,
  domain: Domain = TIME,
): Timeline {
  // Clone only the binding/curve/keys we touch so the input is never mutated.
  const bindings = timeline.bindings.map((b) =>
    sameTarget(b.target, target) && sameDomain(b.curve.domain, domain)
      ? { ...b, curve: { ...b.curve, keys: [...b.curve.keys] } }
      : b,
  )
  let binding = bindings.find((b) => sameTarget(b.target, target) && sameDomain(b.curve.domain, domain))
  if (!binding) {
    binding = { target, curve: { domain, keys: [] } }
    bindings.push(binding)
  }
  const keys = binding.curve.keys
  const idx = keys.findIndex((k) => Math.abs(k.at - at) <= EPS)
  if (idx >= 0) {
    keys[idx] = { ...keys[idx], at, value, ...(interp !== undefined ? { interp } : {}) }
  } else {
    keys.push({ at, value, ...(interp !== undefined ? { interp } : {}) })
    keys.sort((a, b) => a.at - b.at)
  }
  return { ...timeline, bindings, duration: timeDuration(bindings) }
}

/**
 * Remove the key at `at` on `target`'s `domain` curve. Empties cascade: a binding
 * whose curve loses its last key is dropped. Returns the same timeline reference
 * when nothing matched, so callers can detect a no-op by identity.
 */
export function removeKey(timeline: Timeline, target: Target, at: number, domain: Domain = TIME): Timeline {
  const binding = findBindingOn(timeline, target, domain)
  if (!binding) return timeline
  const keys = binding.curve.keys.filter((k) => Math.abs(k.at - at) > EPS)
  if (keys.length === binding.curve.keys.length) return timeline
  const bindings = timeline.bindings
    .map((b) => (b === binding ? { ...b, curve: { ...b.curve, keys } } : b))
    .filter((b) => b.curve.keys.length > 0)
  return { ...timeline, bindings, duration: timeDuration(bindings) }
}

/**
 * Move a key from `fromAt` to `toAt` on `target`'s `domain` curve, preserving its
 * value and interp. Overwrites a key already sitting at `toAt`. No-op (same
 * reference) when there is no key at `fromAt` or the position is unchanged.
 */
export function moveKey(
  timeline: Timeline,
  target: Target,
  fromAt: number,
  toAt: number,
  domain: Domain = TIME,
): Timeline {
  const key = findKey(timeline, target, fromAt, domain)
  if (!key) return timeline
  const to = Math.max(0, Math.round(toAt))
  if (Math.abs(to - fromAt) <= EPS) return timeline
  return setKey(removeKey(timeline, target, fromAt, domain), target, to, key.value, key.interp, domain)
}
