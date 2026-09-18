import { describe, expect, it } from 'vitest'
import { buildMotionPath, nearestKeyframeTime } from '../../../../src/lib/renderer/motion/motion-path'
import type { Timeline } from '../../../../src/lib/renderer/anim/types'

/** A rest->end transition on one property (delta 0 at t=0, `end` at `dur`). */
function transition(prop: string, end: number, dur = 1000): Timeline {
  return {
    id: `tl-${prop}`,
    duration: dur,
    bindings: [
      {
        target: { object: { kind: 'node', id: 's1' }, prop },
        curve: { domain: { kind: 'time' }, keys: [{ at: 0, value: 0 }, { at: dur, value: end }] },
      },
    ],
  }
}

// Stable rest anchor (the committed selrect center); the trajectory hangs off it.
const REST = { x: 100, y: 100 }

describe('buildMotionPath', () => {
  it('returns no path for a missing or zero-duration timeline', () => {
    expect(buildMotionPath(undefined, 's1', REST, 0).hasPath).toBe(false)
    const empty: Timeline = { id: 'e', duration: 0, bindings: [] }
    const g = buildMotionPath(empty, 's1', REST, 0)
    expect(g.hasPath).toBe(false)
    expect(g.anchor).toEqual(REST) // anchor still resolved
  })

  it('positions every point as restAnchor + delta(t)', () => {
    const g = buildMotionPath(transition('x', 200), 's1', REST, 0)
    expect(g.hasPath).toBe(true)
    expect(g.anchor).toEqual(REST)
    expect(g.keyframes.map((k) => k.t)).toEqual([0, 1000])
    expect(g.keyframes[0]).toMatchObject({ t: 0, x: 100, y: 100 })
    expect(g.keyframes[1]).toMatchObject({ t: 1000, x: 300, y: 100 })
  })

  it('is independent of the playhead time (anchor stays put)', () => {
    const atStart = buildMotionPath(transition('x', 200), 's1', REST, 0)
    const atEnd = buildMotionPath(transition('x', 200), 's1', REST, 1000)
    expect(atEnd.anchor).toEqual(atStart.anchor)
    expect(atEnd.keyframes).toEqual(atStart.keyframes)
  })

  it('unions x and y key times for the keyframe markers', () => {
    const tl: Timeline = {
      id: 'tl-xy',
      duration: 1000,
      bindings: [
        {
          target: { object: { kind: 'node', id: 's1' }, prop: 'x' },
          curve: { domain: { kind: 'time' }, keys: [{ at: 0, value: 0 }, { at: 1000, value: 200 }] },
        },
        {
          target: { object: { kind: 'node', id: 's1' }, prop: 'y' },
          curve: { domain: { kind: 'time' }, keys: [{ at: 0, value: 0 }, { at: 500, value: 50 }, { at: 1000, value: 0 }] },
        },
      ],
    }
    const g = buildMotionPath(tl, 's1', REST, 0)
    expect(g.keyframes.map((k) => k.t)).toEqual([0, 500, 1000])
    expect(g.keyframes[1]).toMatchObject({ t: 500 })
    expect(g.keyframes[1].y).toBeCloseTo(150, 6) // REST.y 100 + delta 50
  })

  it('treats a rotation-only motion as having no spatial path', () => {
    const g = buildMotionPath(transition('rotation', 90), 's1', REST, 0)
    expect(g.hasPath).toBe(false)
    expect(g.anchor).toEqual(REST)
  })

  it('treats a single position keyframe as having no path', () => {
    const tl: Timeline = {
      id: 'tl-one',
      duration: 1000,
      bindings: [
        {
          target: { object: { kind: 'node', id: 's1' }, prop: 'x' },
          curve: { domain: { kind: 'time' }, keys: [{ at: 500, value: 200 }] },
        },
      ],
    }
    expect(buildMotionPath(tl, 's1', REST, 500).hasPath).toBe(false)
  })

  it('samples a dense polyline spanning the trajectory', () => {
    const g = buildMotionPath(transition('x', 200), 's1', REST, 0, null, {}, 24)
    expect(g.points.length).toBe(25) // n+1 samples
    expect(g.points[0]).toEqual({ x: 100, y: 100 })
    expect(g.points[g.points.length - 1]).toEqual({ x: 300, y: 100 })
    expect(g.points[12].x).toBeCloseTo(200, 6) // midpoint of a linear x-transition
  })

  it('routes the polyline exactly through every keyframe (no corner-cutting)', () => {
    // A corner keyframe at t=350, which is NOT a uniform sample of 10 steps
    // (0,100,...,1000). Before the fix the polyline chord cut the corner and the
    // diamond floated off the line; now t=350 is a vertex, so its point is present.
    const tl: Timeline = {
      id: 'tl-corner',
      duration: 1000,
      bindings: [
        {
          target: { object: { kind: 'node', id: 's1' }, prop: 'x' },
          curve: { domain: { kind: 'time' }, keys: [{ at: 0, value: 0 }, { at: 350, value: 200 }, { at: 1000, value: 200 }] },
        },
        {
          target: { object: { kind: 'node', id: 's1' }, prop: 'y' },
          curve: { domain: { kind: 'time' }, keys: [{ at: 0, value: 0 }, { at: 350, value: 100 }, { at: 1000, value: 0 }] },
        },
      ],
    }
    const g = buildMotionPath(tl, 's1', REST, 0, null, {}, 10)
    for (const k of g.keyframes) {
      const onPath = g.points.some((p) => Math.abs(p.x - k.x) < 1e-6 && Math.abs(p.y - k.y) < 1e-6)
      expect(onPath).toBe(true)
    }
  })

  // --- live drag (livePoint override) ---

  it('a live pose equal to the committed pose leaves the path untouched', () => {
    const committed = buildMotionPath(transition('x', 200), 's1', REST, 1000)
    // livePoint == pose at t=1000 == REST + delta(200) == (300,100)
    const withLive = buildMotionPath(transition('x', 200), 's1', REST, 1000, { x: 300, y: 100 })
    expect(withLive.keyframes).toEqual(committed.keyframes)
  })

  it('a live drag moves ONLY the current keyframe; the rest stay pinned', () => {
    // Drag the end keyframe (t=1000) up-right to (350, 80).
    const g = buildMotionPath(transition('x', 200), 's1', REST, 1000, { x: 350, y: 80 })
    expect(g.keyframes[0]).toMatchObject({ t: 0, x: 100, y: 100 }) // start unchanged
    expect(g.keyframes[1]).toMatchObject({ t: 1000, x: 350, y: 80 }) // end follows the cursor
    expect(g.points[g.points.length - 1]).toEqual({ x: 350, y: 80 }) // path re-flows to it
    expect(g.points[0]).toEqual({ x: 100, y: 100 }) // path start pinned
  })

  // --- snap + selection source of truth (shared by scrub, overlay, timeline) ---

  it('resolves the keyframe the playhead is on, snapping within a scaling tolerance', () => {
    const ks = [0, 500, 1000]
    expect(nearestKeyframeTime(ks, 500, 1000)).toBe(500) // exact (a click seeks here)
    expect(nearestKeyframeTime(ks, 503, 1000)).toBe(500) // near scrub → snaps on
    expect(nearestKeyframeTime(ks, 511, 1000)).toBe(500) // within 1.5% of 1000ms
    expect(nearestKeyframeTime(ks, 520, 1000)).toBe(null) // between keyframes
    expect(nearestKeyframeTime([], 500, 1000)).toBe(null) // no keyframes
  })

  it('picks the single closest keyframe so two near keys never tie', () => {
    expect(nearestKeyframeTime([500, 512], 507, 1000)).toBe(512) // 5ms vs 7ms
    expect(nearestKeyframeTime([500, 512], 505, 1000)).toBe(500)
  })

  it('floors the snap tolerance at 2ms for short clips', () => {
    expect(nearestKeyframeTime([50], 51, 100)).toBe(50)
    expect(nearestKeyframeTime([50], 54, 100)).toBe(null)
  })

  it('bakes the sibling axis so a desynced middle waypoint stays put when dragging the endpoint', () => {
    // x and y have DIFFERENT key times (as after retiming one axis): the t=500
    // waypoint has an x-key but only an interpolated y. Dragging the t=1000
    // endpoint must not move it -- its y is baked before the endpoint is written.
    const tl: Timeline = {
      id: 'tl-desync',
      duration: 1000,
      bindings: [
        {
          target: { object: { kind: 'node', id: 's1' }, prop: 'x' },
          curve: { domain: { kind: 'time' }, keys: [{ at: 0, value: 0 }, { at: 500, value: 100 }, { at: 1000, value: 200 }] },
        },
        {
          target: { object: { kind: 'node', id: 's1' }, prop: 'y' },
          curve: { domain: { kind: 'time' }, keys: [{ at: 0, value: 0 }, { at: 300, value: 60 }, { at: 1000, value: 0 }] },
        },
      ],
    }
    const before = buildMotionPath(tl, 's1', REST, 1000)
    const mid = before.keyframes.find((k) => k.t === 500)!
    expect(mid.x).toBeCloseTo(200, 6) // REST.x 100 + x-delta 100
    expect(mid.y).toBeCloseTo(142.857, 2) // REST.y 100 + interpolated y-delta (60 -> 0 across 300..1000)

    // Drag the endpoint (t=1000) far away.
    const after = buildMotionPath(tl, 's1', REST, 1000, { x: 350, y: 200 })
    const midAfter = after.keyframes.find((k) => k.t === 500)!
    expect(midAfter.x).toBeCloseTo(mid.x, 6) // frozen
    expect(midAfter.y).toBeCloseTo(mid.y, 6) // baked -> frozen (without the bake it drifts to ~171)
    const p300Before = before.keyframes.find((k) => k.t === 300)!
    const p300After = after.keyframes.find((k) => k.t === 300)!
    expect(p300After.x).toBeCloseTo(p300Before.x, 6) // the earlier waypoint is untouched too
    expect(p300After.y).toBeCloseTo(p300Before.y, 6)
    expect(after.keyframes.find((k) => k.t === 1000)!).toMatchObject({ x: 350, y: 200 }) // endpoint follows the cursor
  })

  it('a live drag at a mid time inserts a rubber-band waypoint', () => {
    // Realistic motion: both axes keyed at 0/1000 (as recordDragKeyframe makes),
    // y flat at 0. Playhead between the keys; drag introduces a waypoint at t=500.
    const tl: Timeline = {
      id: 'tl-xy',
      duration: 1000,
      bindings: [
        {
          target: { object: { kind: 'node', id: 's1' }, prop: 'x' },
          curve: { domain: { kind: 'time' }, keys: [{ at: 0, value: 0 }, { at: 1000, value: 200 }] },
        },
        {
          target: { object: { kind: 'node', id: 's1' }, prop: 'y' },
          curve: { domain: { kind: 'time' }, keys: [{ at: 0, value: 0 }, { at: 1000, value: 0 }] },
        },
      ],
    }
    const g = buildMotionPath(tl, 's1', REST, 500, { x: 200, y: 60 })
    expect(g.keyframes.map((k) => k.t)).toEqual([0, 500, 1000])
    expect(g.keyframes[1]).toMatchObject({ t: 500, x: 200, y: 60 }) // waypoint follows cursor
    // endpoints stay pinned
    expect(g.keyframes[0]).toMatchObject({ x: 100, y: 100 })
    expect(g.keyframes[2]).toMatchObject({ x: 300, y: 100 })
  })
})
