import { beforeEach, describe, expect, it } from 'vitest'
import {
  editPlacement,
  focusDim,
  reveal,
  toggleFocus,
  exitFocus,
  effectiveDim,
  focusRegion,
} from '@/lib/renderer/three/scene3d-focus'

beforeEach(() => {
  editPlacement.value = 'in-place'
  focusDim.value = 0.4
  reveal.value = false
})

describe('scene3d-focus', () => {
  it('toggleFocus flips placement; exitFocus forces in-place', () => {
    toggleFocus()
    expect(editPlacement.value).toBe('focus')
    toggleFocus()
    expect(editPlacement.value).toBe('in-place')
    toggleFocus()
    exitFocus()
    expect(editPlacement.value).toBe('in-place')
  })

  it('effectiveDim is the focus dim, or 0 while the sampler is revealing', () => {
    focusDim.value = 0.5
    expect(effectiveDim()).toBe(0.5)
    reveal.value = true
    expect(effectiveDim()).toBe(0)
  })

  it('focusRegion is centred with proportional margins', () => {
    const r = focusRegion(1000, 800)
    expect(r).toEqual({ x: 120, y: 80, w: 760, h: 640 })
    expect(r.x + r.w / 2).toBeCloseTo(500) // horizontally centred
    expect(r.y + r.h / 2).toBeCloseTo(400) // vertically centred
  })
})
