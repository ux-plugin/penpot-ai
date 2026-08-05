/**
 * The cross-backend anchor.
 *
 * Both backends now answer `scene_digest`, computed from the same
 * `render_core::model::Scene::digest` but reached by different routes: render-vello builds the
 * neutral model straight from the wire, render-wasm projects its Skia shapes through
 * `model_export`. Drive both with one call stream and an equal digest means they agree on what
 * the document *is* — the question a screenshot cannot settle, because two rasterisers always
 * differ slightly on antialiasing and that noise drowns real divergence.
 *
 * Only one of them can run here. render-wasm's `_init` brings up a GL context, so it needs a
 * browser; this file pins the Vello side to a constant so the browser step is a one-liner:
 *
 *   1. load the app with the document `canonicalDocument()` describes
 *   2. `useWorkspaceStore.getState().renderer.sceneDigest()`
 *   3. compare against `CANONICAL_DIGEST` below
 *
 * A mismatch localises to the wire format rather than to the rasteriser, which is the whole
 * point of diffing at the model.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { loadVello, velloWasmAvailable, type VelloInstance } from './vello-instance'
import { setContextInitialized } from '../../../src/lib/renderer/api/context'
import { setObject } from '../../../src/lib/renderer/api/orchestration'
import { sceneDigest } from '../../../src/lib/renderer/api/canvas'
import { createCircle, createFrame, createGroup, createRect, createText } from '../../../src/lib/renderer/node-factory'
import { setShapeChildren } from '../../../src/lib/renderer/api/shape'
import type { EmscriptenLikeModule } from '../../../src/lib/renderer/vello-module-facade'
import type { WasmModule } from '../../../src/lib/renderer/wasm-types'

beforeAll(() => setContextInitialized(true))

/**
 * The digest both backends must produce for `canonicalDocument()`.
 *
 * Deliberately a hard-coded constant rather than something recomputed at test time: a value
 * derived from the same code it checks would follow any drift instead of catching it. When this
 * changes, either the wire format changed — in which case update it here *and* re-check the
 * browser side — or something regressed.
 */
const CANONICAL_DIGEST = 3919334440

/**
 * Fixed ids, because the digest hashes them.
 *
 * `node-factory` mints a fresh uuid per call, which makes a document that *looks* canonical
 * digest differently on every run — the anchor would have been noise. Both backends must be
 * driven with the same ids for the comparison to mean anything, which a replayed recording gives
 * for free and a hand-built fixture has to state.
 */
const IDS = {
  frame: '11111111-1111-4111-8111-111111111111',
  rect: '22222222-2222-4222-8222-222222222222',
  circle: '33333333-3333-4333-8333-333333333333',
  // A masked group and its two children: the first child is the mask, the second the content it
  // clips. Exercises `_set_shape_masked_group` through the real wire.
  maskGroup: '44444444-4444-4444-8444-444444444444',
  maskShape: '55555555-5555-4555-8555-555555555555',
  maskContent: '66666666-6666-4666-8666-666666666666',
  // A text shape, exercising `_set_shape_text_content` / `_set_shape_grow_type` through the wire.
  text: '77777777-7777-4777-8777-777777777777',
} as const

/**
 * A document exercising the parts of the model both backends implement: a clipping frame, a
 * rect with a non-default (Multiply) blend, and a circle overflowing its parent. Deliberately
 * small — the digest's job is to
 * be exact, not broad, and a fixture nobody can hold in their head stops being a fixture.
 */
function canonicalDocument(module: EmscriptenLikeModule, rectHeight = 60): void {
  // The frame must *list* its children. `setObject` takes a container's children from its own
  // `shapes` array — setting `parentId` on the child is not enough, and a document built that
  // way leaves both children unreachable from the root, where the digest cannot see them.
  const frame = createFrame({
    id: IDS.frame,
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    shapes: [IDS.rect, IDS.circle, IDS.maskGroup, IDS.text],
  })
  const rect = createRect({
    id: IDS.rect,
    parentId: frame.id,
    x: 20,
    y: 20,
    width: 100,
    height: rectHeight,
    fillColor: '#3d8bfd',
  })
  // Non-default effects, so the anchor exercises the real wire paths end to end through the
  // facade → render-vello's ABI → the neutral node → digest: blend, a layer blur, and a drop
  // shadow (`_set_shape_blend_mode`, `_set_shape_blur`, `_add_shape_shadow`).
  ;(rect as { blendMode?: string }).blendMode = 'multiply'
  ;(rect as { blur?: unknown }).blur = { type: 'layer-blur', hidden: false, value: 12 }
  // Penpot's shadow array property is `shadow` (singular) — `shadows` is silently ignored by
  // `setObject`, which would drop the effect from the wire without any error.
  ;(rect as { shadow?: unknown }).shadow = [
    {
      color: { color: '#000000', opacity: 0.5 },
      blur: 6,
      spread: 0,
      offsetX: 4,
      offsetY: 5,
      style: 'drop-shadow',
      hidden: false,
    },
  ]
  const circle = createCircle({
    id: IDS.circle,
    parentId: frame.id,
    x: 200,
    y: 100,
    width: 80,
    height: 80,
    fillColor: '#f05a28',
  })

  // A masked group: `maskShape` (first child) is the mask, `maskContent` the shape it clips. The
  // group carries `maskedGroup: true`, which orchestration turns into `_set_shape_masked_group`.
  const maskGroup = createGroup({
    id: IDS.maskGroup,
    parentId: frame.id,
    x: 40,
    y: 160,
    width: 120,
    height: 100,
    shapes: [IDS.maskShape, IDS.maskContent],
  })
  ;(maskGroup as { maskedGroup?: boolean }).maskedGroup = true
  const maskShape = createCircle({
    id: IDS.maskShape,
    parentId: maskGroup.id,
    x: 40,
    y: 160,
    width: 100,
    height: 100,
    fillColor: '#ffffff',
  })
  const maskContent = createRect({
    id: IDS.maskContent,
    parentId: maskGroup.id,
    x: 60,
    y: 180,
    width: 120,
    height: 80,
    fillColor: '#28a745',
  })
  // A text shape with real content and a non-default grow, so the anchor exercises
  // `_set_shape_text_content` (paragraph + span decode) and `_set_shape_grow_type`.
  const text = createText({
    id: IDS.text,
    parentId: frame.id,
    x: 220,
    y: 20,
    width: 160,
    height: 40,
    text: 'Hi Vello',
    fillColor: '#101828',
    growType: 'auto-height',
  })
  // Drive the decoration + multi-fill wire (`textDecoration` byte, a two-fill span): an underline
  // and a second, semi-transparent fill layered over the first. Both backends read the same bytes,
  // so the digest still agrees — and it moves, proving the new fields cross.
  const paragraph = (text as { content: { children: { children: Record<string, unknown>[] }[] } })
    .content.children[0].children[0]
  // An RTL base direction and an uppercase case transform, both through the real wire.
  paragraph.textDirection = 'rtl'
  const span = (paragraph as { children: Record<string, unknown>[] }).children[0]
  span.textTransform = 'uppercase'
  span.textDecoration = 'underline'
  span.fills = [
    { fillColor: '#101828', fillOpacity: 1 },
    { fillColor: '#f59e0b', fillOpacity: 0.5 },
  ]
  // A centre stroke on the text shape, exercising a text-node stroke across the wire. Only centre
  // strokes cross (both projections drop inner/outer), so the two agree; the anchor moves.
  ;(text as { strokes?: unknown }).strokes = [
    { strokeColor: '#0ea5e9', strokeOpacity: 1, strokeWidth: 2, strokeStyle: 'solid', strokeAlignment: 'center' },
  ]

  for (const shape of [frame, rect, circle, maskGroup, maskShape, maskContent, text])
    setObject(module, shape)

  // A 3-node filter graph on the text node (the last shape `setObject` selected): blur(4) →
  // offset(10,0) → custom tint(effect 0, [r,g,b,amount]), driving the real `_set_shape_filter_graph`
  // wire so the anchor covers the node-stream decode end to end. Vello-only (render-wasm projects
  // `None`), but the wire + the ordered-node digest still cross here.
  const gw: number[] = []
  const u32 = (v: number) => gw.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
  const f32 = (v: number) => {
    const b = new Uint8Array(new Float32Array([v]).buffer)
    gw.push(b[0], b[1], b[2], b[3])
  }
  u32(4) // node count
  u32(0); f32(4) // Blur sigma 4
  u32(1); f32(10); f32(0) // Offset (10, 0)
  u32(3); f32(6); f32(6); f32(4); u32(0x80000000) // InnerShadow dx,dy,sigma,color(ARGB)
  u32(2); u32(0); u32(4); f32(1); f32(0.45); f32(0); f32(0.7) // Custom tint
  const graphBytes = new Uint8Array(gw)
  const graphPtr = module._alloc_bytes(graphBytes.length)
  module.HEAPU8.set(graphBytes, graphPtr)
  module._set_shape_filter_graph()

  module._use_shape(0, 0, 0, 0)
  setShapeChildren(module, [frame.id])
}

const suite = velloWasmAvailable() ? describe : describe.skip

suite('cross-backend digest', () => {
  let vello: VelloInstance

  beforeAll(async () => {
    vello = await loadVello()
  })

  /**
   * Read it the way the app does, through `api/canvas`, rather than by poking the export —
   * otherwise the accessor the browser step depends on is never exercised.
   */
  function digestThroughPublicApi(): number | null {
    return sceneDigest(vello.module as unknown as WasmModule)
  }

  it('anchors the Vello digest for the canonical document', () => {
    vello.exports.clean_up()
    const empty = digestThroughPublicApi()

    canonicalDocument(vello.module)
    const actual = digestThroughPublicApi()

    // The trap this harness has to guard against: a scene whose root children were never set
    // hashes exactly like an empty one, so every comparison would pass while proving nothing.
    expect(actual, 'the canonical document must not digest as an empty scene').not.toBe(empty)
    expect(vello.exports.scene_node_count()).toBeGreaterThan(3)
    // Reachability is the trap: an unlisted child is invisible to the digest, so an anchor
    // built from one would silently cover only the frame. Five shapes paint — the rect, the
    // circle, the masked group's mask and content, and the text (the group itself paints nothing).
    expect(vello.exports.scene_paintable_count(), 'every leaf must be reachable').toBe(5)

    expect(actual).toBe(CANONICAL_DIGEST)
  })

  it('is reproducible across a rebuild of the same document', () => {
    vello.exports.clean_up()
    canonicalDocument(vello.module)
    const first = digestThroughPublicApi()

    vello.exports.clean_up()
    canonicalDocument(vello.module)

    expect(digestThroughPublicApi()).toBe(first)
  })

  /**
   * The anchor is only worth having if it can fail — and it has to fail on a change to a
   * *child*, not just to the root. Ids are fixed for exactly this reason: with the factory's
   * random uuids the digest changes on every rebuild, so a test like this passes without ever
   * exercising the geometry it claims to.
   */
  it('moves when a nested child changes by one unit', () => {
    vello.exports.clean_up()
    canonicalDocument(vello.module, 60)
    const base = digestThroughPublicApi()

    vello.exports.clean_up()
    canonicalDocument(vello.module, 61)

    expect(digestThroughPublicApi()).not.toBe(base)
  })

  it('is unsigned, so the two backends cannot disagree over a sign bit', () => {
    vello.exports.clean_up()
    canonicalDocument(vello.module)

    const value = digestThroughPublicApi()
    expect(value).not.toBeNull()
    expect(value).toBeGreaterThanOrEqual(0)
    expect(Number.isInteger(value)).toBe(true)
  })
})
