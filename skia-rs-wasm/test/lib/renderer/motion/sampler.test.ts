import { describe, expect, it } from 'vitest'
import { blendStates, sampleClip, sampleTrack } from '../../../../src/lib/renderer/motion/sampler'
import { resolveEasing } from '../../../../src/lib/renderer/motion/easing'
import type { Clip, PropertyTrack } from '../../../../src/lib/renderer/motion/types'

describe('resolveEasing', () => {
  it('linear maps progress to itself', () => {
    const e = resolveEasing('linear')
    expect(e(0)).toBeCloseTo(0, 6)
    expect(e(0.5)).toBeCloseTo(0.5, 6)
    expect(e(1)).toBeCloseTo(1, 6)
  })

  it('presets keep endpoints fixed and bias the midpoint', () => {
    expect(resolveEasing('easeIn')(0)).toBeCloseTo(0, 6)
    expect(resolveEasing('easeIn')(1)).toBeCloseTo(1, 6)
    // ease-in is slow at the start → below linear at the midpoint; ease-out above.
    expect(resolveEasing('easeIn')(0.5)).toBeLessThan(0.5)
    expect(resolveEasing('easeOut')(0.5)).toBeGreaterThan(0.5)
    // ease-in-out is symmetric → 0.5 at the midpoint.
    expect(resolveEasing('easeInOut')(0.5)).toBeCloseTo(0.5, 3)
  })
})

describe('sampleTrack', () => {
  const track: PropertyTrack = {
    property: 'x',
    keyframes: [
      { time: 0, value: 0 },
      { time: 1000, value: 100 },
    ],
  }

  it('interpolates linearly between two keyframes', () => {
    expect(sampleTrack(track, 0)).toBeCloseTo(0, 6)
    expect(sampleTrack(track, 500)).toBeCloseTo(50, 6)
    expect(sampleTrack(track, 1000)).toBeCloseTo(100, 6)
  })

  it('clamps before the first and after the last keyframe', () => {
    expect(sampleTrack(track, -200)).toBe(0)
    expect(sampleTrack(track, 5000)).toBe(100)
  })

  it('handles single-keyframe and empty tracks', () => {
    expect(sampleTrack({ property: 'opacity', keyframes: [{ time: 0, value: 0.5 }] }, 999)).toBe(0.5)
    expect(sampleTrack({ property: 'opacity', keyframes: [] }, 0)).toBeUndefined()
  })

  it('applies the segment easing of the starting keyframe', () => {
    const eased: PropertyTrack = {
      property: 'x',
      keyframes: [
        { time: 0, value: 0, easing: 'easeIn' },
        { time: 1000, value: 100 },
      ],
    }
    // ease-in is slow at the start → below the linear 50 at the midpoint.
    expect(sampleTrack(eased, 500)!).toBeLessThan(50)
  })
})

describe('sampleClip', () => {
  const clip: Clip = {
    id: 'c1',
    targetId: 'shape-1',
    duration: 1000,
    tracks: [
      { property: 'x', keyframes: [{ time: 0, value: 0 }, { time: 1000, value: 200 }] },
      { property: 'opacity', keyframes: [{ time: 0, value: 0 }, { time: 500, value: 1 }] },
    ],
  }

  it('merges every track into one property set', () => {
    expect(sampleClip(clip, 0)).toEqual({ x: 0, opacity: 0 })
    const mid = sampleClip(clip, 500)
    expect(mid.x).toBeCloseTo(100, 6)
    expect(mid.opacity).toBeCloseTo(1, 6)
    const end = sampleClip(clip, 1000)
    expect(end.x).toBeCloseTo(200, 6)
    expect(end.opacity).toBeCloseTo(1, 6) // clamped past its last keyframe
  })

  it('clamps non-looping time and wraps looping time', () => {
    expect(sampleClip(clip, 2000).x).toBeCloseTo(200, 6) // clamped
    const looped: Clip = { ...clip, loop: true }
    // t = 1500 wraps to 500 → x = 100
    expect(sampleClip(looped, 1500).x).toBeCloseTo(100, 6)
  })
})

describe('blendStates', () => {
  it('interpolates shared properties and passes the rest through', () => {
    const mid = blendStates({ x: 0, opacity: 1 }, { x: 100, rotation: 90 }, 0.5)
    expect(mid.x).toBeCloseTo(50, 6)
    expect(mid.rotation).toBe(90) // only in `to`
    expect(mid.opacity).toBe(1) // only in `from`
  })
})
