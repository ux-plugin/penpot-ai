import { describe, expect, it } from 'vitest'
import { fitViewportToRect } from '@/lib/renderer/three/scene3d-recenter'

describe('fitViewportToRect', () => {
  it('centres the rect in the canvas (rect centre → canvas centre)', () => {
    const cw = 800
    const ch = 600
    const rect = { cx: 100, cy: 50, w: 40, h: 30 }
    const vp = fitViewportToRect(rect, cw, ch, { padding: 1, maxZoom: 100 })
    // worldToScreen: (world - pan) * zoom
    expect((rect.cx - vp.panX) * vp.zoom).toBeCloseTo(cw / 2, 6)
    expect((rect.cy - vp.panY) * vp.zoom).toBeCloseTo(ch / 2, 6)
  })

  it('fits with padding when the rect is smaller than the viewport', () => {
    const vp = fitViewportToRect({ cx: 0, cy: 0, w: 100, h: 100 }, 400, 400, {
      padding: 1.25,
      maxZoom: 100,
    })
    expect(vp.zoom).toBeCloseTo(3.2, 5) // 400 / (100 * 1.25)
  })

  it('caps zoom-in on a tiny scene at maxZoom (recenter never blows it up)', () => {
    const vp = fitViewportToRect({ cx: 0, cy: 0, w: 1, h: 1 }, 800, 600, { maxZoom: 2 })
    expect(vp.zoom).toBe(2)
  })

  it('clamps a degenerate (zero-size) rect to a safe positive zoom', () => {
    const vp = fitViewportToRect({ cx: 0, cy: 0, w: 0, h: 0 }, 800, 600, { maxZoom: 2 })
    expect(vp.zoom).toBeGreaterThan(0)
    expect(vp.zoom).toBe(2)
  })
})
