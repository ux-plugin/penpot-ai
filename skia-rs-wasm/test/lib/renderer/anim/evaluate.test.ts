import { describe, expect, it } from 'vitest'
import { evaluateTimeline, evaluateWrites, normalizeTime } from '../../../../src/lib/renderer/anim/evaluate'
import type { Binding, Timeline } from '../../../../src/lib/renderer/anim/types'

const timeBinding = (nodeId: string, prop: string, keys: Binding['curve']['keys']): Binding => ({
  target: { object: { kind: 'node', id: nodeId }, prop },
  curve: { domain: { kind: 'time' }, keys },
})

const timeline = (bindings: Binding[], extra: Partial<Timeline> = {}): Timeline => ({
  id: 't',
  duration: 1000,
  bindings,
  ...extra,
})

describe('normalizeTime', () => {
  it('clamps to [0, duration] when not looping', () => {
    expect(normalizeTime(-50, 1000)).toBe(0)
    expect(normalizeTime(400, 1000)).toBe(400)
    expect(normalizeTime(2000, 1000)).toBe(1000)
  })

  it('wraps modulo duration when looping (including negatives)', () => {
    expect(normalizeTime(1500, 1000, true)).toBe(500)
    expect(normalizeTime(-250, 1000, true)).toBe(750)
  })

  it('returns 0 for a zero/negative duration', () => {
    expect(normalizeTime(500, 0)).toBe(0)
  })
})

describe('evaluateTimeline', () => {
  it('folds a node`s bindings into one property bag', () => {
    const tl = timeline([
      timeBinding('n1', 'x', [
        { at: 0, value: 0 },
        { at: 1000, value: 200 },
      ]),
      timeBinding('n1', 'opacity', [
        { at: 0, value: 0 },
        { at: 1000, value: 1 },
      ]),
    ])
    expect(evaluateTimeline(tl, { time: 0, params: {} }).get('n1')).toEqual({ x: 0, opacity: 0 })
    expect(evaluateTimeline(tl, { time: 500, params: {} }).get('n1')).toEqual({ x: 100, opacity: 0.5 })
    expect(evaluateTimeline(tl, { time: 1000, params: {} }).get('n1')).toEqual({ x: 200, opacity: 1 })
  })

  it('clamps past the end and wraps when looping', () => {
    const keys = [
      { at: 0, value: 0 },
      { at: 1000, value: 100 },
    ]
    const clamp = timeline([timeBinding('n1', 'x', keys)])
    expect(evaluateTimeline(clamp, { time: 2000, params: {} }).get('n1')).toEqual({ x: 100 })

    const looped = timeline([timeBinding('n1', 'x', keys)], { loop: true })
    expect(evaluateTimeline(looped, { time: 1500, params: {} }).get('n1')!.x).toBeCloseTo(50, 6)
  })

  it('separates writes for distinct nodes in one timeline', () => {
    const tl = timeline([
      timeBinding('a', 'x', [{ at: 0, value: 10 }]),
      timeBinding('b', 'y', [{ at: 0, value: 20 }]),
    ])
    const out = evaluateTimeline(tl, { time: 0, params: {} })
    expect(out.get('a')).toEqual({ x: 10 })
    expect(out.get('b')).toEqual({ y: 20 })
  })

  it('omits a node whose only binding has an empty curve', () => {
    const tl = timeline([timeBinding('n1', 'x', [])])
    expect(evaluateTimeline(tl, { time: 0, params: {} }).has('n1')).toBe(false)
  })

  it('drives a property from a live parameter -- same evaluator, param domain', () => {
    // The A3 pre-proof: a param-domain binding responds to ctx.params, not time.
    const paramBinding: Binding = {
      target: { object: { kind: 'node', id: 'n1' }, prop: 'rotation' },
      curve: {
        domain: { kind: 'param', param: 'yaw' },
        keys: [
          { at: -1, value: -30 },
          { at: 1, value: 30 },
        ],
      },
    }
    const tl = timeline([paramBinding])
    // time is irrelevant; the parameter drives it.
    expect(evaluateTimeline(tl, { time: 9999, params: { yaw: 0 } }).get('n1')).toEqual({ rotation: 0 })
    expect(evaluateTimeline(tl, { time: 0, params: { yaw: 1 } }).get('n1')).toEqual({ rotation: 30 })
  })

  it('evaluates time- and param-domain bindings together on one node', () => {
    const tl = timeline([
      timeBinding('n1', 'x', [
        { at: 0, value: 0 },
        { at: 1000, value: 100 },
      ]),
      {
        target: { object: { kind: 'node', id: 'n1' }, prop: 'opacity' },
        curve: { domain: { kind: 'param', param: 'fade' }, keys: [{ at: 0, value: 0.25 }] },
      },
    ])
    expect(evaluateTimeline(tl, { time: 500, params: { fade: 0.9 } }).get('n1')).toEqual({ x: 50, opacity: 0.25 })
  })
})

describe('evaluateWrites', () => {
  it('returns the flat write list including non-node targets', () => {
    const tl = timeline([
      timeBinding('n1', 'x', [{ at: 0, value: 5 }]),
      {
        target: { object: { kind: 'bone', id: 'arm' }, prop: 'rotation' },
        curve: { domain: { kind: 'time' }, keys: [{ at: 0, value: 45 }] },
      },
    ])
    const writes = evaluateWrites(tl, { time: 0, params: {} })
    expect(writes).toHaveLength(2)
    expect(writes.map((w) => w.target.object.kind)).toEqual(['node', 'bone'])
  })

  it('skips bone/param targets in the node fold', () => {
    const tl = timeline([
      {
        target: { object: { kind: 'bone', id: 'arm' }, prop: 'rotation' },
        curve: { domain: { kind: 'time' }, keys: [{ at: 0, value: 45 }] },
      },
    ])
    expect(evaluateTimeline(tl, { time: 0, params: {} }).size).toBe(0)
  })
})
