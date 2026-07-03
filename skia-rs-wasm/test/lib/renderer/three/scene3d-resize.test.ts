import { describe, expect, it } from 'vitest'
import { applyResize, RESIZE_MIN } from '@/lib/renderer/three/scene3d-resize'

const start = { x: 0, y: 0, w: 100, h: 100 }

describe('applyResize', () => {
  it('east handle grows width, keeps the origin (ignores dy)', () => {
    expect(applyResize('e', start, 20, 999)).toEqual({ x: 0, y: 0, w: 120, h: 100 })
  })

  it('west handle moves the origin and shrinks width (anchors the right edge)', () => {
    expect(applyResize('w', start, 20, 0)).toEqual({ x: 20, y: 0, w: 80, h: 100 })
  })

  it('southeast corner grows both axes', () => {
    expect(applyResize('se', start, 10, 30)).toEqual({ x: 0, y: 0, w: 110, h: 130 })
  })

  it('northwest corner moves the origin and shrinks both axes', () => {
    expect(applyResize('nw', start, 10, 10)).toEqual({ x: 10, y: 10, w: 90, h: 90 })
  })

  it('clamps to a minimum without inverting (east)', () => {
    expect(applyResize('e', start, -500, 0)).toEqual({ x: 0, y: 0, w: RESIZE_MIN, h: 100 })
  })

  it('clamps a west over-drag and pins the far (right) edge in place', () => {
    const r = applyResize('w', start, 500, 0)
    expect(r.w).toBe(RESIZE_MIN)
    expect(r.x + r.w).toBe(100) // right edge unchanged
  })
})
