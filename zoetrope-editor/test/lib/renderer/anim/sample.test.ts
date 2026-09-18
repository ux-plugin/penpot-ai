import { describe, expect, it } from 'vitest'
import {
  domainValue,
  resolveInterp,
  sampleBinding,
  sampleCurve,
} from '../../../../src/lib/renderer/anim/sample'
import type { Binding, Curve } from '../../../../src/lib/renderer/anim/types'

const timeCurve = (keys: Curve['keys']): Curve => ({ domain: { kind: 'time' }, keys })

describe('sampleCurve', () => {
  it('returns undefined for an empty curve and the value for a single key', () => {
    expect(sampleCurve(timeCurve([]), 100)).toBeUndefined()
    expect(sampleCurve(timeCurve([{ at: 0, value: 42 }]), 999)).toBe(42)
  })

  it('clamps to the first/last key outside the keyed range', () => {
    const c = timeCurve([
      { at: 100, value: 10 },
      { at: 300, value: 30 },
    ])
    expect(sampleCurve(c, 0)).toBe(10)
    expect(sampleCurve(c, 500)).toBe(30)
  })

  it('linearly interpolates inside a segment', () => {
    const c = timeCurve([
      { at: 0, value: 0 },
      { at: 200, value: 100 },
    ])
    expect(sampleCurve(c, 100)).toBeCloseTo(50, 6)
    expect(sampleCurve(c, 50)).toBeCloseTo(25, 6)
  })

  it('picks the correct segment across multiple keys', () => {
    const c = timeCurve([
      { at: 0, value: 0 },
      { at: 100, value: 100 },
      { at: 200, value: 0 },
    ])
    expect(sampleCurve(c, 150)).toBeCloseTo(50, 6)
  })

  it('applies hold (step) easing -- stays on the start value until the next key', () => {
    const c = timeCurve([
      { at: 0, value: 0, interp: 'hold' },
      { at: 100, value: 100 },
    ])
    expect(sampleCurve(c, 50)).toBe(0)
    expect(sampleCurve(c, 99.9)).toBe(0)
    expect(sampleCurve(c, 100)).toBe(100)
  })
})

describe('resolveInterp', () => {
  it('linear is the identity', () => {
    const f = resolveInterp('linear')
    expect(f(0)).toBeCloseTo(0, 6)
    expect(f(0.5)).toBeCloseTo(0.5, 6)
    expect(f(1)).toBeCloseTo(1, 6)
  })

  it('eased curves keep the endpoints and bend the middle', () => {
    const f = resolveInterp('easeOut')
    expect(f(0)).toBeCloseTo(0, 5)
    expect(f(1)).toBeCloseTo(1, 5)
    expect(f(0.5)).toBeGreaterThan(0.5) // easeOut is ahead at the midpoint
  })

  it('accepts explicit cubic-bezier control points', () => {
    const f = resolveInterp([0.42, 0, 0.58, 1]) // easeInOut is symmetric about 0.5
    expect(f(0.5)).toBeCloseTo(0.5, 2)
  })
})

describe('domainValue', () => {
  it('resolves the time domain from the clock', () => {
    expect(domainValue({ kind: 'time' }, { time: 250, params: {} })).toBe(250)
  })

  it('resolves a param domain from the params, defaulting to 0', () => {
    expect(domainValue({ kind: 'param', param: 'speed' }, { time: 0, params: { speed: 0.7 } })).toBe(0.7)
    expect(domainValue({ kind: 'param', param: 'missing' }, { time: 0, params: {} })).toBe(0)
  })
})

describe('sampleBinding', () => {
  const target = { object: { kind: 'node', id: 'n1' }, prop: 'x' } as const

  it('samples a time-domain binding against the clock', () => {
    const b: Binding = {
      target,
      curve: timeCurve([
        { at: 0, value: 0 },
        { at: 100, value: 300 },
      ]),
    }
    expect(sampleBinding(b, { time: 50, params: {} })).toEqual({ target, value: 150 })
  })

  it('samples a param-domain binding against a live parameter (same math, different domain)', () => {
    const b: Binding = {
      target,
      curve: {
        domain: { kind: 'param', param: 'yaw' },
        keys: [
          { at: -1, value: -30 },
          { at: 1, value: 30 },
        ],
      },
    }
    expect(sampleBinding(b, { time: 999, params: { yaw: 0 } })).toEqual({ target, value: 0 })
    expect(sampleBinding(b, { time: 0, params: { yaw: 1 } })).toEqual({ target, value: 30 })
  })

  it('returns undefined when the curve is empty', () => {
    expect(sampleBinding({ target, curve: timeCurve([]) }, { time: 0, params: {} })).toBeUndefined()
  })
})
