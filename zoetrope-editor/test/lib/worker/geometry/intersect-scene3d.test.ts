import { describe, expect, it } from 'vitest'
import { overlaps } from '@/lib/worker/geometry/intersect'
import { makeSelrect } from '@/lib/worker/types'
import type { PenpotNode } from 'penpot-exporter/types'

/**
 * Regression: a 3D-scene frame is a transparent-fill rect (the three.js overlay
 * paints over it), so its `fills` array can end up empty after a persistence
 * round-trip. `overlaps()` treats an unfilled rect as *stroke-only* — only the
 * border is hittable and the interior is excluded — which broke click-selection
 * of a scene (marquee still worked, since it passes `usingSelrect: true`). A
 * scene carries a `scene3d` document and is a solid interactive surface, so it
 * must stay interior-hittable.
 */

function strokeOnlyRect(extra: Record<string, unknown> = {}): PenpotNode {
  const x = 200
  const y = 200
  const w = 300
  const h = 300
  return {
    id: 's1',
    type: 'rect',
    x, y, width: w, height: h,
    selrect: makeSelrect(x, y, w, h),
    points: [
      { x, y }, { x: x + w, y },
      { x: x + w, y: y + h }, { x, y: y + h },
    ],
    fills: [], // transparent / stripped fill → stroke-only path
    strokes: [{ strokeColor: '#c3c6d4', strokeOpacity: 1, strokeWidth: 1, strokeAlignment: 'center', strokeStyle: 'solid' }],
    ...extra,
  } as unknown as PenpotNode
}

// A small click rect at the shape's centre (the interior).
const interiorClick = makeSelrect(200 + 150 - 12, 200 + 150 - 12, 24, 24)

describe('overlaps — 3D scene frame is interior-hittable', () => {
  it('an unfilled rect WITHOUT scene3d excludes an interior click (stroke-only, unchanged)', () => {
    // Baseline: this is exactly the behaviour a 3D scene inherited and that broke it.
    expect(overlaps(strokeOnlyRect(), interiorClick, false)).toBe(false)
    // …but a marquee (usingSelrect) still catches it.
    expect(overlaps(strokeOnlyRect(), interiorClick, true)).toBe(true)
  })

  it('an unfilled rect WITH scene3d is hittable on an interior click', () => {
    const scene = strokeOnlyRect({ scene3d: { camera: {}, environment: {}, objects: [] } })
    expect(overlaps(scene, interiorClick, false)).toBe(true)
    expect(overlaps(scene, interiorClick, true)).toBe(true)
  })
})
