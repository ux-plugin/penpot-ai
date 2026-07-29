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
 * Default ON. A/B toggle live:  window.__scene3dBake(true|false)
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
import { boxSizeDiffers, sceneViewPlan, type BoxRect, type CropPlan } from './scene3d-viewframe'
import { nodeBoxRect } from './scene3d-crop-resize'

const FILL_U8_SIZE = 164 // matches api/constants FILL_U8_SIZE

// Default ON — baking is the normal path now; the toggle stays for A/B debugging.
let bakeEnabled = true
export function setBakeEnabled(on: boolean): void {
  bakeEnabled = on
  if (!on) {
    // Restore every baked node to a plain (fill-less) rect so the overlay path takes over.
    for (const id of bakeState.keys()) unbakeNodeFill(id)
    useWorkspaceStore.getState().renderer?.requestRenderFrame() // drop the fills now
  }
}
export function isBakeEnabled(): boolean {
  return bakeEnabled
}

// Default ON — IN-PLACE edit composites the 3D live into Skia (stays stacked while you
// orbit/drag), with only the gizmos/frustums on the overlay. Off ⇒ classic full overlay
// while editing. Toggle: window.__scene3dLiveEdit(true|false)
let liveEditEnabled = true
export function setLiveEditEnabled(on: boolean): void {
  liveEditEnabled = on
}
export function isLiveEditEnabled(): boolean {
  return liveEditEnabled
}

// VIEWPORT CLIP: when a placed scene is zoomed in past the viewport, render only the
// on-screen slice at native resolution (via a cropped camera) instead of the whole node
// into one capped texture. Default OFF while it's tuned. Toggle: window.__scene3dViewportClip
let viewportClipEnabled = false
export function setViewportClipEnabled(on: boolean): void {
  viewportClipEnabled = on
}

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

/** A viewport-clipped bake: render only the node's on-screen slice, cropped via the camera,
 *  and place it at `dest` (local/selrect coords) within the node. */
interface Clip {
  fullW: number // node size in doc units = the camera's full frame
  fullH: number
  offX: number // slice offset within the node (doc units)
  offY: number
  subW: number // slice size (doc units)
  subH: number
  dest: [number, number, number, number] // slice in selrect coords [l,t,r,b]
}

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
  lastDest?: [number, number, number, number] | null // dest of the last render (re-asserted on skip)
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
  const dpr = window.devicePixelRatio || 1
  // Target the node's ON-SCREEN device size so Skia draws the texture ~1:1. Sizing it ABOVE
  // the display makes Skia minify, and bilinear downsampling of the high-frequency chrome
  // reflections aliases into a diamond/quilt moiré — even a mild 1.35:1 minify shows it. So
  // quantise to the NEAREST semitone (2^(1/12)) step, not UP: the FBO lands within ~3% of
  // 1:1 in either direction (imperceptible resample, no moiré), while a continuous zoom only
  // reallocates the texture every ~6% of scale, not every frame. (The old half-octave CEIL
  // overshot by up to 1.41×, which is what produced the quilt.)
  const want = Math.max(1e-3, (zoom > 0 ? zoom : 1) * dpr)
  let mult = Math.pow(2, Math.round(Math.log2(want) * 12) / 12)
  mult = Math.min(mult, maxPx / Math.max(w0 as number, h0 as number)) // cap (memory, or interaction)
  const pw = Math.max(16, Math.round((w0 as number) * mult))
  const ph = Math.max(16, Math.round((h0 as number) * mult))
  return { w: pw, h: ph }
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
  clip: Clip | null,
  backdrop: string | null = null,
  crop: CropPlan | null = null,
  liveAspect: number | null = null,
): boolean {
  // Frame the camera. Without a clip the whole node fills the FBO (aspect = w/h). With a
  // clip the camera frames the WHOLE node (aspect = node aspect) and setViewOffset crops it
  // to the on-screen slice — same view/perspective, all the FBO's pixels on what's visible.
  // A CROP-mode scene instead frames its own fixed view frame and crops that, so the box's
  // size never reaches the camera; it letterboxes into a sub-rect of the FBO below.
  //
  // `liveAspect` is the box's aspect RIGHT NOW, which during a handle drag is not the
  // document's: the shape is previewed by a WASM modifier that scales the committed rect —
  // and with it our fill — at render time. The FBO's own shape only affects sharpness, so
  // framing on the live aspect pre-distorts the render by exactly the inverse and the
  // modifier's stretch cancels it. This is only sound because `bakeScenesDuringGesture`
  // runs in the SAME frame as the modifier it's correcting for; a frame of skew here shows
  // up as a per-frame squash, i.e. a wobble. A crop needs no correction — its camera is
  // pinned to the frame and the plan's fractions are already the live box's.
  const aspect = crop
    ? crop.fullW / crop.fullH
    : clip
      ? clip.fullW / clip.fullH
      : (liveAspect ?? w / h)
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
  else if (clip) cam.setViewOffset(clip.fullW, clip.fullH, clip.offX, clip.offY, clip.subW, clip.subH)
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
  const dest = clip ? clip.dest : null
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
function computeBakePlan(
  sceneId: string,
  zoom: number,
  visible: VisibleWorld | undefined,
  maxPx = MAX_BAKE_PX,
): { w: number; h: number; clip: Clip | null } | null {
  const node = getNode(sceneId) as { x?: number; y?: number; width?: number; height?: number } | undefined
  const nx = node?.x
  const ny = node?.y
  const nw = node?.width
  const nh = node?.height
  if (![nx, ny, nw, nh].every((v) => Number.isFinite(v)) || (nw as number) <= 0 || (nh as number) <= 0) return null

  const wholeNode = (): { w: number; h: number; clip: null } | null => {
    const size = bakeResolution(sceneId, zoom, maxPx)
    return size ? { w: size.w, h: size.h, clip: null } : null
  }
  if (!viewportClipEnabled || !visible) return wholeNode()

  const x = nx as number, y = ny as number, w0 = nw as number, h0 = nh as number
  const sl = Math.max(x, visible.left)
  const st = Math.max(y, visible.top)
  const sr = Math.min(x + w0, visible.right)
  const sb = Math.min(y + h0, visible.bottom)
  const sw = sr - sl
  const sh = sb - st
  if (sw <= 0 || sh <= 0) return null // node fully off-screen — skip

  // Fully (or nearly) on screen ⇒ whole-node path (so panning stays cached, no re-render).
  const eps = Math.min(w0, h0) * 0.002
  if (sl <= x + eps && st <= y + eps && sr >= x + w0 - eps && sb >= y + h0 - eps) return wholeNode()

  // Clipped: FBO = the slice's on-screen device pixels, capped (aspect-preserved).
  const dpr = window.devicePixelRatio || 1
  let pw = Math.round(sw * zoom * dpr)
  let ph = Math.round(sh * zoom * dpr)
  const scale = Math.min(1, MAX_BAKE_PX / Math.max(pw, ph))
  pw = Math.max(16, Math.round(pw * scale))
  ph = Math.max(16, Math.round(ph * scale))
  const clip: Clip = { fullW: w0, fullH: h0, offX: sl - x, offY: st - y, subW: sw, subH: sh, dest: [sl, st, sr, sb] }
  return { w: pw, h: ph, clip }
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
): boolean {
  const p = bakePrep()
  if (!p) return false
  // A crop already owns the camera's view offset, and the viewport clip drives the same
  // dial — composing the two is its own slice, so a crop-mode scene bakes whole-node.
  // `interactive` must be decided the same way by every caller in a given frame, or their
  // cache keys diverge and each one re-renders the scene for the other.
  const plan = computeBakePlan(
    sceneId,
    zoom,
    crop ? undefined : visible,
    interactive ? INTERACTIVE_BAKE_PX : MAX_BAKE_PX,
  )
  if (!plan) return false
  try {
    const st = ensureBakeState(p.r, sceneId, doc, plan.w, plan.h)

    // Skip the (potentially expensive, high-res) re-render when nothing that affects the
    // IMAGE changed. The key includes the clip slice, so a whole-node bake stays cached
    // during pan/move (only position moves — Skia re-composites the fill), while a clipped
    // bake re-renders as the visible slice changes. Re-assert the fill (a node mod-obj may
    // have cleared it) with the SAME dest, and return without touching three.
    const cropKey = crop ? `${crop.fx},${crop.fy},${crop.fw},${crop.fh},${crop.offX},${crop.offY}` : 'nocrop'
    // liveAspect is in the key so a drag that only changes the box's PROPORTIONS still
    // re-renders — the FBO size alone doesn't move until the gesture commits.
    const key = `${plan.w}x${plan.h}|${plan.clip ? plan.clip.dest.join(',') : 'full'}|${cropKey}|${liveAspect ?? 'na'}|${JSON.stringify(doc)}`
    if (st.contentKey === key && st.texId >= 0) {
      setNodeImageFill(p.m, sceneId, st.imageId, st.w, st.h, st.lastDest ?? null)
      st.filled = true
      return true
    }

    // Clean cache BEFORE any three work — Skia rendered last and left the shared context in
    // its own state (three, esp. PMREM, must re-bind or it draws with Skia's buffers).
    p.r.resetState()
    applyDocToInstance(st.inst, doc)
    const ok = renderAndUpload(p.m, p.r, sceneId, st, plan.w, plan.h, plan.clip, null, crop, liveAspect)
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
  return bakeEnabled && bakeState.has(sceneId)
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

// Kill switches, for falling back when a render target misbehaves — and the only way to
// reach the viewport clip, which is still off by default.
// Guarded: the 2D resize handler imports this module to keep the bake in step with its
// modifiers, which drags it into test files that run without a DOM.
if (typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>
  w.__scene3dBake = setBakeEnabled
  w.__scene3dLiveEdit = setLiveEditEnabled
  w.__scene3dViewportClip = setViewportClipEnabled
}