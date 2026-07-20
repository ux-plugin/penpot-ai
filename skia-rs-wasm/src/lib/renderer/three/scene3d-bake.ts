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
import { activeCamera, type Scene3DDocument, type Scene3DInstance } from './scene3d-store'

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

/** Per-scene snapshot of the last bake plan — call window.__bakeDebug() zoomed in. */
const bakeDebug = new Map<string, unknown>()

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
function bakeResolution(sceneId: string, zoom: number): { w: number; h: number } | null {
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
  mult = Math.min(mult, MAX_BAKE_PX / Math.max(w0 as number, h0 as number)) // cap (memory)
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
): boolean {
  // Frame the camera. Without a clip the whole node fills the FBO (aspect = w/h). With a
  // clip the camera frames the WHOLE node (aspect = node aspect) and setViewOffset crops it
  // to the on-screen slice — same view/perspective, all the FBO's pixels on what's visible.
  const aspect = clip ? clip.fullW / clip.fullH : w / h
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
  if (clip) cam.setViewOffset(clip.fullW, clip.fullH, clip.offX, clip.offY, clip.subW, clip.subH)
  else cam.clearViewOffset()
  cam.updateProjectionMatrix()
  st.inst.scene.background = null // transparent → the 3D composites over what's behind the node
  // Skia rendered last on this shared context and leaves SAMPLER OBJECTS bound to texture
  // units. A bound sampler OVERRIDES the texture's own min/mag filter for whatever three
  // samples on that unit — Skia's NEAREST sampler re-filtered the PMREM env atlas, whose
  // magnified texel lattice is the diamond-quilt in the reflections. three never touches
  // sampler objects (resetState() included), so clear them ourselves before rendering.
  clearSamplerBindings(r)
  const [sw, sh] = superSize(w, h)
  r.setRenderTarget(st.rt)
  r.setViewport(0, 0, sw, sh) // render the scene super-sized (SSAA); encode pass box-averages down to w×h
  r.setScissorTest(false)
  r.setClearColor(0x000000, 0)
  r.clear(true, true, false)
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
function computeBakePlan(sceneId: string, zoom: number, visible: VisibleWorld | undefined): { w: number; h: number; clip: Clip | null } | null {
  const node = getNode(sceneId) as { x?: number; y?: number; width?: number; height?: number } | undefined
  const nx = node?.x
  const ny = node?.y
  const nw = node?.width
  const nh = node?.height
  if (![nx, ny, nw, nh].every((v) => Number.isFinite(v)) || (nw as number) <= 0 || (nh as number) <= 0) return null

  const wholeNode = (): { w: number; h: number; clip: null } | null => {
    const size = bakeResolution(sceneId, zoom)
    if (!size) return null
    const dprW = window.devicePixelRatio || 1
    bakeDebug.set(sceneId, {
      path: 'whole-node',
      node: { x: nx, y: ny, w: nw, h: nh },
      zoom,
      dpr: dprW,
      onScreenNodePx: [Math.round((nw as number) * zoom * dprW), Math.round((nh as number) * zoom * dprW)],
      fbo: [size.w, size.h],
    })
    return { w: size.w, h: size.h, clip: null }
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
  bakeDebug.set(sceneId, {
    node: { x, y, w: w0, h: h0 },
    zoom,
    dpr,
    visible,
    slice: { l: sl, t: st, r: sr, b: sb, w: sw, h: sh },
    onScreenSlicePx: [Math.round(sw * zoom * dpr), Math.round(sh * zoom * dpr)],
    fbo: [pw, ph],
    clip,
  })
  return { w: pw, h: ph, clip }
}

/**
 * Bake a PLACED scene: reconcile the instance from the document and composite it into the
 * node's fill. Call once per frame per placed scene; then request a Skia render. `visible`
 * (canvas viewport in doc coords) drives viewport clipping when enabled.
 */
export function bakeSceneToNode(sceneId: string, doc: Scene3DDocument, zoom: number, visible?: VisibleWorld): boolean {
  const p = bakePrep()
  if (!p) return false
  const plan = computeBakePlan(sceneId, zoom, visible)
  if (!plan) return false
  try {
    const st = ensureBakeState(p.r, sceneId, doc, plan.w, plan.h)

    // Skip the (potentially expensive, high-res) re-render when nothing that affects the
    // IMAGE changed. The key includes the clip slice, so a whole-node bake stays cached
    // during pan/move (only position moves — Skia re-composites the fill), while a clipped
    // bake re-renders as the visible slice changes. Re-assert the fill (a node mod-obj may
    // have cleared it) with the SAME dest, and return without touching three.
    const key = `${plan.w}x${plan.h}|${plan.clip ? plan.clip.dest.join(',') : 'full'}|${JSON.stringify(doc)}`
    if (st.contentKey === key && st.texId >= 0) {
      setNodeImageFill(p.m, sceneId, st.imageId, st.w, st.h, st.lastDest ?? null)
      st.filled = true
      return true
    }

    // Clean cache BEFORE any three work — Skia rendered last and left the shared context in
    // its own state (three, esp. PMREM, must re-bind or it draws with Skia's buffers).
    p.r.resetState()
    applyDocToInstance(st.inst, doc)
    const ok = renderAndUpload(p.m, p.r, sceneId, st, plan.w, plan.h, plan.clip)
    if (ok) st.contentKey = key
    return ok
  } catch (e) {
    p.r.resetState()
    warnBakeFail(sceneId, e)
    return false
  }
}

/**
 * Bake the scene BEING EDITED, mirroring the live overlay instance — so the 3D stays
 * composited in Skia (true z-order) while you orbit/drag, instead of jumping onto the
 * floating overlay. Orbit isn't written to the doc until gesture-end, so we copy the
 * camera pose + object transforms straight from `srcInst` (the overlay's live instance)
 * rather than the lagging document. The overlay then draws only the edit chrome on top.
 */
export function bakeEditingScene(sceneId: string, doc: Scene3DDocument, srcInst: Scene3DInstance, zoom: number): boolean {
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
    return renderAndUpload(p.m, p.r, sceneId, st, size.w, size.h, null)
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

// Live toggles for verification against a working render target (e.g. localhost:5175).
;(window as unknown as Record<string, unknown>).__scene3dBake = setBakeEnabled
;(window as unknown as Record<string, unknown>).__scene3dLiveEdit = setLiveEditEnabled
;(window as unknown as Record<string, unknown>).__scene3dViewportClip = setViewportClipEnabled
;(window as unknown as Record<string, unknown>).__bakeDebug = () => Object.fromEntries(bakeDebug)