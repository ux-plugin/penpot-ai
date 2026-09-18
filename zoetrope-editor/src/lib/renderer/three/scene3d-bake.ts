/**
 * scene3d-bake — composite a placed 3D scene INTO the Skia document (Path 1).
 *
 * Instead of floating the 3D on a separate overlay canvas above Skia (which can never
 * be occluded by 2D content and never appears in export), we render the scene into an
 * FBO in Skia's OWN emscripten WebGL2 context and hand Skia the texture as the scene
 * node's image fill. Skia then draws it in tree order like any node — true z-order,
 * clipping, opacity, export, all for free.
 *
 * Spike-validated: three renders into Skia's shared context and the two interleave with
 * zero GL errors / no context loss (three.resetState() alone hands the context back).
 * The renderer-wasm side is the committed `_update_image_from_texture` entry (overwrite +
 * bottom-left origin, so a live source refreshes under a stable id with no Y-flip).
 *
 * IBL note: the scene's env-map is context-specific, so this owns its OWN bake renderer
 * and its OWN scene instances built on the shared context (NOT the overlay's instances) —
 * lighting is only correct when the scene was built by the renderer that draws it.
 *
 * Baking is the only path for a placed scene; there is no overlay fallback.
 */

import * as THREE from 'three'
import type { WasmModule } from '../wasm-types'
import { useWorkspaceStore } from '../store/workspace-store'
import { getNode } from '../store/doc-proxy'
import { viewport } from '../signals/pointer'
import { worldToScreen } from '../viewport'
import { allocBytes, freeBytes, writeUUIDToDataView } from '../utils'
import { uuidToU32Tuple } from '../types'
import { buildSceneInstance, applyDocToInstance, pickScene3d } from './three-scene'
import { isPersp, isOrtho, orthoFrustum } from './camera3d'
import { activeCamera, scene3dProxy, type Scene3DDocument, type Scene3DInstance } from './scene3d-store'
import {
  boxSizeDiffers,
  defaultWindow,
  narrowPlanToSlice,
  quantiseSlice,
  rectCovers,
  sceneViewPlan,
  viewPlan,
  type BoxRect,
  type CropPlan,
} from './scene3d-viewframe'
import { nodeBoxRect } from './scene3d-crop-resize'

const FILL_U8_SIZE = 164 // matches api/constants FILL_U8_SIZE

// IN-PLACE edit composites the 3D live into Skia — the edited scene stays stacked in
// z-order while you orbit or drag, with only the gizmos and camera frustums on the overlay.
export function isLiveEditEnabled(): boolean {
  return true
}

/** Baking is the only path: a placed scene composites into Skia via its node's image fill. */
export function isBakeEnabled(): boolean {
  return true
}

// VIEWPORT CLIP: when a placed scene is zoomed in past the viewport, the bake renders only the
// on-screen slice at native resolution (via a cropped camera) instead of the whole node into
// one capped texture — so it stays 1:1 at any zoom rather than magnifying its own texels once
// the node outgrows MAX_BAKE_PX. A clipped bake sets `dest` (the box-local sub-rect the slice
// lands in) and Skia draws the slice there; see `ssa::fills::draw_image_fill`. It engages
// whenever a `visible` rect is passed and the node overflows it; pass `visible: null` (as a
// gesture or an export re-bake does) to force the whole node.

// SSAA factor: render the scene RT at bakeSSAA× the display size, then box-average it down in
// the encode pass. Added while chasing the reflection "quilt", which turned out to be Skia's
// leaked GL samplers (see clearSamplerBindings) — with that fixed, supersampling bought nothing
// but cost up to a 8192² render target per scene, so it's off (1 = plain MSAA via BAKE_SAMPLES).
// Raise it if genuinely high-frequency shading ever needs supersampling; the plumbing stays.
const bakeSSAA = 1

// SSAA scene RTs can go above the display cap (that's the point). Keep a separate, higher
// ceiling so the factor still applies to mid-size scenes; only the very largest nodes clamp.
const SUPER_CAP = 8192

/** When the scene RT is super-sized, give it a mip chain + trilinear min filter so the encode
 *  pass's fullscreen quad (rendered at display size, sampling the bigger texture) auto-selects
 *  the matching mip — a PROPER box downsample at ANY factor, unlike the 2-tap linear which only
 *  filters a 2× reduction. Without this, 4× SSAA barely helps. Off for 1× (no reduction). */
function configureSuperTexture(rt: THREE.WebGLRenderTarget, superSampled: boolean): void {
  rt.texture.generateMipmaps = superSampled
  rt.texture.minFilter = superSampled ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter
  rt.texture.magFilter = THREE.LinearFilter
  rt.texture.needsUpdate = true
}

/** The scene RT size for a given display size: display × bakeSSAA, clamped to SUPER_CAP.
 *  When super-sampling is in effect (factor > 1) we drop MSAA — the supersample already
 *  antialiases edges — else keep MSAA. Returns [superW, superH, samples]. */
function superSize(w: number, h: number): [number, number, number] {
  const target = Math.min(bakeSSAA, SUPER_CAP / Math.max(w, h))
  const f = Math.max(1, target) // never shrink below display; if display is already at the cap, f=1
  const samples = f > 1.01 ? 0 : BAKE_SAMPLES
  return [Math.round(w * f), Math.round(h * f), samples]
}

/** The visible world rectangle (canvas viewport in document coords), for viewport clipping. */
export interface VisibleWorld {
  left: number
  top: number
  right: number
  bottom: number
}

/** Where a bake lands inside the node: selrect coords [l,t,r,b], or null for the whole node. */
type Dest = [number, number, number, number]

interface BakeState {
  inst: Scene3DInstance
  rt: THREE.WebGLRenderTarget // scene render target (MSAA, LINEAR — three always writes linear to RTs)
  rtOut: THREE.WebGLRenderTarget // sRGB-encoded copy handed to Skia (the raw surface shows bytes as-is)
  texId: number // emscripten GL id for rtOut's texture (re-registered only on resize)
  imageId: string // stable Skia image id, so _update_image_from_texture overwrites in place
  w: number
  h: number
  filled: boolean // whether the node currently carries our baked image fill
  contentKey?: string // hash of what affects the rendered image; skip re-render if unchanged
  lastDest?: Dest | null // dest of the last render (re-asserted on skip)
  // The box-local region currently rendered. Held across frames on purpose: a pan reuses it
  // for as long as it still covers the view, so the scene re-renders once per cell crossed
  // rather than once per frame.
  slice?: BoxRect | null
  sliceZoom?: number // canvas zoom it was rendered at; reuse is only sound at that zoom
}

// A fullscreen pass that reads the LINEAR scene texture and writes sRGB-encoded bytes.
// three has no way to make a render target output sRGB (it hardwires workingColorSpace =
// linear for RTs), and render-wasm's Skia surface is unmanaged (no color space → shows
// bytes raw), so we encode ourselves. Without this the placed 3D is far too dark vs the
// canvas-rendered edit mode (which gets the canvas's own sRGB output encode).
let encoder: { scene: THREE.Scene; camera: THREE.Camera; material: THREE.ShaderMaterial } | null = null
function getEncoder(): { scene: THREE.Scene; camera: THREE.Camera; material: THREE.ShaderMaterial } {
  if (encoder) return encoder
  const material = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: null } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uTex;
      vec3 toSRGB(vec3 c){
        vec3 lo = c * 12.92;
        vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
        return mix(lo, hi, step(vec3(0.0031308), c));
      }
      void main(){
        vec4 t = texture2D(uTex, vUv);
        // The MSAA-resolved scene texture is PREMULTIPLIED at edges (coverage-weighted), and
        // Skia wants premultiplied — but sRGB must be applied to STRAIGHT colour. Un-premul,
        // encode, re-premul, so antialiased edges don't fringe dark.
        vec3 straight = t.a > 0.0 ? t.rgb / t.a : t.rgb;
        gl_FragColor = vec4(toSRGB(straight) * t.a, t.a);
      }
    `,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending, // write RGBA verbatim into the output RT
    side: THREE.DoubleSide,
  })
  const scene = new THREE.Scene()
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material))
  encoder = { scene, camera: new THREE.Camera(), material }
  return encoder
}

let bakeRenderer: THREE.WebGLRenderer | null = null
const bakeState = new Map<string, BakeState>()

function module(): WasmModule | null {
  return useWorkspaceStore.getState().wasmModule
}

/** Skia's live WebGL2 context (the one image fills already upload textures into). */
function sharedGL(m: WasmModule): WebGL2RenderingContext | null {
  const GL = (m as unknown as { GL?: { currentContext?: { GLctx?: WebGL2RenderingContext } } }).GL
  return GL?.currentContext?.GLctx ?? null
}

// Multisample count for the bake FBO — antialiasing edges (the renderer's `antialias`
// flag only covers the DEFAULT framebuffer, never a render target, so without this the
// baked 3D has jagged edges and reads as low-res).
const BAKE_SAMPLES = 4

function getBakeRenderer(m: WasmModule): THREE.WebGLRenderer | null {
  if (bakeRenderer) return bakeRenderer
  const gl = sharedGL(m)
  if (!gl) return null
  // antialias:false — AA comes from the render target's MSAA (BAKE_SAMPLES), not the
  // default framebuffer (which we never draw to). precision:'highp' — three's cubeUV env
  // lookup does precise UV math, so don't inherit whatever this Skia context defaults to.
  bakeRenderer = new THREE.WebGLRenderer({ context: gl, alpha: true, antialias: false, precision: 'highp' })
  bakeRenderer.setClearColor(0x000000, 0)
  bakeRenderer.autoClear = false
  return bakeRenderer
}

const MAX_BAKE_PX = 4096 // FBO cap: safe on effectively all GL implementations

/**
 * Much lower ceiling while a gesture is previewing a resize. The drag re-renders the scene
 * every frame INSIDE the gesture's own frame (see `bakeScenesDuringGesture`), and a lit
 * scene at 4096² with MSAA is far too much work to fit there — the drag goes to treacle.
 * Interaction wants a responsive picture, not a perfect one; the full-resolution bake
 * happens once when the gesture commits.
 */
const INTERACTIVE_BAKE_PX = 1024

// Device-pixel grid a viewport-clipped slice snaps to, so a PAN re-renders once per cell
// crossed instead of once per frame. Matches render-wasm's TILE_SIZE when enabled.
//
// DEFAULT 0 — render exactly what's visible, every frame. Snapping made the region jump a
// whole cell at a time rather than follow the drag, and a cell is ~512 screen px at ANY zoom
// (the grid is anchored in device pixels), so the jump stays large and obvious however far
// you're zoomed in. Following continuously costs a bake per frame; that is the trade, and
// smoothness won it. Raise it to 512 or 1024 to trade follow-accuracy for fewer bakes.
const sliceQuantum = 0
const warnedSize = new Set<string>()

/**
 * Unbind every GL SAMPLER OBJECT from every texture unit before three renders on the
 * shared context. Skia binds sampler objects (WebGL2), and while one is bound to a unit
 * it OVERRIDES the texture's own min/mag filter for whatever texture three samples on
 * that unit — a leftover NEAREST sampler re-filters the PMREM env atlas to NEAREST,
 * which magnifies its texel lattice into the diamond-quilt reflections. three never
 * binds nor clears sampler objects (resetState() included), so we must.
 */
function clearSamplerBindings(r: THREE.WebGLRenderer): void {
  const gl = r.getContext() as WebGL2RenderingContext
  if (typeof gl.bindSampler !== 'function') return
  const units = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number
  for (let u = 0; u < units; u++) gl.bindSampler(u, null)
}

/**
 * The bake FBO size — RESOLUTION-ADAPTIVE so the 3D stays crisp when you zoom in (a
 * rendered scene is raster, not vector, so it can't be zoom-independent like a path;
 * instead we re-render it at the resolution the current view actually needs).
 *
 * Target = the node's ON-SCREEN device pixels (docSize × zoom × dpr). We quantise the
 * zoom·dpr factor to power-of-2 steps so a continuous zoom gesture only reallocates the
 * texture when it crosses a step (not every frame), and cap so no dimension exceeds
 * MAX_BAKE_PX (memory guard — a raster ceiling, not a vector limit). Guards non-finite /
 * non-positive dims (which make three's texImage2D throw "out of range" → zero-size FBO).
 */
function bakeResolution(sceneId: string, zoom: number, maxPx = MAX_BAKE_PX): { w: number; h: number } | null {
  const node = getNode(sceneId) as { width?: number; height?: number } | undefined
  const w0 = node?.width
  const h0 = node?.height
  if (!Number.isFinite(w0) || !Number.isFinite(h0) || (w0 as number) <= 0 || (h0 as number) <= 0) {
    if (!warnedSize.has(sceneId)) {
      warnedSize.add(sceneId)
      console.warn('[scene3d-bake] skipping bake — bad node size', sceneId, { width: w0, height: h0 })
    }
    return null
  }
  return bakeTargetSize(w0 as number, h0 as number, zoom, window.devicePixelRatio || 1, maxPx)
}

/**
 * The render-target size for a region of `w0×h0` document units shown at `zoom`.
 *
 * Pure so the bake plan can be driven from tests. Target the region's ON-SCREEN device size
 * so Skia draws it ~1:1. Sizing ABOVE the display makes Skia minify, and bilinear
 * downsampling of the high-frequency chrome reflections aliases into a diamond/quilt moiré —
 * even a mild 1.35:1 minify shows it. So quantise to the NEAREST semitone (2^(1/12)) step,
 * not UP: the target lands within ~3% of 1:1 in either direction (imperceptible resample, no
 * moiré), while a continuous zoom only reallocates every ~6% of scale rather than every
 * frame. (The old half-octave CEIL overshot by up to 1.41×, which produced the quilt.)
 */
export function bakeTargetSize(
  w0: number,
  h0: number,
  zoom: number,
  dpr: number,
  maxPx: number,
): { w: number; h: number } | null {
  if (!(w0 > 0) || !(h0 > 0) || !Number.isFinite(w0) || !Number.isFinite(h0)) return null
  const want = Math.max(1e-3, (zoom > 0 ? zoom : 1) * dpr)
  let mult = Math.pow(2, Math.round(Math.log2(want) * 12) / 12)
  mult = Math.min(mult, maxPx / Math.max(w0, h0)) // cap (memory, or interaction)
  return { w: Math.max(16, Math.round(w0 * mult)), h: Math.max(16, Math.round(h0 * mult)) }
}

/** Build the per-scene bake instance/RT, or resize/rebuild it. Rebuilds when the active
 *  projection class flips (persp⇄ortho) so the camera type matches the doc. */
function ensureBakeState(r: THREE.WebGLRenderer, sceneId: string, doc: Scene3DDocument, w: number, h: number): BakeState {
  let st = bakeState.get(sceneId)
  const wantOrtho = activeCamera(doc).projection === 'orthographic'
  if (st && isOrtho(st.inst.camera) !== wantOrtho) {
    st.inst.dispose()
    st.rt.dispose()
    bakeState.delete(sceneId)
    st = undefined
  }
  if (!st) {
    // Clean three's state cache BEFORE building the instance: buildSceneInstance runs the
    // PMREM env generation (multi-pass cubemap + blur), and Skia rendered last on this shared
    // context, so without a reset three runs those passes against Skia's leftover GL bindings
    // → a corrupted/blocky env map that shows as a quilt in the sphere's reflections. This is
    // build-time only (instances are cached), so it never touches the per-frame Skia path.
    r.resetState()
    clearSamplerBindings(r) // Skia's sampler objects would NEAREST-filter the PMREM blur taps
    const inst = buildSceneInstance(r, doc)
    // Scene RT is SUPER-SIZED by bakeSSAA (the sharp mirror reflection is high-frequency and
    // aliases into a quilt at 1:1); the encode pass box-averages it down into rtOut at the
    // display size. rtOut is what Skia samples 1:1 — so the aliasing is resolved BEFORE Skia,
    // not left to Skia's poor 3:1 downsample (which is what produced the earlier moiré).
    const [sw, sh, samples] = superSize(w, h)
    const rt = new THREE.WebGLRenderTarget(sw, sh, { samples }) // scene → linear, super-sized (SSAA); MSAA only when ss=1
    configureSuperTexture(rt, sw > w)
    const rtOut = new THREE.WebGLRenderTarget(w, h) // sRGB-encoded + downsampled copy for Skia
    st = { inst, rt, rtOut, texId: -1, imageId: crypto.randomUUID(), w, h, filled: false }
    bakeState.set(sceneId, st)
  } else if (st.w !== w || st.h !== h) {
    const [sw, sh] = superSize(w, h)
    st.rt.setSize(sw, sh)
    configureSuperTexture(st.rt, sw > w)
    st.rtOut.setSize(w, h)
    st.texId = -1 // texture reallocated on resize → must re-register
    st.w = w
    st.h = h
  }
  return st
}

/** Frame the bake camera to the FBO aspect, render the scene into the RT, register its GL
 *  texture, and hand it to Skia as the node's image fill. Assumes st.inst is already
 *  reconciled and the context handed to three with a clean cache (caller resetState()s). */
function renderAndUpload(
  m: WasmModule,
  r: THREE.WebGLRenderer,
  sceneId: string,
  st: BakeState,
  w: number,
  h: number,
  dest: Dest | null,
  backdrop: string | null = null,
  crop: CropPlan | null = null,
  liveAspect: number | null = null,
): boolean {
  // Frame the camera. With no plan the whole node fills the FBO (aspect = w/h). With one,
  // the camera frames the reference frustum and setViewOffset crops it to the window —
  // whether that window is the scene's own framing, the on-screen slice of it, or the two
  // composed. The camera itself never moves: a dolly would change parallax, so the scene
  // would look different at different zooms. The box's size never reaches it either way.
  //
  // `liveAspect` is the box's aspect RIGHT NOW, which during a handle drag is not the
  // document's: the shape is previewed by a WASM modifier that scales the committed rect —
  // and with it our fill — at render time. The FBO's own shape only affects sharpness, so
  // framing on the live aspect pre-distorts the render by exactly the inverse and the
  // modifier's stretch cancels it. This is only sound because `bakeScenesDuringGesture`
  // runs in the SAME frame as the modifier it's correcting for; a frame of skew here shows
  // up as a per-frame squash, i.e. a wobble. A crop needs no correction — its camera is
  // pinned to the frame and the plan's fractions are already the live box's.
  const aspect = crop ? crop.fullW / crop.fullH : (liveAspect ?? w / h)
  const cam = st.inst.camera
  if (isPersp(cam)) {
    cam.aspect = aspect
  } else {
    const halfH = (cam.userData.orthoHalfHeight as number | undefined) ?? 1
    const f = orthoFrustum(halfH, aspect)
    cam.left = f.left
    cam.right = f.right
    cam.top = f.top
    cam.bottom = f.bottom
  }
  if (crop) cam.setViewOffset(crop.fullW, crop.fullH, crop.offX, crop.offY, crop.subW, crop.subH)
  else cam.clearViewOffset()
  cam.updateProjectionMatrix()
  // A placed scene bakes transparent so it composites over what's behind the node. The
  // scene being EDITED passes its backdrop through, so the box shows the background set in
  // the scene parameters — same value the overlay path paints when the bake is off.
  st.inst.scene.background = backdrop ? new THREE.Color(backdrop) : null
  // Skia rendered last on this shared context and leaves SAMPLER OBJECTS bound to texture
  // units. A bound sampler OVERRIDES the texture's own min/mag filter for whatever three
  // samples on that unit — Skia's NEAREST sampler re-filtered the PMREM env atlas, whose
  // magnified texel lattice is the diamond-quilt in the reflections. three never touches
  // sampler objects (resetState() included), so clear them ourselves before rendering.
  clearSamplerBindings(r)
  const [sw, sh] = superSize(w, h)
  r.setRenderTarget(st.rt)
  r.setScissorTest(false)
  r.setClearColor(0x000000, 0)
  r.clear(true, true, false) // whole RT — anything the viewport below misses is letterbox
  // Render the scene super-sized (SSAA); the encode pass box-averages down to w×h. A crop
  // covers only its slice of the RT: the FBO maps 1:1 onto the node, so the plan's box
  // fractions are the RT's, flipped for GL's bottom-left origin.
  if (crop) {
    r.setViewport(crop.fx * sw, (1 - crop.fy - crop.fh) * sh, crop.fw * sw, crop.fh * sh)
  } else {
    r.setViewport(0, 0, sw, sh)
  }
  r.render(st.inst.scene, cam)
  r.setRenderTarget(null)

  // Encode the LINEAR scene texture to sRGB bytes (three writes linear to RTs; the Skia
  // surface is unmanaged and shows bytes raw, so we must pre-encode or it reads dark).
  {
    const enc = getEncoder()
    enc.material.uniforms.uTex.value = st.rt.texture
    r.setRenderTarget(st.rtOut)
    r.setViewport(0, 0, w, h)
    r.setScissorTest(false)
    r.setClearColor(0x000000, 0)
    r.clear(true, false, false)
    r.render(enc.scene, enc.camera)
    r.setRenderTarget(null)
  }

  const outTex = st.rtOut.texture
  const webglTex = (r.properties.get(outTex) as { __webglTexture?: WebGLTexture }).__webglTexture
  if (!webglTex) {
    r.resetState()
    return false
  }
  const GL = (m as unknown as { GL: { getNewId: (t: unknown[]) => number; textures: unknown[] } }).GL
  if (st.texId < 0) st.texId = GL.getNewId(GL.textures)
  GL.textures[st.texId] = webglTex

  r.resetState() // hand back to Skia with a clean three cache, THEN touch WASM
  writeTextureHeader(m, sceneId, st.imageId, st.texId, w, h)
  m._update_image_from_texture()
  freeBytes(m)
  setNodeImageFill(m, sceneId, st.imageId, w, h, dest)
  st.filled = true
  st.lastDest = dest
  return true
}

function warnBakeFail(sceneId: string, e: unknown): void {
  if (warnedSize.has(sceneId + ':err')) return
  warnedSize.add(sceneId + ':err')
  console.warn('[scene3d-bake] bake failed for', sceneId, e)
}

/** Common prelude: module + shared-context renderer. Returns null to bail. */
function bakePrep(): { m: WasmModule; r: THREE.WebGLRenderer } | null {
  const m = module()
  if (!m || typeof (m as { _update_image_from_texture?: unknown })._update_image_from_texture !== 'function') return null
  const r = getBakeRenderer(m)
  if (!r) return null
  return { m, r }
}

/**
 * Decide the FBO size + optional viewport clip for a placed scene. When the node is fully
 * on screen (or clipping is off) → whole-node bake (cacheable during pan). When it's zoomed
 * past the viewport → render only the on-screen slice at native resolution (≤ viewport).
 */
/** The bake to perform for one scene this frame. `offscreen` means the node isn't visible
 *  at all: nothing to render, and the node keeps whatever fill it already had. */
export type BakePlan =
  | { kind: 'offscreen' }
  | {
      kind: 'bake'
      w: number
      h: number
      crop: CropPlan | null
      dest: Dest | null
      slice: BoxRect | null
    }

/**
 * Decide what to render for one scene — the whole policy, pure, so it can be driven from
 * tests without a WebGL context. `computeBakePlan` is the thin adapter that reads the node.
 *
 * Cost, for orientation: a bake of this shape is affordable per frame — editing a scene in
 * place already bakes the WHOLE node (up to 4096² with 4× MSAA, uncached) at 60fps, and a
 * viewport-bounded slice is strictly smaller. Several scenes share one viewport, so their
 * slices sum to at most one screen of pixels. What multiplies per scene is the FIXED cost of
 * a bake — state reset, sRGB encode, texture registration, GrContext resync — so if that
 * ever bites, batch those across scenes rather than making the slices coarser.
 *
 * `held` is the region rendered on a previous frame, and `heldZoom` the zoom it was rendered
 * at. Passing them back lets a PAN reuse that render for as long as it still covers the view
 * — the one gesture where the visible region changes every frame and there is otherwise
 * nothing to reuse. Pass null to force a fresh region; `quantum` of 0 disables reuse.
 */
export function planSliceBake(p: {
  box: BoxRect
  zoom: number
  dpr: number
  visible: VisibleWorld | null
  crop: CropPlan | null
  held: BoxRect | null
  heldZoom?: number | null
  quantum: number
  maxPx: number
}): BakePlan | null {
  const { box, zoom, dpr, visible, crop, held, heldZoom, quantum, maxPx } = p
  if (!(box.w > 0) || !(box.h > 0)) return null

  const wholeNode = (): BakePlan | null => {
    const size = bakeTargetSize(box.w, box.h, zoom, dpr, maxPx)
    return size && { kind: 'bake', w: size.w, h: size.h, crop, dest: null, slice: null }
  }
  // No viewport to clip to (a gesture bake, or an export passing its own whole-node rect) ⇒
  // bake the whole node. Otherwise narrow to the on-screen slice below.
  if (!visible) return wholeNode()

  const { x, y, w: w0, h: h0 } = box
  const vl = Math.max(x, visible.left)
  const vt = Math.max(y, visible.top)
  const vr = Math.min(x + w0, visible.right)
  const vb = Math.min(y + h0, visible.bottom)
  // Nothing on screen. Deliberately NOT a failure: reporting failure would send the caller
  // down the overlay path, which builds and renders a three instance every frame for a
  // scene nobody can see — and with several scenes in a document that is most of them.
  if (vr <= vl || vb <= vt) return { kind: 'offscreen' }

  // Fully (or nearly) on screen ⇒ whole-node path. Clipping only earns its keep once the
  // node outgrows the viewport; below that the whole-node bake is strictly better, because
  // it survives a pan untouched.
  const eps = Math.min(w0, h0) * 0.002
  if (vl <= x + eps && vt <= y + eps && vr >= x + w0 - eps && vb >= y + h0 - eps) return wholeNode()

  // Reuse the region already rendered for as long as it still covers the view. The grid is
  // anchored in DEVICE pixels, so a cell always costs the same work whatever the zoom.
  //
  // Reuse is gated on the zoom being unchanged, and that gate is load-bearing rather than a
  // nicety. Covering the view is NOT sufficient: zooming in shrinks the view, so a region
  // captured while zoomed out keeps covering it forever, while the device pixels it needs
  // grow with the zoom until they hit `maxPx` — reintroducing exactly the magnification this
  // path exists to remove (measured: 1.01 → 0.10 texels/px over three octaves). Hysteresis
  // buys a pan, where the view keeps its size; a zoom re-renders regardless, since the target
  // size is part of the plan.
  const view: BoxRect = { x: vl - x, y: vt - y, w: vr - vl, h: vb - vt }
  // `quantum > 0` gates reuse as well as snapping: the two are one feature. At 0 the region
  // is the visible rect exactly, re-derived every frame, which is what "follows the drag"
  // means — holding a covering-but-stale region would put it back to jumping.
  const reusable = quantum > 0 && heldZoom != null && heldZoom === zoom && rectCovers(held, view)
  const slice = reusable
    ? (held as BoxRect)
    : quantum > 0
      ? quantiseSlice(view, w0, h0, quantum / Math.max(1e-6, zoom * dpr))
      : view

  // The window we'd show across the whole box, narrowed to that region. A scene with no
  // plan is showing its canonical framing, so materialise that first — the narrowing has to
  // happen in the SAME reference frustum either way, which is what lets a viewport clip
  // compose with a resize instead of fighting it.
  const base = crop ?? viewPlan(defaultWindow(w0, h0), w0, h0)
  if (!base) return null
  const narrowed = narrowPlanToSlice(base, w0, h0, slice)
  if (!narrowed) return null

  // Target = the region's own on-screen device pixels, so Skia draws it 1:1 however far the
  // canvas is zoomed. The region is bounded by the viewport (plus one cell), so the cap now
  // bounds the SCREEN rather than the node — it stops being a resolution ceiling.
  //
  // NOTE for whoever wires file export (render_shape_pixels): the node's fill is then only
  // what the SCREEN needed, so exporting a zoomed-in scene would emit just that slice.
  // Re-bake with `visible` covering the whole node first — it's a parameter precisely so
  // the export can pass its own rect.
  const d = narrowed.dest
  const size = bakeTargetSize(d.w, d.h, zoom, dpr, maxPx)
  if (!size) return null
  return {
    kind: 'bake',
    w: size.w,
    h: size.h,
    crop: narrowed.plan,
    dest: [x + d.x, y + d.y, x + d.x + d.w, y + d.y + d.h],
    slice,
  }
}

/** `planSliceBake` for a scene, reading the node rect and the held slice from module state.
 *
 * `liveBox` is the box RIGHT NOW — during a drag the WASM modifier has already moved/resized
 * the shape, and render-wasm applies modifiers by mutating `selrect` itself, so the rect our
 * `dest` is drawn against at paint time is the LIVE one. Planning against the committed rect
 * instead put the slice at the pre-drag position and size, which is what made a clipped scene
 * jump and stretch while it was dragged (an unclipped one has no `dest`, so it never showed).
 */
function computeBakePlan(
  sceneId: string,
  zoom: number,
  visible: VisibleWorld | undefined,
  crop: CropPlan | null,
  maxPx = MAX_BAKE_PX,
  liveBox: BoxRect | null = null,
): BakePlan | null {
  const box = liveBox ?? nodeBoxRect(getNode(sceneId))
  if (!box) {
    if (!warnedSize.has(sceneId)) {
      warnedSize.add(sceneId)
      console.warn('[scene3d-bake] skipping bake — bad node size', sceneId)
    }
    return null
  }
  return planSliceBake({
    box,
    zoom,
    dpr: window.devicePixelRatio || 1,
    visible: visible ?? null,
    crop,
    held: bakeState.get(sceneId)?.slice ?? null,
    heldZoom: bakeState.get(sceneId)?.sliceZoom ?? null,
    quantum: sliceQuantum,
    maxPx,
  })
}

/**
 * Bake a PLACED scene: reconcile the instance from the document and composite it into the
 * node's fill. Call once per frame per placed scene; then request a Skia render. `visible`
 * (canvas viewport in doc coords) drives viewport clipping when enabled.
 */
export function bakeSceneToNode(
  sceneId: string,
  doc: Scene3DDocument,
  zoom: number,
  visible?: VisibleWorld,
  crop: CropPlan | null = null,
  liveAspect: number | null = null,
  interactive = false,
  liveBox: BoxRect | null = null,
): boolean {
  const p = bakePrep()
  if (!p) return false
  // The scene's own framing and the viewport clip are both windows onto the same reference
  // frustum, so the plan composes them into one view offset rather than choosing between
  // them. `interactive` must be decided the same way by every caller in a given frame, or
  // their cache keys diverge and each one re-renders the scene for the other.
  const plan = computeBakePlan(
    sceneId,
    zoom,
    visible,
    crop,
    interactive ? INTERACTIVE_BAKE_PX : MAX_BAKE_PX,
    liveBox,
  )
  if (!plan) return false
  // Off screen: nothing to render, and the node keeps the fill it already had. Report it
  // handled so the caller skips the overlay path instead of rendering an invisible scene.
  if (plan.kind === 'offscreen') return true
  try {
    const st = ensureBakeState(p.r, sceneId, doc, plan.w, plan.h)
    st.slice = plan.slice
    st.sliceZoom = zoom

    // Skip the (potentially expensive, high-res) re-render when nothing that affects the
    // IMAGE changed. The key includes the clip slice, so a whole-node bake stays cached
    // during pan/move (only position moves — Skia re-composites the fill), while a clipped
    // bake re-renders as the visible slice changes. Re-assert the fill (a node mod-obj may
    // have cleared it) with the SAME dest, and return without touching three.
    const pc = plan.crop
    const cropKey = pc ? `${pc.offX},${pc.offY},${pc.subW},${pc.subH},${pc.fx},${pc.fy},${pc.fw},${pc.fh}` : 'nocrop'
    // liveAspect is in the key so a drag that only changes the box's PROPORTIONS still
    // re-renders — the FBO size alone doesn't move until the gesture commits.
    const key = `${plan.w}x${plan.h}|${plan.dest ? plan.dest.join(',') : 'full'}|${cropKey}|${liveAspect ?? 'na'}|${JSON.stringify(doc)}`
    if (st.contentKey === key && st.texId >= 0) {
      setNodeImageFill(p.m, sceneId, st.imageId, st.w, st.h, st.lastDest ?? null)
      st.filled = true
      return true
    }

    // Clean cache BEFORE any three work — Skia rendered last and left the shared context in
    // its own state (three, esp. PMREM, must re-bind or it draws with Skia's buffers).
    p.r.resetState()
    applyDocToInstance(st.inst, doc)
    const ok = renderAndUpload(p.m, p.r, sceneId, st, plan.w, plan.h, plan.dest, null, plan.crop, liveAspect)
    if (ok) st.contentKey = key
    return ok
  } catch (e) {
    p.r.resetState()
    warnBakeFail(sceneId, e)
    return false
  }
}

/**
 * Is this node the gesture's target, or inside it? A resized GROUP previews its children
 * through constraint propagation, so a scene being stretched need not be selected itself.
 * Walks the parent chain with a depth guard so a malformed cycle can't hang a drag frame.
 */
function isUnderGesture(nodeId: string, gestureIds: ReadonlySet<string>): boolean {
  let id: string | undefined = nodeId
  for (let depth = 0; id && depth < 64; depth++) {
    if (gestureIds.has(id)) return true
    id = (getNode(id) as { parentId?: string } | undefined)?.parentId
  }
  return false
}

/**
 * Re-bake every scene whose box a gesture is currently previewing — IN the caller's frame.
 *
 * A 2D handle drag scales the shape through a WASM modifier: the document rect stays put and
 * the modifier stretches the shape, our image fill included, at render time. Our own redraw
 * is only SCHEDULED, so left to itself Skia composites the frame with the texture baked for
 * the PREVIOUS frame's box — one frame of size delta, applied as a squash that changes every
 * frame. That's a visible wobble, and no amount of correction fixes it from the wrong frame.
 *
 * So the gesture calls this directly, after setting its modifiers and before asking Skia to
 * render. Texture and modifier then come from the same frame, the `liveAspect` pre-distortion
 * is exact, and the scene keeps compositing in z-order for the whole drag.
 *
 * It scans all scenes rather than the selection: a resized GROUP previews its children
 * through constraint propagation, so a scene being stretched need not be selected itself.
 * Only scenes whose live box actually disagrees with the committed one do any work.
 */
export function bakeScenesDuringGesture(gestureIds: ReadonlySet<string>): void {
  if (scene3dProxy.scenes.size === 0 || gestureIds.size === 0) return
  const wsRenderer = useWorkspaceStore.getState().renderer
  if (!wsRenderer) return
  const zoom = viewport.value?.zoom ?? 1

  for (const [sceneId, sceneSnap] of scene3dProxy.scenes) {
    // Only scenes the gesture can actually be moving. `getSelectionRect` is a WASM call
    // that recomputes a bounding box, so asking it about every scene in the document on
    // every frame of a drag is exactly the sort of cost that makes a gesture feel heavy.
    // A parent walk over the proxy is free by comparison.
    if (!isUnderGesture(sceneId, gestureIds)) continue
    const doc = sceneSnap as Scene3DDocument
    const sel = wsRenderer.getSelectionRect?.([sceneId])
    if (!sel || !(sel.width > 0) || !(sel.height > 0)) continue
    const committed = nodeBoxRect(getNode(sceneId))
    if (!committed) continue
    const live: BoxRect = {
      x: sel.center.x - sel.width / 2,
      y: sel.center.y - sel.height / 2,
      w: sel.width,
      h: sel.height,
    }
    // Same size ⇒ no resize in flight (a MOVE only shifts the fill, which composites fine).
    if (!boxSizeDiffers(committed, live)) continue

    const crop = sceneViewPlan(doc, live, committed)
    bakeSceneToNode(sceneId, doc, zoom, undefined, crop, live.w / live.h, true)
  }
  // No render is requested here: the caller asks for the Skia frame on the very next line,
  // and that ordering — fill first, frame second — is the entire point of this function.
}

/**
 * Bake the scene BEING EDITED, mirroring the live overlay instance — so the 3D stays
 * composited in Skia (true z-order) while you orbit/drag, instead of jumping onto the
 * floating overlay. Orbit isn't written to the doc until gesture-end, so we copy the
 * camera pose + object transforms straight from `srcInst` (the overlay's live instance)
 * rather than the lagging document. The overlay then draws only the edit chrome on top.
 */
export function bakeEditingScene(
  sceneId: string,
  doc: Scene3DDocument,
  srcInst: Scene3DInstance,
  zoom: number,
  backdrop: string | null = null,
  crop: CropPlan | null = null,
): boolean {
  const p = bakePrep()
  if (!p) return false
  const size = bakeResolution(sceneId, zoom) // editing always bakes the whole node (no clip)
  if (!size) return false
  p.r.resetState()
  try {
    const st = ensureBakeState(p.r, sceneId, doc, size.w, size.h)
    applyDocToInstance(st.inst, doc) // reconcile object add/remove + materials from the doc
    // Then override transforms from the LIVE overlay instance (the doc lags mid-gesture).
    st.inst.camera.position.copy(srcInst.camera.position)
    st.inst.camera.quaternion.copy(srcInst.camera.quaternion)
    st.inst.camera.zoom = srcInst.camera.zoom
    if (isOrtho(st.inst.camera) && isOrtho(srcInst.camera)) {
      st.inst.camera.userData.orthoHalfHeight = srcInst.camera.userData.orthoHalfHeight
    }
    for (const [id, dst] of st.inst.objects) {
      const src = srcInst.objects.get(id)
      if (src) {
        dst.position.copy(src.position)
        dst.quaternion.copy(src.quaternion)
        dst.scale.copy(src.scale)
      }
    }
    return renderAndUpload(p.m, p.r, sceneId, st, size.w, size.h, null, backdrop, crop)
  } catch (e) {
    p.r.resetState()
    warnBakeFail(sceneId, e)
    return false
  }
}

/** Whether this scene currently has bake state (⇒ its overlay draw should be skipped). */
export function isBaked(sceneId: string): boolean {
  return bakeState.has(sceneId)
}

export function disposeBakeScene(sceneId: string): void {
  const st = bakeState.get(sceneId)
  if (!st) return
  st.inst.dispose()
  st.rt.dispose()
  st.rtOut.dispose()
  clearNodeFill(sceneId)
  bakeState.delete(sceneId)
}

/**
 * Clear a baked node's fill WITHOUT tearing down its bake state — the edit⇄placed
 * handoff: entering edit hands the scene to the live overlay, so its stale baked image
 * must go, but we keep the instance/RT so re-baking on Done is instant. Returns true if
 * a fill was actually cleared (caller should request a Skia frame to drop it).
 */
export function unbakeNodeFill(sceneId: string): boolean {
  const st = bakeState.get(sceneId)
  if (!st || !st.filled) return false
  clearNodeFill(sceneId)
  st.filled = false
  return true
}

/**
 * Raycast a baked scene at a canvas point to the 3D object under it. Uses the BAKE
 * instance — the exact scene + camera that produced the on-screen image — so the pick
 * matches what the user sees. The node's rect maps 1:1 to the baked image (Skia draws
 * the fill over the node's geometry), so screen→NDC is just the point's position within
 * that rect. Returns the object id (cameras have no frustum in the baked image, so only
 * meshes are pickable here). Powers double-click-into-edit landing on the clicked object.
 */
export function pickBakedObjectAtScreen(sceneId: string, screenX: number, screenY: number): string | null {
  const st = bakeState.get(sceneId)
  if (!st) return null
  const node = getNode(sceneId) as { x?: number; y?: number; width?: number; height?: number } | undefined
  const vp = viewport.value
  if (!node || !vp || node.x == null || node.y == null || !node.width || !node.height) return null
  const tl = worldToScreen(vp, node.x, node.y)
  const sw = node.width * vp.zoom
  const sh = node.height * vp.zoom
  if (sw <= 0 || sh <= 0) return null
  const ndcX = ((screenX - tl.x) / sw) * 2 - 1
  const ndcY = -(((screenY - tl.y) / sh) * 2 - 1)
  if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) return null
  const hit = pickScene3d(st.inst, ndcX, ndcY, st.inst.camera)
  return hit && hit.kind === 'object' ? hit.id : null
}

/**
 * Drop bake state for scenes that no longer exist (deleted). Called with the live scene
 * id set each frame. The node is gone, so we only free GPU resources — no fill to clear.
 */
export function reconcileBakes(activeIds: Set<string>): void {
  for (const id of [...bakeState.keys()]) {
    if (activeIds.has(id)) continue
    const st = bakeState.get(id)!
    st.inst.dispose()
    st.rt.dispose()
    st.rtOut.dispose()
    bakeState.delete(id)
  }
}

// --- WASM byte writers (mirror api/fills.ts layouts; used raw so we don't depend on the
//     checkContext-gated api wrappers) ---

function writeTextureHeader(m: WasmModule, nodeId: string, imageId: string, texId: number, w: number, h: number): void {
  const off = allocBytes(m, 48)
  const dv = new DataView(m.HEAPU8.buffer, m.HEAPU8.byteOffset)
  writeUUIDToDataView(dv, off, nodeId)
  writeUUIDToDataView(dv, off + 16, imageId)
  dv.setUint32(off + 32, 0, true) // thumbnail = false
  dv.setUint32(off + 36, texId, true)
  dv.setInt32(off + 40, w, true)
  dv.setInt32(off + 44, h, true)
}

// `dest` (local/selrect coords [l,t,r,b]) draws the image only into that sub-rect of the
// node — the viewport-clipped slice — instead of over the whole node. null = whole node.
function setNodeImageFill(
  m: WasmModule,
  nodeId: string,
  imageId: string,
  w: number,
  h: number,
  dest: [number, number, number, number] | null,
): void {
  const [a, b, c, d] = uuidToU32Tuple(nodeId)
  ;(m as unknown as { _use_shape: (a: number, b: number, c: number, d: number) => void })._use_shape(a, b, c, d)
  const off = allocBytes(m, 4 + FILL_U8_SIZE)
  const dv = new DataView(m.HEAPU8.buffer, m.HEAPU8.byteOffset)
  dv.setUint32(off, 1, true) // one fill
  const f = off + 4
  dv.setUint8(f, 0x03) // image fill
  writeUUIDToDataView(dv, f + 4, imageId)
  dv.setUint8(f + 20, 0xff) // alpha
  dv.setUint8(f + 21, dest ? 0x02 : 0x00) // flags: bit1 = FLAG_HAS_DEST
  dv.setUint32(f + 24, w, true)
  dv.setUint32(f + 28, h, true)
  if (dest) {
    dv.setFloat32(f + 32, dest[0], true)
    dv.setFloat32(f + 36, dest[1], true)
    dv.setFloat32(f + 40, dest[2], true)
    dv.setFloat32(f + 44, dest[3], true)
  }
  ;(m as unknown as { _set_shape_fills: () => void })._set_shape_fills()
  freeBytes(m)
}

function clearNodeFill(nodeId: string): void {
  const m = module()
  if (!m) return
  const [a, b, c, d] = uuidToU32Tuple(nodeId)
  ;(m as unknown as { _use_shape: (a: number, b: number, c: number, d: number) => void })._use_shape(a, b, c, d)
  ;(m as unknown as { _clear_shape_fills: () => void })._clear_shape_fills()
}

