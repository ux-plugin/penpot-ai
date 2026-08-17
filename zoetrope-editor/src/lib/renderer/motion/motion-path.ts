/**
 * Motion-path geometry — the pure sampler behind the on-canvas overlay.
 *
 * The trajectory is anchored to a STABLE rest point (the shape's committed pose),
 * not to the live selection rect. Every keyframe/path point is `restAnchor +
 * delta(t)`. While the shape is being dragged to author a keyframe, the caller
 * passes the shape's live center as `livePoint`: only the keyframe at the current
 * playhead is overlaid with that live pose (the path re-flows through it), so
 * exactly one point moves while the rest stays pinned. At rest `livePoint` equals
 * the committed pose, so nothing is overlaid and the eased path is untouched.
 *
 * Pure + signal-free so it is host-testable; the component feeds it live values.
 */

import { evaluateTimeline } from '../anim/evaluate'
import { findKey, setKey } from '../anim/edit'
import { bakePositionNeighbors } from './edit'
import type { Target, Timeline } from '../anim/types'

export interface PathPoint {
  x: number
  y: number
}

export interface KeyframePoint extends PathPoint {
  /** The keyframe time (ms). */
  t: number
}

export interface MotionPathGeometry {
  /** World-space rest anchor (the shape center at delta 0). */
  anchor: PathPoint
  /** Sampled polyline across the whole clip, world space (empty when no path). */
  points: PathPoint[]
  /** Position at each position keyframe (union of x/y time-domain key times). */
  keyframes: KeyframePoint[]
  /** True when the trajectory actually moves (≥2 key times AND non-zero extent). */
  hasPath: boolean
}

/** Position properties whose keyframes define the spatial trajectory. */
const POSITION_PROPS = new Set(['x', 'y'])

/**
 * The keyframe time the playhead is "on" — the nearest key within tolerance, or
 * null when the playhead is between keyframes. One definition drives BOTH the
 * scrub snap (land the playhead exactly here) and the selection highlight (this
 * time reads as current everywhere), so they can't disagree. Tolerance scales
 * with duration so a manual scrub that lands close still snaps/selects; a click
 * seeks exactly on. Returns the single closest time, so two near keys never tie.
 */
export function nearestKeyframeTime(times: number[], playhead: number, duration: number): number | null {
  const tolerance = Math.max(2, duration * 0.015)
  let best: number | null = null
  let bestDelta = Infinity
  for (const t of times) {
    const delta = Math.abs(t - playhead)
    if (delta <= tolerance && delta < bestDelta) {
      best = t
      bestDelta = delta
    }
  }
  return best
}

/** Below this the live pose is treated as "not dragging" (avoids splitting eased segments). */
const DRAG_EPSILON = 0.01

/** The x/y delta the timeline writes at time `t` (0 when the binding is absent). */
function sampleDelta(
  timeline: Timeline,
  targetId: string,
  t: number,
  params: Record<string, number>,
): PathPoint {
  const bag = evaluateTimeline(timeline, { time: t, params }).get(targetId)
  return { x: bag?.x ?? 0, y: bag?.y ?? 0 }
}

/** The sorted union of x/y time-domain keyframe times on this timeline. */
function positionKeyTimes(timeline: Timeline): number[] {
  const times = new Set<number>()
  for (const b of timeline.bindings) {
    if (b.curve.domain.kind !== 'time') continue
    if (!POSITION_PROPS.has(b.target.prop)) continue
    for (const k of b.curve.keys) times.add(k.at)
  }
  return Array.from(times).sort((a, b) => a - b)
}

/** Seed a delta-0 rest anchor at `restFrame` if the axis has none, so a lone live
 * key becomes a rest->here transition instead of a value clamped at every time
 * (mirrors ensureRestAnchor in ../motion/edit, what the real drag commit does). */
function ensureAnchor(timeline: Timeline, target: Target, restFrame: number): Timeline {
  return findKey(timeline, target, restFrame) ? timeline : setKey(timeline, target, restFrame, 0)
}

/** Overlay a live x/y delta onto the keyframe at `time` (insert if absent), first
 * seeding each axis's rest anchor so the overlaid axis animates from rest, then
 * baking the neighbouring waypoints so only the two segments adjacent to `time`
 * re-flow (mirrors the commit path in ../motion/edit setPositionKeyframe, so the
 * dragged preview is exactly what pointer-up records). */
function withLivePose(
  timeline: Timeline,
  targetId: string,
  restFrame: number,
  time: number,
  delta: PathPoint,
): Timeline {
  const xt: Target = { object: { kind: 'node', id: targetId }, prop: 'x' }
  const yt: Target = { object: { kind: 'node', id: targetId }, prop: 'y' }
  let tl = ensureAnchor(ensureAnchor(timeline, xt, restFrame), yt, restFrame)
  tl = bakePositionNeighbors(tl, targetId, time)
  tl = setKey(setKey(tl, xt, time, delta.x), yt, time, delta.y)
  return tl
}

/**
 * Build the motion path for one shape.
 *
 * `restAnchor` is the STABLE world-space rest center (from the committed pose) —
 * it must not track the cursor. `currentTime` is the playhead. `livePoint` is the
 * shape's live selection center; when it diverges from the committed pose (a
 * drag), the keyframe at `currentTime` is overlaid with it so the path re-flows
 * through only that point. `samples` is the polyline resolution.
 */
export function buildMotionPath(
  timeline: Timeline | undefined,
  targetId: string,
  restAnchor: PathPoint,
  currentTime: number,
  livePoint: PathPoint | null = null,
  params: Record<string, number> = {},
  samples = 48,
  restFrame = 0,
): MotionPathGeometry {
  const empty: MotionPathGeometry = { anchor: restAnchor, points: [], keyframes: [], hasPath: false }
  if (!timeline || timeline.duration <= 0) return empty

  // Overlay the live pose onto the current keyframe only while actually dragging
  // (live pose differs from the committed pose there) — otherwise an inserted key
  // would split an eased segment and distort the resting path.
  const liveDelta = livePoint ? { x: livePoint.x - restAnchor.x, y: livePoint.y - restAnchor.y } : null
  const committedNow = sampleDelta(timeline, targetId, currentTime, params)
  const dragging =
    liveDelta != null &&
    (Math.abs(liveDelta.x - committedNow.x) > DRAG_EPSILON || Math.abs(liveDelta.y - committedNow.y) > DRAG_EPSILON)
  const eff = dragging ? withLivePose(timeline, targetId, restFrame, currentTime, liveDelta!) : timeline

  const keyTimes = positionKeyTimes(eff)
  const keyframes: KeyframePoint[] = keyTimes.map((t) => {
    const d = sampleDelta(eff, targetId, t, params)
    return { t, x: restAnchor.x + d.x, y: restAnchor.y + d.y }
  })

  // Sample the polyline at uniform steps for smooth eased curves, PLUS a vertex at
  // every keyframe time -- otherwise a keyframe that falls between two uniform
  // samples sits at a corner the chord cuts across, and its diamond floats off the
  // drawn line. Unioning the key times guarantees the polyline passes exactly
  // through each keyframe marker.
  const n = Math.max(2, Math.floor(samples))
  const times = new Set<number>()
  for (let i = 0; i <= n; i++) times.add((eff.duration * i) / n)
  for (const t of keyTimes) if (t >= 0 && t <= eff.duration) times.add(t)
  const points: PathPoint[] = []
  let extent = 0
  for (const t of [...times].sort((a, b) => a - b)) {
    const d = sampleDelta(eff, targetId, t, params)
    points.push({ x: restAnchor.x + d.x, y: restAnchor.y + d.y })
    extent = Math.max(extent, Math.abs(d.x), Math.abs(d.y))
  }

  // A trajectory needs at least two distinct key times and real movement; a lone
  // keyframe (or a rotation/scale-only motion) has no spatial path to draw.
  const hasPath = keyTimes.length >= 2 && extent > 0.01
  return { anchor: restAnchor, points: hasPath ? points : [], keyframes, hasPath }
}
