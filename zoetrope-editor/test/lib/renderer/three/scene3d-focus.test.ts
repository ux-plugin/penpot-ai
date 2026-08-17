import { beforeEach, describe, expect, it } from 'vitest'
import {
  editPlacement,
  focusDim,
  reveal,
  toggleFocus,
  exitFocus,
  effectiveDim,
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
})
