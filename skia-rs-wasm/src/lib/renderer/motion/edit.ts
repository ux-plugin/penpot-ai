/**
 * The delta/rest authoring layer. A `ShapeMotion` pairs one shape's IR timeline
 * with its authoring-only rest metadata; these reducers add/update/remove/retime
 * keyframes and re-home a motion onto a chosen rest pose. Keyframe values are
 * *deltas* from the shape's rest pose (0 == at rest), so a motion is a portable
 * offset the renderer applies non-destructively over the document pose.
 *
 * Built on the IR primitives in ../anim/edit; the delta/rest convention (which
 * the general IR doesn't carry) lives only here. One timeline per shape, keyed
 * by `tl-<targetId>`; the timeline's duration tracks its latest keyframe.
 */

import { sampleBinding } from '../anim/sample'
import { emptyTimeline, findBindingOn, findKey, moveKey, removeKey, setKey } from '../anim/edit'
import type { Domain, Interp, Key, Target, Timeline } from '../anim/types'
import type { AnimatableProperty } from './props'

/** One shape's motion: its IR timeline plus authoring-only rest metadata (not part of the IR). */
export interface ShapeMotion {
  targetId: string
  timeline: Timeline
  /** The time (ms) whose pose is the shape's rest/home. Authoring metadata; default 0. */
  restFrame: number
}

const timelineId = (targetId: string): string => `tl-${targetId}`
const nodeTarget = (targetId: string, property: AnimatableProperty): Target => ({
  object: { kind: 'node', id: targetId },
  prop: property,
})

/** The keyframe at `time` on (target, property), or undefined. */
export function keyframeAt(
  motions: ShapeMotion[],
  targetId: string,
  property: AnimatableProperty,
  time: number,
): Key | undefined {
  const m = motions.find((x) => x.targetId === targetId)
  return m ? findKey(m.timeline, nodeTarget(targetId, property), time) : undefined
}

/**
 * Add or update a keyframe at `time` on (target, property), creating the shape's
 * motion as needed. `value` is the delta from rest. Preserves easing unless a
 * new `interp` is given.
 */
export function setKeyframe(
  motions: ShapeMotion[],
  targetId: string,
  property: AnimatableProperty,
  time: number,
  value: number,
  interp?: Interp,
): ShapeMotion[] {
  const target = nodeTarget(targetId, property)
  const existing = motions.find((m) => m.targetId === targetId)
  if (existing) {
    const timeline = setKey(existing.timeline, target, time, value, interp)
    return motions.map((m) => (m.targetId === targetId ? { ...m, timeline } : m))
  }
  const timeline = setKey(emptyTimeline(timelineId(targetId)), target, time, value, interp)
  return [...motions, { targetId, timeline, restFrame: 0 }]
}

/**
 * Remove the keyframe at `time` on (target, property). Empties cascade: a binding
 * with no keys is dropped, and a shape with no bindings is dropped. Returns the
 * same array reference when nothing matched.
 */
export function removeKeyframe(
  motions: ShapeMotion[],
  targetId: string,
  property: AnimatableProperty,
  time: number,
): ShapeMotion[] {
  const existing = motions.find((m) => m.targetId === targetId)
  if (!existing) return motions
  const timeline = removeKey(existing.timeline, nodeTarget(targetId, property), time)
  if (timeline === existing.timeline) return motions
  if (timeline.bindings.length === 0) return motions.filter((m) => m.targetId !== targetId)
  return motions.map((m) => (m.targetId === targetId ? { ...m, timeline } : m))
}

/** Retime a keyframe on (target, property) from one time to another. No-op (same ref) when nothing changes. */
export function moveKeyframe(
  motions: ShapeMotion[],
  targetId: string,
  property: AnimatableProperty,
  fromTime: number,
  toTime: number,
): ShapeMotion[] {
  const existing = motions.find((m) => m.targetId === targetId)
  if (!existing) return motions
  const timeline = moveKey(existing.timeline, nodeTarget(targetId, property), fromTime, toTime)
  if (timeline === existing.timeline) return motions
  return motions.map((m) => (m.targetId === targetId ? { ...m, timeline } : m))
}

/** The sorted union of x/y time-domain key times on a timeline -- the motion-path waypoints. */
function positionWaypointTimes(timeline: Timeline): number[] {
  const set = new Set<number>()
  for (const b of timeline.bindings) {
    if (b.curve.domain.kind !== 'time') continue
    if (b.target.prop !== 'x' && b.target.prop !== 'y') continue
    for (const k of b.curve.keys) set.add(k.at)
  }
  return [...set].sort((a, b) => a - b)
}

/** Sampled value for one property on a raw timeline at `time` (0 when the binding is absent/empty). */
function samplePropAt(timeline: Timeline, targetId: string, property: AnimatableProperty, time: number): number {
  const binding = findBindingOn(timeline, nodeTarget(targetId, property), { kind: 'time' })
  if (!binding || binding.curve.keys.length === 0) return 0
  return sampleBinding(binding, { time, params: {} })?.value ?? 0
}

/**
 * Freeze (bake) each position axis's current value at the immediate waypoint
 * neighbours of `time`, so a subsequent x/y write at `time` only re-flows the two
 * path segments adjacent to it -- every other waypoint stays pinned. This is what
 * keeps a motion-path drag LOCAL once the two axes have desynced key times (e.g.
 * after retiming one axis): without it, writing the sparse axis re-interpolates its
 * whole enclosing span and drags every interpolated waypoint inside it. An axis
 * with no keyframes is left untouched (nothing to pin), and a neighbour that is
 * already a real key is preserved.
 */
export function bakePositionNeighbors(timeline: Timeline, targetId: string, time: number): Timeline {
  let prev = -Infinity
  let next = Infinity
  for (const t of positionWaypointTimes(timeline)) {
    if (t < time && t > prev) prev = t
    if (t > time && t < next) next = t
  }
  const neighbors = [prev, next].filter((n) => Number.isFinite(n))
  if (neighbors.length === 0) return timeline
  let tl = timeline
  for (const property of ['x', 'y'] as const) {
    const target = nodeTarget(targetId, property)
    const binding = findBindingOn(timeline, target, { kind: 'time' })
    if (!binding || binding.curve.keys.length === 0) continue // axis not animated -> nothing to pin
    for (const nb of neighbors) {
      if (findKey(timeline, target, nb)) continue // already a real key here
      tl = setKey(tl, target, nb, samplePropAt(timeline, targetId, property, nb))
    }
  }
  return tl
}

/**
 * Author an x/y keyframe at `time` (deltas from rest), baking the neighbouring
 * waypoints on each axis first so the edit stays LOCAL -- only the two path
 * segments adjacent to `time` re-flow. Creates the shape's motion if needed;
 * `interp` (when given) applies to both axes.
 */
export function setPositionKeyframe(
  motions: ShapeMotion[],
  targetId: string,
  time: number,
  dx: number,
  dy: number,
  interp?: Interp,
): ShapeMotion[] {
  const existing = motions.find((m) => m.targetId === targetId)
  const base = existing ? existing.timeline : emptyTimeline(timelineId(targetId))
  let tl = bakePositionNeighbors(base, targetId, time)
  tl = setKey(tl, nodeTarget(targetId, 'x'), time, dx, interp)
  tl = setKey(tl, nodeTarget(targetId, 'y'), time, dy, interp)
  if (existing) return motions.map((m) => (m.targetId === targetId ? { ...m, timeline: tl } : m))
  return [...motions, { targetId, timeline: tl, restFrame: 0 }]
}

/**
 * Ensure a delta-0 rest anchor exists at `restTime` for (target, property).
 * Without it a lone end keyframe would offset the shape at every time (a single
 * key clamps to its value), so the anchor is what makes a motion a true
 * rest -> end transition. Idempotent (same ref when the anchor is already there).
 */
export function ensureRestAnchor(
  motions: ShapeMotion[],
  targetId: string,
  property: AnimatableProperty,
  restTime: number,
): ShapeMotion[] {
  if (keyframeAt(motions, targetId, property, restTime)) return motions
  return setKeyframe(motions, targetId, property, restTime, 0)
}

/** Sampled delta for one property of a shape at time `t` (0 when the binding is absent/empty). */
export function keyframeDelta(
  motions: ShapeMotion[],
  targetId: string,
  property: AnimatableProperty,
  time: number,
): number {
  const m = motions.find((x) => x.targetId === targetId)
  if (!m) return 0
  return sampleDelta(m, property, time)
}

function sampleDelta(m: ShapeMotion, property: AnimatableProperty, time: number): number {
  const binding = findBindingOn(m.timeline, nodeTarget(m.targetId, property), { kind: 'time' })
  if (!binding || binding.curve.keys.length === 0) return 0
  return sampleBinding(binding, { time, params: {} })?.value ?? 0
}

/**
 * Author a param-domain keyframe: at parameter position `at`, the property's
 * delta from rest is `value`. Same delta convention as time keys, but the curve
 * is sampled against a live parameter instead of the clock -- the unification
 * that makes "keyframe track" and "parameter binding" one structure.
 */
export function setParamKeyframe(
  motions: ShapeMotion[],
  targetId: string,
  property: AnimatableProperty,
  param: string,
  at: number,
  value: number,
  interp?: Interp,
): ShapeMotion[] {
  const target = nodeTarget(targetId, property)
  const domain: Domain = { kind: 'param', param }
  const existing = motions.find((m) => m.targetId === targetId)
  if (existing) {
    const timeline = setKey(existing.timeline, target, at, value, interp, domain)
    return motions.map((m) => (m.targetId === targetId ? { ...m, timeline } : m))
  }
  const timeline = setKey(emptyTimeline(timelineId(targetId)), target, at, value, interp, domain)
  return [...motions, { targetId, timeline, restFrame: 0 }]
}

/** A re-home result: the shifted motions plus the x/y/rotation the document must move by. */
export interface RestRebase {
  motions: ShapeMotion[]
  docDelta: { x: number; y: number; rotation: number }
}

/**
 * Re-home a shape's motion onto the pose at `restFrame`. The document position
 * moves by the sampled delta there (`docDelta`) and every keyframe shifts by that
 * same amount, so the trajectory is visually unchanged but delta 0 -- the rest --
 * now lands at `restFrame`. Only x/y/rotation are re-homed (the transform props
 * the document geometry carries). No-op delta when the shape has no motion.
 */
export function rebaseToRest(motions: ShapeMotion[], targetId: string, restFrame: number): RestRebase {
  const m = motions.find((x) => x.targetId === targetId)
  if (!m) return { motions, docDelta: { x: 0, y: 0, rotation: 0 } }
  const dx = sampleDelta(m, 'x', restFrame)
  const dy = sampleDelta(m, 'y', restFrame)
  const drot = sampleDelta(m, 'rotation', restFrame)
  const shiftFor = (prop: string): number => (prop === 'x' ? dx : prop === 'y' ? dy : prop === 'rotation' ? drot : 0)
  const timeline: Timeline = {
    ...m.timeline,
    bindings: m.timeline.bindings.map((b) => {
      // Only time-domain transform keys re-home to the rest frame; param bindings
      // have their own rest (the parameter's min) and must be left untouched.
      const s = b.curve.domain.kind === 'time' ? shiftFor(b.target.prop) : 0
      if (s === 0) return b
      return { ...b, curve: { ...b.curve, keys: b.curve.keys.map((k) => ({ ...k, value: k.value - s })) } }
    }),
  }
  const next: ShapeMotion = { ...m, timeline, restFrame: Math.max(0, Math.round(restFrame)) }
  return {
    motions: motions.map((x) => (x.targetId === targetId ? next : x)),
    docDelta: { x: dx, y: dy, rotation: drot },
  }
}
