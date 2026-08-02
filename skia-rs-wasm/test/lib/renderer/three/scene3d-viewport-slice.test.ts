/**
 * Viewport-clipped baking: rendering only the on-screen slice of a placed 3D scene.
 *
 * The property that matters is that clipping is INVISIBLE. A slice render must put every
 * point of the scene exactly where a whole-node render would have — same place, same size,
 * both axes independently. Anything else is the elongation that kept this behind a flag:
 * the old clip framed the camera on the NODE's aspect while the normal path framed the
 * reference frustum, so the two disagreed for every scene whose window wasn't canonical.
 *
 * The second property is that quantisation only ever ADDS coverage. A pan may reuse a
 * rendered region only if that region genuinely contains the new view; a superset is free,
 * a subset is a hole.
 */
import { describe, expect, it } from 'vitest'
import {
  defaultWindow,
  narrowPlanToSlice,
  quantiseSlice,
  rectCovers,
  viewPlan,
  type BoxRect,
  type CropPlan,
} from '../../../../src/lib/renderer/three/scene3d-viewframe'

const BOX = { w: 360, h: 260 }

/** Where a point of the reference frustum lands in the box, given a plan and its dest. */
function place(plan: CropPlan, dest: BoxRect, u: number, v: number): { x: number; y: number } {
  return {
    x: dest.x + ((u - plan.offX) / plan.subW) * dest.w,
    y: dest.y + ((v - plan.offY) / plan.subH) * dest.h,
  }
}

/** The dest of an un-narrowed plan: the rect the window is actually drawn into. */
function fullDest(plan: CropPlan, boxW: number, boxH: number): BoxRect {
  return { x: plan.fx * boxW, y: plan.fy * boxH, w: plan.fw * boxW, h: plan.fh * boxH }
}

const whole = (win = defaultWindow(BOX.w, BOX.h)) => viewPlan(win, BOX.w, BOX.h)!

describe('a sliced render draws the same picture as a whole-node render', () => {
  const cases: Array<[string, CropPlan]> = [
    ['canonical window', whole()],
    ['cropped window', whole({ x: 0.1, y: 0.2, w: 0.5, h: 0.36 })],
    ['scaled window, letterboxed', whole({ x: -0.2, y: 0, w: 1.4, h: 1 })],
  ]

  for (const [name, plan] of cases) {
    it(`places every point where the full render would — ${name}`, () => {
      const dest0 = fullDest(plan, BOX.w, BOX.h)
      // Off-centre on both axes, so an error in either shows up.
      const n = narrowPlanToSlice(plan, BOX.w, BOX.h, { x: 120, y: 40, w: 150, h: 90 })!
      expect(n).not.toBeNull()

      for (const [u, v] of [
        [plan.offX + plan.subW * 0.3, plan.offY + plan.subH * 0.25],
        [plan.offX + plan.subW * 0.6, plan.offY + plan.subH * 0.5],
        [plan.offX + plan.subW * 0.45, plan.offY + plan.subH * 0.7],
      ]) {
        const full = place(plan, dest0, u, v)
        const sliced = place(n.plan, n.dest, u, v)
        expect(sliced.x).toBeCloseTo(full.x, 6)
        expect(sliced.y).toBeCloseTo(full.y, 6)
      }
    })
  }

  it('keeps the scene the same SIZE, not merely the same position', () => {
    const plan = whole({ x: 0.1, y: 0.2, w: 0.5, h: 0.36 })
    const dest0 = fullDest(plan, BOX.w, BOX.h)
    const n = narrowPlanToSlice(plan, BOX.w, BOX.h, { x: 100, y: 30, w: 120, h: 140 })!
    // A window-space step must span the same box distance either way; an aspect error
    // would stretch one axis relative to the other.
    const d = 0.05
    const a0 = place(plan, dest0, plan.offX + 0.2, plan.offY + 0.2)
    const b0 = place(plan, dest0, plan.offX + 0.2 + d * plan.subW, plan.offY + 0.2 + d * plan.subH)
    const a1 = place(n.plan, n.dest, plan.offX + 0.2, plan.offY + 0.2)
    const b1 = place(n.plan, n.dest, plan.offX + 0.2 + d * plan.subW, plan.offY + 0.2 + d * plan.subH)
    expect(b1.x - a1.x).toBeCloseTo(b0.x - a0.x, 6)
    expect(b1.y - a1.y).toBeCloseTo(b0.y - a0.y, 6)
  })
})

describe('the slice', () => {
  it('is a no-op when the whole box is on screen', () => {
    const plan = whole()
    const n = narrowPlanToSlice(plan, BOX.w, BOX.h, { x: 0, y: 0, w: BOX.w, h: BOX.h })!
    expect(n.plan.offX).toBeCloseTo(plan.offX, 9)
    expect(n.plan.subW).toBeCloseTo(plan.subW, 9)
    expect(n.plan.subH).toBeCloseTo(plan.subH, 9)
    expect(n.dest).toEqual({ x: 0, y: 0, w: BOX.w, h: BOX.h })
  })

  it('takes half the window for half the box', () => {
    const plan = whole()
    const n = narrowPlanToSlice(plan, BOX.w, BOX.h, { x: 0, y: 0, w: BOX.w / 2, h: BOX.h })!
    expect(n.plan.subW).toBeCloseTo(plan.subW / 2, 9)
    expect(n.plan.offX).toBeCloseTo(plan.offX, 9)
    expect(n.plan.subH).toBeCloseTo(plan.subH, 9)
  })

  it('fills its whole render target — no letterbox left unused', () => {
    const n = narrowPlanToSlice(whole(), BOX.w, BOX.h, { x: 40, y: 20, w: 90, h: 70 })!
    expect([n.plan.fx, n.plan.fy, n.plan.fw, n.plan.fh]).toEqual([0, 0, 1, 1])
  })

  it('clamps to what is DRAWN, not to the box, when the window is letterboxed', () => {
    const plan = whole({ x: -0.2, y: 0, w: 1.4, h: 1 })
    expect(plan.fh).toBeLessThan(1)
    const n = narrowPlanToSlice(plan, BOX.w, BOX.h, { x: 0, y: 0, w: BOX.w, h: BOX.h })!
    expect(n.dest.y).toBeCloseTo(plan.fy * BOX.h, 6)
    expect(n.dest.h).toBeCloseTo(plan.fh * BOX.h, 6)
    expect(n.dest.h).toBeLessThan(BOX.h)
  })

  it('returns null when the slice misses what is drawn', () => {
    const plan = whole({ x: -0.2, y: 0, w: 1.4, h: 1 })
    // Inside the box, but wholly within the empty band above the render.
    expect(narrowPlanToSlice(plan, BOX.w, BOX.h, { x: 0, y: 0, w: BOX.w, h: 1 })).toBeNull()
    expect(narrowPlanToSlice(whole(), BOX.w, BOX.h, { x: BOX.w + 10, y: 0, w: 50, h: 50 })).toBeNull()
  })

  it('rejects degenerate input rather than emitting a bad view offset', () => {
    expect(narrowPlanToSlice(whole(), 0, BOX.h, { x: 0, y: 0, w: 10, h: 10 })).toBeNull()
    expect(narrowPlanToSlice(whole(), BOX.w, BOX.h, { x: 10, y: 10, w: 0, h: 10 })).toBeNull()
  })
})

describe('quantisation', () => {
  const cell = 50

  it('only ever grows the region — never crops what was visible', () => {
    for (const s of [
      { x: 3, y: 7, w: 40, h: 40 },
      { x: 51, y: 99, w: 120, h: 30 },
      { x: 0, y: 0, w: 360, h: 260 },
      { x: 199, y: 1, w: 2, h: 2 },
    ]) {
      expect(rectCovers(quantiseSlice(s, BOX.w, BOX.h, cell), s)).toBe(true)
    }
  })

  it('lands on the grid and stays inside the box', () => {
    const q = quantiseSlice({ x: 63, y: 141, w: 90, h: 40 }, BOX.w, BOX.h, cell)
    expect(q.x % cell).toBe(0)
    expect(q.y % cell).toBe(0)
    expect(q.x).toBeGreaterThanOrEqual(0)
    expect(q.x + q.w).toBeLessThanOrEqual(BOX.w)
    expect(q.y + q.h).toBeLessThanOrEqual(BOX.h)
  })

  it('gives the same region for any view inside one cell — this is what makes panning free', () => {
    const a = quantiseSlice({ x: 52, y: 52, w: 40, h: 40 }, BOX.w, BOX.h, cell)
    expect(quantiseSlice({ x: 58, y: 55, w: 40, h: 40 }, BOX.w, BOX.h, cell)).toEqual(a)
    // Cross the boundary and it must move, still covering the new view.
    const c = quantiseSlice({ x: 62, y: 55, w: 40, h: 40 }, BOX.w, BOX.h, cell)
    expect(c).not.toEqual(a)
    expect(rectCovers(c, { x: 62, y: 55, w: 40, h: 40 })).toBe(true)
  })

  it('holds a rendered region until the view escapes it', () => {
    const rendered = quantiseSlice({ x: 52, y: 52, w: 40, h: 40 }, BOX.w, BOX.h, cell)
    expect(rectCovers(rendered, { x: 55, y: 60, w: 40, h: 30 })).toBe(true) // reuse
    expect(rectCovers(rendered, { x: 55, y: 60, w: 90, h: 30 })).toBe(false) // re-render
    expect(rectCovers(null, { x: 0, y: 0, w: 1, h: 1 })).toBe(false)
  })

  it('passes the slice through unchanged for a nonsense cell', () => {
    const s = { x: 3, y: 7, w: 40, h: 40 }
    expect(quantiseSlice(s, BOX.w, BOX.h, 0)).toEqual(s)
    expect(quantiseSlice(s, BOX.w, BOX.h, Number.NaN)).toEqual(s)
  })
})
