import { afterEach, describe, expect, it } from 'vitest'
import { inspectorTab } from '../../../../src/lib/renderer/signals/inspector-tab'
import {
  motionShapes,
  motionAnimatedMatrix,
  motionTime,
  recordDragKeyframe,
  recordRotateKeyframe,
  setMotionShapes,
} from '../../../../src/lib/renderer/motion/motion-store'
import { setKeyframe, type ShapeMotion } from '../../../../src/lib/renderer/motion/edit'

/** The keys of a shape's (property) track, for terse assertions. */
function keysOf(targetId: string, property: 'x' | 'y' | 'rotation') {
  return motionShapes.value
    .find((s) => s.targetId === targetId)
    ?.timeline.bindings.find((b) => b.target.prop === property)?.curve.keys
}

afterEach(() => {
  setMotionShapes([])
  inspectorTab.value = 'parameters'
  motionTime.value = 0
})

describe('recordDragKeyframe', () => {
  it('turns a drag off the rest frame into x/y keyframes plus a rest anchor', () => {
    inspectorTab.value = 'motion'
    motionTime.value = 500
    const handled = recordDragKeyframe('s1', 40, -10)
    expect(handled).toBe(true)
    expect(keysOf('s1', 'x')).toEqual([
      { at: 0, value: 0 },
      { at: 500, value: 40 },
    ])
    expect(keysOf('s1', 'y')).toEqual([
      { at: 0, value: 0 },
      { at: 500, value: -10 },
    ])
  })

  it('adds the drag onto the existing delta at that time', () => {
    inspectorTab.value = 'motion'
    motionTime.value = 500
    recordDragKeyframe('s1', 40, 0)
    recordDragKeyframe('s1', 10, 0) // same time -> 40 + 10
    expect(keysOf('s1', 'x')).toEqual([
      { at: 0, value: 0 },
      { at: 500, value: 50 },
    ])
  })

  it('does not author on the rest frame (a drag there edits the home pose)', () => {
    inspectorTab.value = 'motion'
    motionTime.value = 0
    expect(recordDragKeyframe('s1', 40, -10)).toBe(false)
    expect(motionShapes.value).toEqual([])
  })

  it('does not author when the Motion tab is not active', () => {
    inspectorTab.value = 'parameters'
    motionTime.value = 500
    expect(recordDragKeyframe('s1', 40, -10)).toBe(false)
    expect(motionShapes.value).toEqual([])
  })

  it('bakes the sibling axis when authoring on a desynced timeline (keeps distant segments still)', () => {
    // x keyed at 0/500/1000, y keyed at 0/300/1000 (a retimed, desynced pair).
    let shapes: ShapeMotion[] = []
    shapes = setKeyframe(shapes, 's1', 'x', 0, 0)
    shapes = setKeyframe(shapes, 's1', 'x', 500, 100)
    shapes = setKeyframe(shapes, 's1', 'x', 1000, 200)
    shapes = setKeyframe(shapes, 's1', 'y', 0, 0)
    shapes = setKeyframe(shapes, 's1', 'y', 300, 60)
    shapes = setKeyframe(shapes, 's1', 'y', 1000, 0)
    setMotionShapes(shapes)

    inspectorTab.value = 'motion'
    motionTime.value = 1000
    // Drag the endpoint (existing delta 200/0) by 150/200 -> new endpoint delta 350/200.
    expect(recordDragKeyframe('s1', 150, 200)).toBe(true)

    // y gains a baked key at 500 (the previous interpolated value ~42.857) so the
    // t=500 waypoint stays put; the endpoint at 1000 moved to 200.
    const yKeys = keysOf('s1', 'y')!
    expect(yKeys.map((k) => k.at)).toEqual([0, 300, 500, 1000])
    expect(yKeys.find((k) => k.at === 500)!.value).toBeCloseTo(42.857, 2)
    expect(yKeys.find((k) => k.at === 1000)!.value).toBe(200)
    // x already had a key at 500, so it is untouched; the endpoint updated to 350.
    expect(keysOf('s1', 'x')!.map((k) => k.at)).toEqual([0, 500, 1000])
    expect(keysOf('s1', 'x')!.find((k) => k.at === 1000)!.value).toBe(350)
  })
})

describe('recordRotateKeyframe', () => {
  it('turns a rotation drag off the rest frame into a rotation keyframe plus a rest anchor', () => {
    inspectorTab.value = 'motion'
    motionTime.value = 500
    expect(recordRotateKeyframe('s1', 30)).toBe(true)
    expect(keysOf('s1', 'rotation')).toEqual([
      { at: 0, value: 0 },
      { at: 500, value: 30 },
    ])
  })

  it('adds the drag onto the existing rotation delta at that time', () => {
    inspectorTab.value = 'motion'
    motionTime.value = 500
    recordRotateKeyframe('s1', 30)
    recordRotateKeyframe('s1', 15) // same time -> 30 + 15
    expect(keysOf('s1', 'rotation')).toEqual([
      { at: 0, value: 0 },
      { at: 500, value: 45 },
    ])
  })

  it('does not author on the rest frame or when the Motion tab is inactive', () => {
    inspectorTab.value = 'motion'
    motionTime.value = 0
    expect(recordRotateKeyframe('s1', 30)).toBe(false)
    inspectorTab.value = 'parameters'
    motionTime.value = 500
    expect(recordRotateKeyframe('s1', 30)).toBe(false)
    expect(motionShapes.value).toEqual([])
  })
})

describe('motionAnimatedMatrix', () => {
  it('returns the drawn matrix M(t) at the playhead while authoring off rest', () => {
    inspectorTab.value = 'motion'
    motionTime.value = 500
    recordDragKeyframe('s1', 40, -10)
    const m = motionAnimatedMatrix('s1')!
    expect(m).not.toBeNull()
    expect(m.e).toBeCloseTo(40, 6)
    expect(m.f).toBeCloseTo(-10, 6)
  })

  it('carries the animated SCALE, so a drag can compose over it instead of wiping it', () => {
    // A scale keyframe (delta +1 -> 2x) plus a translation at the same time.
    setMotionShapes(setKeyframe(setKeyframe([], 's1', 'scaleX', 500, 1), 's1', 'scaleY', 500, 1))
    inspectorTab.value = 'motion'
    motionTime.value = 500
    recordDragKeyframe('s1', 40, -10)
    const m = motionAnimatedMatrix('s1')!
    // This is the whole point of the fix: the matrix a drag composes onto still
    // scales 2x, so the shape keeps its animated size for the duration of the drag.
    expect(m.a).toBeCloseTo(2, 6)
    expect(m.d).toBeCloseTo(2, 6)
  })

  it('is null on the rest frame (a gesture there edits the home pose)', () => {
    inspectorTab.value = 'motion'
    motionTime.value = 0
    expect(motionAnimatedMatrix('s1')).toBeNull()
  })

  it('is null when the Motion tab is not active', () => {
    inspectorTab.value = 'parameters'
    motionTime.value = 500
    expect(motionAnimatedMatrix('s1')).toBeNull()
  })
})
