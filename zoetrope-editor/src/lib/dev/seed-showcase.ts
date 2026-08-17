/**
 * Dev-only showcase seeder (`?seed=showcase`).
 *
 * Materialises the render-core parity fixture `build_showcase_scene`
 * (render-core/src/parity.rs) into a REAL, editable, persisted zoetrope-editor
 * document via the normal store pipeline (`applyChanges` → commit → docProxy →
 * renderer sync). The point is a single complex document — shapes at different
 * depths carrying every effect (gradients, layer/background blur, multiply
 * blend, drop/inner shadow, strokes, masks, clip frames, glass) — that both the
 * classic (WebGPU) and hybrid (WebGL2) vello backends render, so the two can be
 * A/B-compared on identical, hand-editable content instead of a hardcoded Rust
 * scene.
 *
 * Coordinates/colours/effects mirror the Rust fixture 1:1. render-core uses
 * `Rect::new(x0, y0, x1, y1)` (corner-corner); here we translate to the store's
 * `x/y/width/height`.
 */

import { applyChanges, createNewDocument, setDocument } from '../page-crud'
import { getActiveOrSinglePageId, getPage } from '../renderer/store/doc-proxy'
import {
  createRect,
  createCircle,
  createFrame,
  createGroup,
  createPolyline,
} from '../renderer/node-factory'
import type {
  AddObjChange,
  DelObjChange,
  PenpotNode,
  Fill,
  Stroke,
  Shadow,
  Blur,
} from 'penpot-exporter/types'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'

/** Loose handle for spreading effect fields the factory options don't cover. */
type AnyNode = PenpotNode & Record<string, unknown>

// ── Gradients (mirror render-core parity.rs linear/radial/angular) ──────────
const linearGrad = () => ({
  type: 'linear' as const,
  startX: 0,
  startY: 0.5,
  endX: 1,
  endY: 0.5,
  width: 1,
  stops: [
    { color: '#e84242', opacity: 1, offset: 0 },
    { color: '#3666d6', opacity: 1, offset: 1 },
  ],
})
const radialGrad = () => ({
  type: 'radial' as const,
  startX: 0.5,
  startY: 0.5,
  endX: 1,
  endY: 0.5,
  width: 1,
  stops: [
    { color: '#fad250', opacity: 1, offset: 0 },
    { color: '#ba3c1e', opacity: 1, offset: 1 },
  ],
})
const angularGrad = () => ({
  type: 'angular' as const,
  startX: 0.5,
  startY: 0.5,
  endX: 1,
  endY: 0.5,
  width: 1,
  stops: [
    { color: '#1d9e75', opacity: 1, offset: 0 },
    { color: '#544ab7', opacity: 1, offset: 0.5 },
    { color: '#1d9e75', opacity: 1, offset: 1 },
  ],
})

const gradientFill = (g: object): Fill => ({ fillColorGradient: g } as Fill)

/** A tuned frosted-glass lens, mirroring parity.rs `glass_lens`. */
const showcaseGlass = () => ({
  surfaceType: 1,
  bezelWidth: 12,
  glassThickness: 1.2,
  refractiveIndex: 1.5,
  specularAngle: 40,
  specularOpacity: 0.5,
  specularSaturation: 1,
  chromaticAberration: 0.3,
  splay: 0,
  tiltAngle: 0,
  edgeBoost: 0.2,
  zoom: 100,
  blur: 2,
  frost: 0.2,
  hidden: false,
})

/**
 * Build the 13 showcase shapes and commit them under the root frame in one
 * batch (parent-before-child order, so `processAddObj` folds each child into
 * its parent's `shapes`). Returns the number of top-level shapes added.
 */
export async function seedShowcaseDocument(): Promise<number> {
  // Deterministic: reset to a blank document first so `?seed=showcase` always
  // yields exactly the showcase, never a second copy stacked on a persisted one.
  await setDocument(createNewDocument())

  const pageId = getActiveOrSinglePageId()
  const page = pageId ? getPage(pageId) : undefined
  if (!pageId || !page) return 0

  const root = Object.values(page.objects).find((o) => o.parentId == null)
  const rootId = root?.id ?? ROOT_UUID

  const changes: AddObjChange[] = []
  const rootChildIds: string[] = []

  /** Queue an add-obj. `parentId` defaults to the document root. */
  const add = (node: PenpotNode, parentId: string = rootId) => {
    changes.push({
      type: 'add-obj',
      id: node.id,
      obj: node,
      frameId: parentId,
      parentId,
      // Append: index past whatever siblings the change stream has queued so
      // far under this parent. For the root we track our own running count.
      index:
        parentId === rootId
          ? rootChildIds.length
          : changes.filter((c) => c.parentId === parentId).length,
      pageId,
    })
    if (parentId === rootId) rootChildIds.push(node.id)
    return node.id
  }

  // 1. Backdrop: full-canvas linear gradient.
  {
    const n = createRect({ x: 0, y: 0, width: 1200, height: 800, parentId: rootId }) as AnyNode
    n.fills = [gradientFill(linearGrad())]
    add(n)
  }
  // 2. Hero panel: angular gradient, rounded.
  {
    const n = createRect({ x: 60, y: 60, width: 500, height: 340, parentId: rootId, borderRadius: 28 }) as AnyNode
    n.fills = [gradientFill(angularGrad())]
    add(n)
  }
  // 3. Radial-gradient circle, overlapping the hero.
  {
    const n = createCircle({ x: 360, y: 150, radius: 160, parentId: rootId }) as AnyNode
    n.fills = [gradientFill(radialGrad())]
    add(n)
  }
  // 4. Orange rect with a LAYER BLUR.
  {
    const n = createRect({ x: 620, y: 80, width: 280, height: 260, parentId: rootId, borderRadius: 10, fillColor: '#f59e0b', fillOpacity: 1 }) as AnyNode
    n.blur = { type: 'layer-blur', value: 8, hidden: false } as Blur
    add(n)
  }
  // 5. Translucent blue rect, MULTIPLY blend + 60% opacity.
  {
    const n = createRect({ x: 640, y: 280, width: 360, height: 280, parentId: rootId, fillColor: '#3b82f6', fillOpacity: 1, opacity: 0.6 }) as AnyNode
    n.blendMode = 'multiply'
    add(n)
  }
  // 6. Multi-fill card (three stacked translucent fills) with a DROP SHADOW.
  {
    const n = createRect({ x: 120, y: 440, width: 380, height: 280, parentId: rootId, borderRadius: 18 }) as AnyNode
    n.fills = [
      { fillColor: '#3666d6', fillOpacity: 140 / 255 },
      { fillColor: '#e84242', fillOpacity: 150 / 255 },
      { fillColor: '#f0c828', fillOpacity: 1 },
    ] as Fill[]
    n.shadow = [
      { id: null, style: 'drop-shadow', offsetX: 8, offsetY: 12, blur: 16, spread: 0, hidden: false, color: { color: '#000000', opacity: 150 / 255 } },
    ] as Shadow[]
    add(n)
  }
  // 7. Rounded rect with an INNER SHADOW + a centred stroke.
  {
    const n = createRect({ x: 540, y: 540, width: 240, height: 220, parentId: rootId, borderRadius: 16, fillColor: '#e6e8ee', fillOpacity: 1 }) as AnyNode
    n.strokes = [
      { strokeColor: '#788296', strokeOpacity: 1, strokeWidth: 3, strokeStyle: 'solid', strokeAlignment: 'center' },
    ] as Stroke[]
    n.shadow = [
      { id: null, style: 'inner-shadow', offsetX: 4, offsetY: 6, blur: 12, spread: 0, hidden: false, color: { color: '#000000', opacity: 170 / 255 } },
    ] as Shadow[]
    add(n)
  }
  // 8. Boolean-style L path with an OUTER stroke.
  {
    const n = createPolyline(
      [
        { x: 940, y: 90 },
        { x: 1140, y: 90 },
        { x: 1140, y: 200 },
        { x: 1050, y: 200 },
        { x: 1050, y: 340 },
        { x: 940, y: 340 },
      ],
      { parentId: rootId, closed: true, fillColor: '#544ab7', fillOpacity: 1 },
    ) as AnyNode
    n.strokes = [
      { strokeColor: '#14141e', strokeOpacity: 1, strokeWidth: 6, strokeStyle: 'solid', strokeAlignment: 'outer' },
    ] as Stroke[]
    add(n)
  }
  // 9. MASKED GROUP: an angular-gradient rect clipped to a circle silhouette.
  {
    const group = createGroup({ x: 820, y: 530, width: 270, height: 260, parentId: rootId }) as AnyNode
    group.maskedGroup = true
    const gid = add(group)
    // Mask FIRST (Penpot masks on the group's first child).
    const mask = createCircle({ x: 830, y: 540, radius: 120, parentId: gid, fillColor: '#ffffff', fillOpacity: 1 })
    add(mask, gid)
    const content = createRect({ x: 820, y: 530, width: 270, height: 260, parentId: gid }) as AnyNode
    content.fills = [gradientFill(angularGrad())]
    add(content, gid)
  }
  // 10. CLIP FRAME (scope): an oversized radial circle clipped to the frame.
  {
    const frame = createFrame({ x: 60, y: 600, width: 240, height: 180, parentId: rootId, fillColor: '#ebeef4', fillOpacity: 1, strokeColor: '#282832', strokeWidth: 3, showContent: false }) as AnyNode
    frame.r1 = frame.r2 = frame.r3 = frame.r4 = 14
    const fid = add(frame)
    const child = createCircle({ x: 20, y: 560, radius: 180, parentId: fid }) as AnyNode
    child.fills = [gradientFill(radialGrad())]
    add(child, fid)
  }
  // 11. Dashed outline rect (no fill).
  {
    const n = createRect({ x: 330, y: 620, width: 230, height: 160, parentId: rootId, borderRadius: 12 }) as AnyNode
    n.fills = []
    n.strokes = [
      { strokeColor: '#3cdceb', strokeOpacity: 1, strokeWidth: 2, strokeStyle: 'dashed', strokeAlignment: 'center' },
    ] as Stroke[]
    add(n)
  }
  // 12. GLASS panel over the backdrop (a gather — refracts everything behind it).
  {
    const n = createRect({ x: 260, y: 180, width: 320, height: 240, parentId: rootId, borderRadius: 24 }) as AnyNode
    n.fills = []
    n.glass = showcaseGlass()
    add(n)
  }
  // 13. BACKGROUND-BLUR panel over the backdrop (a gather — frosts everything behind it).
  {
    const n = createRect({ x: 700, y: 420, width: 300, height: 260, parentId: rootId, borderRadius: 24, fillColor: '#ffffff', fillOpacity: 26 / 255 }) as AnyNode
    n.backgroundBlur = { type: 'background-blur', value: 18, hidden: false } as Blur
    add(n)
  }

  // Undo vector: delete each top-level shape (cascades to children).
  const undoChanges: DelObjChange[] = rootChildIds
    .slice()
    .reverse()
    .map((id) => ({ type: 'del-obj', id, pageId }))

  await applyChanges(changes, { undoChanges })
  return rootChildIds.length
}
