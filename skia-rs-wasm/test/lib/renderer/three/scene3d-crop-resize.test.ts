/**
 * Resizing a 3D scene box: Scale and Crop.
 *
 * The scene stores ONE thing — the view window currently on screen — and both modes render
 * it identically. The mode only decides what a RESIZE does to it. So the tests come in
 * three parts:
 *   - the invariant that makes the design work: switching modes never changes the picture;
 *   - each mode's resize rule, checked through a REAL three camera (projection is pure
 *     matrix maths, so no GPU is involved) against the property a user would name — objects
 *     hold their size in Crop, the whole scene stays in view and resizes in Scale;
 *   - the document wiring, through the real commit pipeline: one undo frame, and a move
 *     writes nothing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import type { Change } from 'penpot-exporter/types'
import type { IndexedPage, IndexedShape } from '../../../../src/lib/worker/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { docProxy } from '../../../../src/lib/renderer/store/doc-proxy'
import { useHistoryStore } from '../../../../src/lib/history/history-store'
import { commitChanges } from '../../../../src/lib/renderer/store/commit'
import { undo } from '../../../../src/lib/page-crud'
import {
  scene3dProxy,
  defaultSceneDocument,
  type Scene3DDocument,
  type Scene3DViewWindow,
} from '../../../../src/lib/renderer/three/scene3d-store'
import {
  defaultWindow,
  sceneViewPlan,
  viewPlan,
  windowAfterCropResize,
  windowFittedToBox,
  type BoxRect,
  type CropPlan,
} from '../../../../src/lib/renderer/three/scene3d-viewframe'
import { nodeBoxRect } from '../../../../src/lib/renderer/three/scene3d-crop-resize'

const PAGE_ID = 'page1'
const ROOT = '00000000-0000-0000-0000-000000000000'
const SCENE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

const BOX = { x: 0, y: 0, w: 360, h: 260 }
const WIN = defaultWindow(BOX.w, BOX.h)

function docWith(mode: Scene3DDocument['resizeMode'], win = WIN): Scene3DDocument {
  return { ...defaultSceneDocument(SCENE), resizeMode: mode, viewWindow: win }
}

/**
 * Project a world point through the plan and report where it lands inside the box, in
 * document units. This is exactly what the renderers do — camera framed on the reference
 * frustum, cropped to the window, drawn into the plan's sub-rect of the box — so anything
 * asserted here is a claim about what the user actually sees.
 */
function projectIntoBox(
  plan: CropPlan,
  boxW: number,
  boxH: number,
  point: THREE.Vector3,
): { x: number; y: number } {
  const cam = new THREE.PerspectiveCamera(50, plan.fullW / plan.fullH, 0.1, 100)
  cam.position.set(0, 0, 5)
  cam.lookAt(0, 0, 0)
  cam.setViewOffset(plan.fullW, plan.fullH, plan.offX, plan.offY, plan.subW, plan.subH)
  cam.updateMatrixWorld(true)
  const ndc = point.clone().project(cam)
  return {
    x: plan.fx * boxW + ((ndc.x + 1) / 2) * plan.fw * boxW,
    y: plan.fy * boxH + ((1 - ndc.y) / 2) * plan.fh * boxH,
  }
}

/** On-screen width of a unit-wide object, in document units. */
function objectSpan(plan: CropPlan, boxW: number, boxH: number): number {
  const l = projectIntoBox(plan, boxW, boxH, new THREE.Vector3(-0.5, 0, 0))
  const r = projectIntoBox(plan, boxW, boxH, new THREE.Vector3(0.5, 0, 0))
  return r.x - l.x
}

describe('the mode never changes what is displayed', () => {
  it('renders identically in Scale and Crop, for any window and any box', () => {
    const windows: Scene3DViewWindow[] = [
      WIN,
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 0.42, y: -0.1, w: 0.77, h: 0.55 },
      { x: -0.3, y: 0.2, w: 2, h: 1.4 },
    ]
    for (const win of windows) {
      for (const [w, h] of [
        [360, 260],
        [720, 260],
        [200, 600],
      ]) {
        const box = { x: 0, y: 0, w, h }
        // Same committed box ⇒ no resize in flight ⇒ the mode has nothing to act on.
        expect(sceneViewPlan(docWith('crop', win), box, box)).toEqual(
          sceneViewPlan(docWith('reframe', win), box, box),
        )
      }
    }
  })

  it('measures a ROTATED scene the way getSelectionRect does, so it never looks mid-resize', () => {
    // getSelectionRect reports the shape's OWN rect, unrotated — confirmed against a live
    // document: a 0.08° 348×327 scene reports 348.0 × 327.0 while the bounds of its corner
    // points are 348.46 × 327.49. Measure the committed side any other way and the 0.46
    // disagreement reads as a resize, which crop answers by rebuilding its window to the
    // box's aspect: a jump of tens of percent, not a nudge. It cost two wrong fixes.
    const rot = (0.08 * Math.PI) / 180
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    const corner = (dx: number, dy: number): { x: number; y: number } => ({
      x: BOX.w / 2 + dx * cos - dy * sin,
      y: BOX.h / 2 + dx * sin + dy * cos,
    })
    const rotated = {
      selrect: { x: 0, y: 0, width: BOX.w, height: BOX.h },
      points: [
        corner(-BOX.w / 2, -BOX.h / 2),
        corner(BOX.w / 2, -BOX.h / 2),
        corner(BOX.w / 2, BOX.h / 2),
        corner(-BOX.w / 2, BOX.h / 2),
      ],
    }
    // The corner bounds ARE wider — and are exactly what must not be reported.
    const cornersW = Math.max(...rotated.points.map((p) => p.x)) - Math.min(...rotated.points.map((p) => p.x))
    expect(cornersW).toBeGreaterThan(BOX.w)
    expect(nodeBoxRect(rotated)).toMatchObject({ w: BOX.w, h: BOX.h })

    // So the live rect and the committed one agree, and the modes render identically.
    const live = { x: 0, y: 0, w: BOX.w, h: BOX.h }
    expect(sceneViewPlan(docWith('crop'), live, nodeBoxRect(rotated)!)).toEqual(
      sceneViewPlan(docWith('reframe'), live, nodeBoxRect(rotated)!),
    )
  })

  it('is not fooled by a window whose proportions no longer match the box', () => {
    // The state the live document was actually in: a window left at aspect 1.54 by earlier
    // crop drags, inside a box at aspect 1.06. Scale letterboxes it; crop must render the
    // SAME thing, not rebuild the window to the box.
    const odd: Scene3DViewWindow = { x: 0.0281, y: 0.0003, w: 1.4524, h: 0.9417 }
    const box = { x: 629.23, y: 243.25, w: 348, h: 327 }
    const crop = sceneViewPlan(docWith('crop', odd), box, box)!
    expect(crop).toEqual(sceneViewPlan(docWith('reframe', odd), box, box))
    expect(crop.subH).toBeCloseTo(odd.h, 6) // the window is rendered as stored
    expect(crop.fh).toBeLessThan(1) // ...bands and all
  })

  it('starts a fresh scene filling its box, whichever mode it is in', () => {
    for (const mode of ['reframe', 'crop'] as const) {
      const plan = sceneViewPlan({ ...defaultSceneDocument(SCENE), resizeMode: mode }, BOX, BOX)!
      expect(plan).toMatchObject({ fx: 0, fy: 0, fw: 1, fh: 1 })
    }
  })
})

describe('crop — objects keep their size', () => {
  it('draws an object at the same size whatever the box does', () => {
    const base = objectSpan(viewPlan(WIN, BOX.w, BOX.h)!, BOX.w, BOX.h)
    for (const [w, h] of [
      [500, 260],
      [200, 260],
      [360, 520],
      [720, 520],
    ]) {
      const win = windowAfterCropResize(WIN, BOX, { x: 0, y: 0, w, h })
      expect(objectSpan(viewPlan(win, w, h)!, w, h)).toBeCloseTo(base, 6)
    }
  })

  it('reveals more world when the box grows, rather than magnifying', () => {
    const win = windowAfterCropResize(WIN, BOX, { x: 0, y: 0, w: 500, h: 260 })
    // The window widened in step with the box — that ratio IS the fixed world scale.
    expect(win.w / WIN.w).toBeCloseTo(500 / 360, 6)
    expect(win.h).toBeCloseTo(WIN.h, 6)
    expect(viewPlan(win, 500, 260)).toMatchObject({ fw: 1, fh: 1 }) // still fills the box
  })

  it('holds content still when the LEFT edge is dragged', () => {
    const before = viewPlan(WIN, BOX.w, BOX.h)!
    const after = { x: 160, y: 0, w: 200, h: 260 }
    const win = windowAfterCropResize(WIN, BOX, after)
    // The un-dragged (right) edge of the window is untouched.
    expect(win.x + win.w).toBeCloseTo(WIN.x + WIN.w, 6)

    // An object sits at the same document position; the box's left edge has moved 160 right,
    // so it is 160 closer to that edge — i.e. it did not move on screen.
    const p = new THREE.Vector3(0.4, 0.25, 0)
    const was = projectIntoBox(before, BOX.w, BOX.h, p)
    const now = projectIntoBox(viewPlan(win, after.w, after.h)!, after.w, after.h, p)
    expect(now.x).toBeCloseTo(was.x - 160, 6)
    expect(now.y).toBeCloseTo(was.y, 6)
  })

  it('holds content still even when Scale left the view letterboxed', () => {
    // Straight from a live document: Scale had been resized, leaving a window narrower than
    // the box (fh 0.68), then the mode was switched to Crop and the box resized. The box's
    // edges sit OUTSIDE the window in that state, so anchoring the new window at the old
    // window's corner filled the bands from one side and threw the content up by half a band.
    const banded: Scene3DViewWindow = { x: 0.0271128, y: 0.0001482, w: 1.5018509, h: 1.0325225 }
    const before = { x: 629.17, y: 243.17, w: 240, h: 242 }
    const after = { x: 629.17, y: 243.17, w: 240, h: 225 } // bottom edge dragged up
    expect(viewPlan(banded, before.w, before.h)!.fh).toBeLessThan(0.7) // genuinely banded

    // An object's position in the DOCUMENT — box corner plus where it lands inside the box.
    const p = new THREE.Vector3(0.4, 0.25, 0)
    const docPos = (win: Scene3DViewWindow, box: BoxRect): { x: number; y: number } => {
      const at = projectIntoBox(viewPlan(win, box.w, box.h)!, box.w, box.h, p)
      return { x: box.x + at.x, y: box.y + at.y }
    }
    const was = docPos(banded, before)
    const now = docPos(windowAfterCropResize(banded, before, after), after)
    expect(now.x).toBeCloseTo(was.x, 6)
    expect(now.y).toBeCloseTo(was.y, 6)
  })

  it('applies the same rule mid-drag as on commit', () => {
    // The gesture previews a box the document has not caught up with yet. Left uncompensated,
    // content slides for the length of the drag and snaps back on release.
    const live = { x: 160, y: 0, w: 200, h: 260 }
    const dragging = sceneViewPlan(docWith('crop'), live, BOX)!
    const committed = viewPlan(windowAfterCropResize(WIN, BOX, live), live.w, live.h)!
    expect(dragging).toEqual(committed)
  })
})

describe('scale — the whole scene stays in view and resizes', () => {
  it('leaves the window alone, so the same scene is shown at any box size', () => {
    for (const [w, h] of [
      [720, 520],
      [180, 130],
      [720, 260],
    ]) {
      const plan = sceneViewPlan(docWith('reframe'), { x: 0, y: 0, w, h }, BOX)!
      expect(plan).toMatchObject({ offX: WIN.x, offY: WIN.y, subW: WIN.w, subH: WIN.h })
    }
  })

  it('scales an object with the box', () => {
    const base = objectSpan(viewPlan(WIN, BOX.w, BOX.h)!, BOX.w, BOX.h)
    expect(objectSpan(viewPlan(WIN, 720, 520)!, 720, 520)).toBeCloseTo(base * 2, 4)
    expect(objectSpan(viewPlan(WIN, 180, 130)!, 180, 130)).toBeCloseTo(base / 2, 4)
  })

  it('SHRINKS the scene on a narrower box instead of sliding it out', () => {
    // The case that made the old behaviour feel arbitrary: narrowing used to translate
    // content past the edge while only the height rescaled. Now both axes scale.
    const plan = viewPlan(WIN, 180, 260)!
    expect(plan.fw).toBeCloseTo(1, 6) // width limits, so it is fully used
    expect(plan.fh).toBeCloseTo(0.5, 6) // drawn at half size
    expect(plan.fy).toBeCloseTo(0.25, 6) // centred, bands above and below
  })

  it('leaves bands rather than revealing world the window never had', () => {
    const plan = viewPlan(WIN, 720, 260)!
    expect(plan.fh).toBeCloseTo(1, 6)
    expect(plan.fw).toBeCloseTo(0.5, 6)
    expect(plan.fx).toBeCloseTo(0.25, 6)
  })

  it('keeps an object in the same relative spot as the box grows', () => {
    const at = (w: number, h: number): { x: number; y: number } => {
      const p = projectIntoBox(viewPlan(WIN, w, h)!, w, h, new THREE.Vector3(0.4, 0.25, 0))
      return { x: p.x / w, y: p.y / h }
    }
    const base = at(BOX.w, BOX.h)
    expect(at(720, 520).x).toBeCloseTo(base.x, 6)
    expect(at(720, 520).y).toBeCloseTo(base.y, 6)
    expect(at(180, 130).x).toBeCloseTo(base.x, 6)
  })
})

describe('view geometry', () => {
  it('never distorts, at any window and box', () => {
    for (const win of [WIN, { x: 0.1, y: 0.2, w: 0.6, h: 0.9 }]) {
      for (const [w, h] of [
        [360, 260],
        [720, 260],
        [200, 600],
        [1000, 90],
      ]) {
        const plan = viewPlan(win, w, h)!
        expect((plan.fw * w) / (plan.fh * h)).toBeCloseTo(plan.subW / plan.subH, 6)
      }
    }
  })

  it('fits the view to the box by revealing, never by trimming', () => {
    const fitted = windowFittedToBox(WIN, 720, 260)
    expect(viewPlan(fitted, 720, 260)).toMatchObject({ fw: 1, fh: 1 }) // no bands left
    expect(fitted.w).toBeGreaterThan(WIN.w) // gained width...
    expect(fitted.h).toBeCloseTo(WIN.h, 6) // ...without losing height
    expect(fitted.x + fitted.w / 2).toBeCloseTo(WIN.x + WIN.w / 2, 6) // same centre
  })

  it('renders nothing only when the window or box is degenerate', () => {
    expect(viewPlan({ x: 0, y: 0, w: 0, h: 1 }, 200, 260)).toBeNull()
    expect(viewPlan(WIN, 0, 260)).toBeNull()
    // A window far off the reference frustum is fine — it just looks elsewhere.
    expect(viewPlan({ x: -4, y: 0, w: 1, h: 1 }, 200, 260)).not.toBeNull()
  })
})

/* -------------------------------------------------------------- document wiring */

function sceneShape(x: number, y: number, w: number, h: number): IndexedShape {
  const sel = { x, y, width: w, height: h, x1: x, y1: y, x2: x + w, y2: y + h }
  return {
    id: SCENE,
    type: 'rect',
    name: '3D scene',
    parentId: ROOT,
    frameId: ROOT,
    x,
    y,
    width: w,
    height: h,
    selrect: sel,
    points: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  } as IndexedShape
}

function makePage(): IndexedPage {
  return {
    id: PAGE_ID,
    objects: {
      [ROOT]: {
        id: ROOT,
        type: 'frame',
        name: 'Root',
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        selrect: { x: 0, y: 0, width: 800, height: 600, x1: 0, y1: 0, x2: 800, y2: 600 },
        points: [],
        shapes: [SCENE],
      } as unknown as IndexedShape,
      [SCENE]: sceneShape(0, 0, 360, 260),
    },
  }
}

function node(): IndexedShape {
  return docProxy.pageMap.get(PAGE_ID)!.objects[SCENE] as IndexedShape
}

function win(): Scene3DViewWindow | undefined {
  return node().scene3d?.viewWindow
}

/** The geometry half of a resize/move commit, exactly as the real paths write it. */
function geometryChange(x: number, y: number, w: number, h: number): Change {
  return {
    type: 'mod-obj',
    id: SCENE,
    pageId: PAGE_ID,
    operations: [
      {
        type: 'assign',
        value: {
          x,
          y,
          width: w,
          height: h,
          selrect: { x, y, width: w, height: h, x1: x, y1: y, x2: x + w, y2: y + h },
        },
      },
    ],
  } as unknown as Change
}

async function commitGeometry(x: number, y: number, w: number, h: number): Promise<void> {
  const n = node()
  const before = { x: n.x, y: n.y, width: n.width, height: n.height, selrect: n.selrect }
  await commitChanges({
    redoChanges: [geometryChange(x, y, w, h)],
    undoChanges: [
      { type: 'mod-obj', id: SCENE, pageId: PAGE_ID, operations: [{ type: 'assign', value: before }] } as unknown as Change,
    ],
    pageId: PAGE_ID,
  })
}

describe('resize through the commit pipeline', () => {
  beforeEach(() => {
    useHistoryStore.setState({ undoStack: [], redoStack: [] })
    docProxy.pageMap.clear()
    docProxy.pageMap.set(PAGE_ID, structuredClone(makePage()))
    docProxy.currentPageId = PAGE_ID
    docProxy.selectedIds.clear()
    scene3dProxy.scenes.clear()
    scene3dProxy.focusedObjectId = null
    useWorkspaceStore.setState({
      workerClient: {
        updatePageWithChanges: vi.fn(async () => {}),
        updatePage: vi.fn(async () => {}),
      } as never,
      renderer: null,
    })
    node().scene3d = docWith('crop')
  })

  it('moves a crop window with the box, in ONE undo frame', async () => {
    await commitGeometry(160, 0, 200, 260)
    expect(win()!.x + win()!.w).toBeCloseTo(WIN.x + WIN.w, 6) // right edge held
    expect(win()!.w).toBeCloseTo((WIN.w * 200) / 360, 6)
    expect(useHistoryStore.getState().undoStack).toHaveLength(1)

    // One undo restores the box AND its window together — split across two frames, undo
    // would put the box back and leave the content shifted.
    await undo()
    expect(win()).toMatchObject(WIN)
    expect(node().width).toBe(360)
  })

  it('leaves a scale window where it is, but pins it on the first resize', async () => {
    node().scene3d = { ...defaultSceneDocument(SCENE) } // reframe, no window yet
    await commitGeometry(160, 0, 200, 260)
    expect(win()).toMatchObject(WIN) // materialised from the PRE-resize box, unmoved
    expect(useHistoryStore.getState().undoStack).toHaveLength(1)
  })

  it('writes nothing at all on a later scale resize', async () => {
    node().scene3d = docWith('reframe')
    await commitGeometry(0, 0, 720, 520)
    expect(win()).toMatchObject(WIN)
  })

  it('writes nothing when the box only moves', async () => {
    await commitGeometry(240, 130, 360, 260)
    expect(win()).toMatchObject(WIN)
  })
})
