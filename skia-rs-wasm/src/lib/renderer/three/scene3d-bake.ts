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
 * FLAG-GATED OFF. Toggle live for verification:  window.__scene3dBake(true|false)
 */

import * as THREE from 'three'
import type { WasmModule } from '../wasm-types'
import { useWorkspaceStore } from '../store/workspace-store'
import { getNode } from '../store/doc-proxy'
import { allocBytes, freeBytes, writeUUIDToDataView } from '../utils'
import { uuidToU32Tuple } from '../types'
import { buildSceneInstance, applyDocToInstance } from './three-scene'
import { isPersp, orthoFrustum } from './camera3d'
import type { Scene3DDocument, Scene3DInstance } from './scene3d-store'

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

interface BakeState {
  inst: Scene3DInstance
  rt: THREE.WebGLRenderTarget
  texId: number // emscripten GL id for rt's texture (re-registered only on RT resize)
  imageId: string // stable Skia image id, so _update_image_from_texture overwrites in place
  w: number
  h: number
  filled: boolean // whether the node currently carries our baked image fill
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

function getBakeRenderer(m: WasmModule): THREE.WebGLRenderer | null {
  if (bakeRenderer) return bakeRenderer
  const gl = sharedGL(m)
  if (!gl) return null
  bakeRenderer = new THREE.WebGLRenderer({ context: gl, alpha: true, antialias: true })
  bakeRenderer.setClearColor(0x000000, 0)
  bakeRenderer.autoClear = false
  return bakeRenderer
}

const MAX_BAKE_PX = 4096 // FBO cap: safe on effectively all GL implementations
const warnedSize = new Set<string>()

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
  const want = Math.max(0.25, (zoom > 0 ? zoom : 1) * dpr)
  // Next power of 2 ≥ want → slightly over-sample so it reads sharp, and only step on
  // 2× boundaries so zoom gestures don't thrash the texture allocation.
  let mult = Math.pow(2, Math.ceil(Math.log2(want)))
  mult = Math.min(mult, MAX_BAKE_PX / Math.max(w0 as number, h0 as number)) // cap
  const pw = Math.max(16, Math.round((w0 as number) * mult))
  const ph = Math.max(16, Math.round((h0 as number) * mult))
  return { w: pw, h: ph }
}

/**
 * Render `sceneId` into its FBO in the shared context and hand Skia the texture as the
 * node's image fill. Returns true if the node now carries a fresh baked fill. Call once
 * per frame per placed scene; then request a Skia render.
 */
export function bakeSceneToNode(sceneId: string, doc: Scene3DDocument, zoom: number): boolean {
  const m = module()
  if (!m || typeof (m as { _update_image_from_texture?: unknown })._update_image_from_texture !== 'function') return false
  const r = getBakeRenderer(m)
  if (!r) return false
  const size = bakeResolution(sceneId, zoom)
  if (!size) return false

  // Hand the shared GL context to three with a CLEAN cache BEFORE any three work — Skia
  // rendered last and left the context in its own state, so three (esp. buildSceneInstance's
  // PMREM passes) must re-bind everything or it draws using Skia's buffers (the "vertex
  // buffer not big enough" / "bufferSubData overflow" spam).
  r.resetState()
  try {
    let st = bakeState.get(sceneId)
    if (!st) {
      const inst = buildSceneInstance(r, doc)
      const rt = new THREE.WebGLRenderTarget(size.w, size.h)
      st = { inst, rt, texId: -1, imageId: crypto.randomUUID(), w: size.w, h: size.h, filled: false }
      bakeState.set(sceneId, st)
    } else if (st.w !== size.w || st.h !== size.h) {
      st.rt.setSize(size.w, size.h)
      st.texId = -1 // texture reallocated on resize → must re-register
      st.w = size.w
      st.h = size.h
    }

    // Reconcile the live scene/camera/objects from the document.
    applyDocToInstance(st.inst, doc)

    // Frame the camera to the node's aspect (mirrors renderSceneIntoBox).
    const aspect = size.w / size.h
    const cam = st.inst.camera
    if (isPersp(cam)) {
      cam.aspect = aspect
      cam.clearViewOffset()
      cam.updateProjectionMatrix()
    } else {
      const halfH = (cam.userData.orthoHalfHeight as number | undefined) ?? 1
      const f = orthoFrustum(halfH, aspect)
      cam.left = f.left
      cam.right = f.right
      cam.top = f.top
      cam.bottom = f.bottom
      cam.updateProjectionMatrix()
    }

    // Render the scene into the FBO (transparent, so the 3D composites over whatever is
    // behind the node in Skia).
    st.inst.scene.background = null
    r.setRenderTarget(st.rt)
    r.setViewport(0, 0, size.w, size.h)
    r.setScissorTest(false)
    r.setClearColor(0x000000, 0)
    r.clear(true, true, false)
    r.render(st.inst.scene, cam)
    r.setRenderTarget(null)

    // Register the RT's GL texture in emscripten's table (reuse the id across frames).
    const webglTex = (r.properties.get(st.rt.texture) as { __webglTexture?: WebGLTexture }).__webglTexture
    if (!webglTex) {
      r.resetState()
      return false
    }
    const GL = (m as unknown as { GL: { getNewId: (t: unknown[]) => number; textures: unknown[] } }).GL
    if (st.texId < 0) st.texId = GL.getNewId(GL.textures)
    GL.textures[st.texId] = webglTex

    // Hand back to Skia with a clean three cache, THEN touch WASM.
    r.resetState()
    writeTextureHeader(m, sceneId, st.imageId, st.texId, size.w, size.h)
    m._update_image_from_texture()
    freeBytes(m)
    setNodeImageFill(m, sceneId, st.imageId, size.w, size.h)
    st.filled = true
    return true
  } catch (e) {
    r.resetState()
    if (!warnedSize.has(sceneId + ':err')) {
      warnedSize.add(sceneId + ':err')
      console.warn('[scene3d-bake] bake failed for', sceneId, e)
    }
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
 * Drop bake state for scenes that no longer exist (deleted). Called with the live scene
 * id set each frame. The node is gone, so we only free GPU resources — no fill to clear.
 */
export function reconcileBakes(activeIds: Set<string>): void {
  for (const id of [...bakeState.keys()]) {
    if (activeIds.has(id)) continue
    const st = bakeState.get(id)!
    st.inst.dispose()
    st.rt.dispose()
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

function setNodeImageFill(m: WasmModule, nodeId: string, imageId: string, w: number, h: number): void {
  const [a, b, c, d] = uuidToU32Tuple(nodeId)
  ;(m as unknown as { _use_shape: (a: number, b: number, c: number, d: number) => void })._use_shape(a, b, c, d)
  const off = allocBytes(m, 4 + FILL_U8_SIZE)
  const dv = new DataView(m.HEAPU8.buffer, m.HEAPU8.byteOffset)
  dv.setUint32(off, 1, true) // one fill
  const f = off + 4
  dv.setUint8(f, 0x03) // image fill
  writeUUIDToDataView(dv, f + 4, imageId)
  dv.setUint8(f + 20, 0xff) // alpha
  dv.setUint8(f + 21, 0x00) // flags
  dv.setUint32(f + 24, w, true)
  dv.setUint32(f + 28, h, true)
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

// Live toggle for verification against a working render target (e.g. localhost:5175).
;(window as unknown as Record<string, unknown>).__scene3dBake = setBakeEnabled
