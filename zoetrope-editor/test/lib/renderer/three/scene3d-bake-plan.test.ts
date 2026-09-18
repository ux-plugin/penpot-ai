/**
 * The bake POLICY, driven end-to-end without a WebGL context.
 *
 * `planSliceBake` is the whole decision — whole-node vs slice, quantisation, hysteresis,
 * target sizing, the cap — as a pure function, so these tests exercise the real code path
 * the renderer runs rather than a restatement of it. The geometry it leans on is covered
 * separately in scene3d-viewport-slice.test.ts.
 *
 * The claim under test is the one the feature exists for: `texelsPerPx` stays at ~1 however
 * far the canvas is zoomed, instead of falling away once the node outgrows the cap.
 */
import { describe, expect, it } from 'vitest'
import {
  planSliceBake,
  bakeTargetSize,
  type BakePlan,
  type VisibleWorld,
} from '../../../../src/lib/renderer/three/scene3d-bake'
import { rectCovers, type BoxRect } from '../../../../src/lib/renderer/three/scene3d-viewframe'

const DPR = 2
const MAX_PX = 4096
const SCREEN = { w: 1400, h: 900 } // css px

/** Quantising snaps outward on BOTH edges, so a region can exceed the view by a whole cell
 *  per edge — two per axis. That slack is the price of making a pan cheap, and it is what
 *  bounds the render target's overshoot. */
const SLACK = 2 * 512

/** The viewport in doc coords, centred on a point, at a zoom. */
function viewportAt(cx: number, cy: number, zoom: number): VisibleWorld {
  const hw = SCREEN.w / zoom / 2
  const hh = SCREEN.h / zoom / 2
  return { left: cx - hw, top: cy - hh, right: cx + hw, bottom: cy + hh }
}

function plan(
  box: BoxRect,
  zoom: number,
  visible: VisibleWorld | null,
  held: BoxRect | null = null,
  quantum = 512,
  heldZoom: number | null = zoom, // held regions come from the same zoom unless a test says otherwise
): BakePlan | null {
  return planSliceBake({ box, zoom, dpr: DPR, visible, crop: null, held, heldZoom, quantum, maxPx: MAX_PX })
}

const baked = (p: BakePlan | null) => {
  expect(p?.kind).toBe('bake')
  return p as Extract<BakePlan, { kind: 'bake' }>
}

/** Rendered texels per device pixel of the region actually drawn. 1 = no magnification. */
function texelsPerPx(p: Extract<BakePlan, { kind: 'bake' }>, box: BoxRect, zoom: number): number {
  const destW = p.dest ? p.dest[2] - p.dest[0] : box.w
  return p.w / (destW * zoom * DPR)
}

describe('resolution holds up as the canvas zooms', () => {
  const box = { x: 0, y: 0, w: 324, h: 360 }

  it('magnifies badly on the WHOLE-NODE path (no viewport) — the behaviour clipping replaces', () => {
    const p = baked(
      planSliceBake({ box, zoom: 46, dpr: DPR, visible: null, crop: null, held: null, quantum: 512, maxPx: MAX_PX }),
    )
    // The whole node wants 324×46×2 ≈ 29,800px and gets capped at 4096.
    expect(Math.max(p.w, p.h)).toBe(MAX_PX)
    expect(texelsPerPx(p, box, 46)).toBeLessThan(0.2)
  })

  it('stays ~1:1 at every zoom WITH clipping', () => {
    for (const zoom of [3, 8, 20, 46, 100]) {
      const p = baked(plan(box, zoom, viewportAt(162, 180, zoom)))
      expect(texelsPerPx(p, box, zoom)).toBeGreaterThan(0.9)
      expect(texelsPerPx(p, box, zoom)).toBeLessThan(1.1)
    }
  })

  it('never asks for more than the screen needs, plus the quantisation margin', () => {
    for (const zoom of [8, 20, 46, 100]) {
      const p = baked(plan(box, zoom, viewportAt(162, 180, zoom)))
      expect(p.w).toBeLessThanOrEqual(SCREEN.w * DPR + SLACK)
      expect(p.h).toBeLessThanOrEqual(SCREEN.h * DPR + SLACK)
    }
  })

  it('uses the whole node while it still fits on screen', () => {
    const p = baked(plan(box, 1, viewportAt(162, 180, 1)))
    expect(p.dest).toBeNull() // whole-node fill, so a pan costs nothing
    expect(p.slice).toBeNull()
  })
})

describe('panning', () => {
  const box = { x: 0, y: 0, w: 324, h: 360 }
  const zoom = 20

  it('reuses the rendered region until the view leaves it', () => {
    const first = baked(plan(box, zoom, viewportAt(100, 180, zoom)))
    expect(first.slice).not.toBeNull()

    // A nudge well inside the same cell: same region, so nothing re-renders.
    const nudged = baked(plan(box, zoom, viewportAt(100.4, 180, zoom), first.slice))
    expect(nudged.slice).toEqual(first.slice)
    expect(nudged.dest).toEqual(first.dest)

    // Far enough to leave it: a new region, still 1:1.
    const moved = baked(plan(box, zoom, viewportAt(260, 180, zoom), first.slice))
    expect(moved.slice).not.toEqual(first.slice)
    expect(texelsPerPx(moved, box, zoom)).toBeGreaterThan(0.9)
  })

  it('counts far fewer re-renders across a drag than one per frame', () => {
    let held: BoxRect | null = null
    let renders = 0
    const frames = 120
    for (let i = 0; i < frames; i++) {
      const p = baked(plan(box, zoom, viewportAt(60 + i * 1.5, 180, zoom), held))
      if (JSON.stringify(p.slice) !== JSON.stringify(held)) {
        renders++
        held = p.slice
      }
    }
    expect(renders).toBeLessThan(frames / 4)
    expect(renders).toBeGreaterThan(0) // it does still follow the view
  })

  it('drops a held region that no longer covers the view', () => {
    const stale: BoxRect = { x: 0, y: 0, w: 20, h: 20 }
    const p = baked(plan(box, zoom, viewportAt(200, 180, zoom), stale))
    expect(p.slice).not.toEqual(stale)
  })

  it('renders exactly the visible region with the grid disabled', () => {
    // quantum 0 is the A/B: no slack, no reuse, one render per frame.
    const a = baked(plan(box, zoom, viewportAt(100, 180, zoom), null, 0))
    const b = baked(plan(box, zoom, viewportAt(100.4, 180, zoom), a.slice, 0))
    expect(b.slice).not.toEqual(a.slice) // the view moved, so the region moved
    expect(texelsPerPx(b, box, zoom)).toBeGreaterThan(0.9)
  })

  it('does far fewer renders WITH the grid than without, over the same drag', () => {
    const count = (quantum: number) => {
      let held: BoxRect | null = null
      let renders = 0
      for (let i = 0; i < 120; i++) {
        const p = baked(plan(box, zoom, viewportAt(60 + i * 1.5, 180, zoom), held, quantum))
        if (JSON.stringify(p.slice) !== JSON.stringify(held)) {
          renders++
          held = p.slice
        }
      }
      return renders
    }
    expect(count(0)).toBe(120) // every frame
    expect(count(512)).toBeLessThan(count(0) / 4)
  })
})

describe('zooming while a region is held', () => {
  const box = { x: 0, y: 0, w: 324, h: 360 }
  const octaves = [10, 14, 20, 28, 40, 56, 80, 110]

  it('does not carry a held region across a zoom — that is what reintroduces magnification', () => {
    // Covering the view is NOT enough to justify reuse. Zooming in shrinks the view, so a
    // region captured while zoomed out keeps covering it indefinitely while the pixels it
    // needs grow past the cap. Before the zoom gate this decayed 1.01 → 0.10 texels/px.
    let held: BoxRect | null = null
    let heldZoom: number | null = null
    for (const zoom of octaves) {
      const p = baked(plan(box, zoom, viewportAt(162, 180, zoom), held, 512, heldZoom))
      expect(texelsPerPx(p, box, zoom)).toBeGreaterThan(0.9)
      expect(Math.max(p.w, p.h)).toBeLessThan(MAX_PX) // never pinned to the cap
      held = p.slice
      heldZoom = zoom
    }
  })

  it('still reuses when the zoom is unchanged, so a pan is unaffected', () => {
    const zoom = 20
    const first = baked(plan(box, zoom, viewportAt(100, 180, zoom)))
    const nudged = baked(plan(box, zoom, viewportAt(100.4, 180, zoom), first.slice, 512, zoom))
    expect(nudged.slice).toEqual(first.slice)
    // A region held from a lower zoom is ignored: the answer is whatever this zoom would
    // have produced from scratch, not the stale region (which still covers the view).
    const zoomedIn = 30
    const view = viewportAt(100.4, 180, zoomedIn)
    expect(rectCovers(first.slice!, baked(plan(box, zoomedIn, view)).slice!)).toBe(true) // stale would have "fit"
    expect(baked(plan(box, zoomedIn, view, first.slice, 512, zoom)).slice).toEqual(
      baked(plan(box, zoomedIn, view)).slice,
    )
  })
})

describe('several scenes in one viewport', () => {
  const zoom = 12
  const view = viewportAt(400, 300, zoom)
  // Three boxes: one under the viewport centre, one partly off its right edge, one far away.
  const onScreen = { x: 340, y: 250, w: 300, h: 300 }
  const straddling = { x: 440, y: 250, w: 400, h: 300 }
  const faraway = { x: 5000, y: 5000, w: 300, h: 300 }

  it('plans each scene from its own intersection, not a shared one', () => {
    const a = baked(plan(onScreen, zoom, view))
    const b = baked(plan(straddling, zoom, view))
    expect(a.dest).not.toEqual(b.dest)
    for (const [p, box] of [
      [a, onScreen],
      [b, straddling],
    ] as const) {
      expect(texelsPerPx(p, box, zoom)).toBeGreaterThan(0.9)
    }
  })

  it('reports an off-screen scene as such rather than as a failure', () => {
    // A failure would send the caller down the overlay path, which builds and renders a
    // three instance every frame for a scene nobody can see.
    expect(plan(faraway, zoom, view)).toEqual({ kind: 'offscreen' })
  })

  it('keeps each scene on its own hysteresis — one panning does not disturb another', () => {
    const a1 = baked(plan(onScreen, zoom, view))
    const b1 = baked(plan(straddling, zoom, view))
    const shifted = viewportAt(430, 300, zoom)
    const a2 = baked(plan(onScreen, zoom, shifted, a1.slice))
    const b2 = baked(plan(straddling, zoom, shifted, b1.slice))
    // Each answer depends only on that scene's own held region.
    expect(a2.slice).toEqual(baked(plan(onScreen, zoom, shifted, a1.slice)).slice)
    expect(b2.slice).toEqual(baked(plan(straddling, zoom, shifted, b1.slice)).slice)
    // Feeding one scene's region to the other must not be silently accepted as covering.
    const crossed = baked(plan(onScreen, zoom, shifted, b1.slice))
    expect(crossed.dest?.[0]).toBeGreaterThanOrEqual(onScreen.x)
    expect(crossed.dest?.[2]).toBeLessThanOrEqual(onScreen.x + onScreen.w)
  })

  it('bounds every scene by the screen, so N scenes cost N screens and not N nodes', () => {
    for (const box of [onScreen, straddling]) {
      const p = baked(plan(box, 60, viewportAt(box.x + box.w / 2, box.y + box.h / 2, 60)))
      expect(p.w).toBeLessThanOrEqual(SCREEN.w * DPR + SLACK)
      expect(p.h).toBeLessThanOrEqual(SCREEN.h * DPR + SLACK)
    }
  })
})

describe('degenerate input', () => {
  it('refuses a zero-sized node', () => {
    expect(plan({ x: 0, y: 0, w: 0, h: 100 }, 4, viewportAt(0, 0, 4))).toBeNull()
  })

  it('falls back to the whole node with no viewport to clip against', () => {
    const p = baked(plan({ x: 0, y: 0, w: 300, h: 200 }, 4, null))
    expect(p.dest).toBeNull()
  })

  it('sizes targets sanely at the extremes', () => {
    expect(bakeTargetSize(0, 100, 1, 1, MAX_PX)).toBeNull()
    expect(bakeTargetSize(100, 100, 0, 1, MAX_PX)?.w).toBeGreaterThanOrEqual(16)
    const huge = bakeTargetSize(100000, 100, 10, 2, MAX_PX)!
    expect(Math.max(huge.w, huge.h)).toBeLessThanOrEqual(MAX_PX)
  })
})
