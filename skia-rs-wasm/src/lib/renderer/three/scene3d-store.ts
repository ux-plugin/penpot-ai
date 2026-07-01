/**
 * scene3d-store — the model for embedded 3D *scenes*.
 *
 * A 3D Scene is an embedded viewport on the 2D canvas: one container node (the
 * placeholder rect) owns ONE three.js scene with a shared camera + environment,
 * and a list of 3D objects that live in that world. Objects are NOT 2D document
 * nodes — they exist only inside the scene, projected through its camera.
 *
 * Two layers, deliberately separated:
 *  - `scene3dProxy` (valtio): the SERIALIZABLE model only — `Scene3DDocument`s
 *    keyed by their container-node id, plus the editor's transient edit/focus
 *    state. Reactive, saveable, bindable. Stored on the scene node as
 *    `node.scene3d` (durable, undoable; see persistence).
 *  - `instances` (plain Map): the live three.js objects (one Scene3DInstance per
 *    scene). three objects are NEVER put in the valtio proxy — deep-proxying
 *    breaks three's identity / `instanceof` / internal WeakMaps and would
 *    proxy-trap every per-frame matrix write. Keyed by the same scene id.
 */

import { proxy } from 'valtio'
import { proxyMap } from 'valtio/utils'
import { signal } from '@preact/signals-core'
import type * as THREE from 'three'

export type Vec3 = [number, number, number]

export type Source3D =
  | { kind: 'primitive'; ref: 'cube' | 'sphere' | 'plane' }
  | { kind: 'gltf'; ref: string }
  | { kind: 'spline'; ref: string }

/** One 3D object inside a scene. Plain JSON only — no three objects. */
export interface Object3DEntry {
  id: string
  name: string
  source: Source3D
  transform3d: { position: Vec3; rotationEuler: Vec3; scale: Vec3 }
  material: { color: string; metalness: number; roughness: number; opacity: number }
  // --- interaction-ready surface: declared per-object, wired into the graph in Phase 2 ---
  bindable: string[]
  emits: string[]
}

/** A whole 3D scene: shared camera + environment + an ordered list of objects. */
export interface Scene3DDocument {
  /** The container (placeholder rect) node id — the scene's id in the document. */
  sceneId: string
  camera: { fov: number }
  env: { preset: 'studio'; intensity: number }
  objects: Object3DEntry[]
  /** Backdrop shown ONLY while editing this scene (`null` ⇒ the default studio
   *  backdrop). Outside edit mode the scene composites transparently over the
   *  document, so this never affects the final/preview render. */
  background?: string | null
}

/**
 * The scene's *design viewport* — the fixed world-size the camera renders at.
 * The container box is a window onto the 3D world: the camera always renders this
 * much world per on-screen unit (so content never rescales when the box resizes),
 * and the box just crops or extends that view (via `setViewOffset`). It equals the
 * creation size so a freshly-dropped scene exactly fills its frame. Shared with
 * `create-3d-scene` so the two can't drift.
 */
export const SCENE3D_BASE_VIEW = { w: 360, h: 260 } as const

/**
 * Default editor backdrop for a scene's peephole — a neutral dark "studio" fill
 * shown ONLY in edit mode, so the scene region reads apart from the document
 * canvas (which otherwise shows through the transparent container). Overridable
 * per-scene via `Scene3DDocument.background`.
 */
export const SCENE3D_EDIT_BACKDROP = '#262a35'

interface Scene3DState {
  scenes: Map<string, Scene3DDocument>
  /** The object focused within the editing scene (the gizmo target). The edit mode
   *  itself + which scene is being edited live in the canvasMachine (`scene3dEditing`). */
  focusedObjectId: string | null
}

export const scene3dProxy = proxy<Scene3DState>({
  scenes: proxyMap<string, Scene3DDocument>(),
  focusedObjectId: null,
})

const OBJECT_BINDABLE = [
  'transform3d.position',
  'transform3d.rotationEuler',
  'transform3d.scale',
  'material.color',
  'visible',
]
const OBJECT_EMITS = ['onClick', 'onPointerEnter', 'onPointerLeave']

function labelFor(source: Source3D): string {
  if (source.kind === 'primitive') return source.ref[0].toUpperCase() + source.ref.slice(1)
  if (source.kind === 'gltf') return 'Model'
  return 'Spline'
}

/** A default object spec (default material/transform). */
export function defaultObject(id: string, source: Source3D, name?: string): Object3DEntry {
  return {
    id,
    name: name ?? labelFor(source),
    source,
    transform3d: { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    material: { color: '#8a8de0', metalness: 0.6, roughness: 0.35, opacity: 1 },
    bindable: [...OBJECT_BINDABLE],
    emits: [...OBJECT_EMITS],
  }
}

/** A default empty scene. Objects are added from the contextual menu in 3D-edit mode. */
export function defaultSceneDocument(sceneId: string): Scene3DDocument {
  return {
    sceneId,
    camera: { fov: 45 },
    env: { preset: 'studio', intensity: 1 },
    objects: [],
    background: null,
  }
}

export function findObject(scene: Scene3DDocument, objId: string): Object3DEntry | undefined {
  return scene.objects.find((o) => o.id === objId)
}

/* ----------------------------------------------------------------------------
 * Non-reactive runtime instance registry (three.js objects live here, not in
 * the proxy). One Scene3DInstance per scene, keyed by the scene id.
 * ------------------------------------------------------------------------- */

export interface Scene3DInstance {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  /** objectId → its root group in the scene. */
  objects: Map<string, THREE.Object3D>
  /** Free GPU resources (geometries, materials, env map). */
  dispose: () => void
}

const instances = new Map<string, Scene3DInstance>()

export function getInstance(id: string): Scene3DInstance | undefined {
  return instances.get(id)
}

export function setInstance(id: string, inst: Scene3DInstance): void {
  instances.get(id)?.dispose()
  instances.set(id, inst)
}

export function deleteInstance(id: string): void {
  instances.get(id)?.dispose()
  instances.delete(id)
}

/* ----------------------------------------------------------------------------
 * Scene anchor — where the scene's *design frustum* is pinned on the canvas.
 *
 * The container box is a PEEPHOLE onto a fixed scene: the camera always renders
 * the same world at the same scale (SCENE3D_BASE_VIEW), and the box's rect is just
 * the crop window (setViewOffset). The anchor is the world point the design
 * frustum's top-left maps to. It is FROZEN while the box resizes — so the scene
 * stays put and a bigger box reveals more world from any edge — and TRANSLATED when
 * the whole box moves, so the scene travels with it. Runtime-only editor state
 * (lazily seeded from the box's top-left); on reload a scene that had been resized
 * from an edge re-pins to its top-left. Plain (non-reactive) maps: the overlay
 * redraws on the existing move/commit/viewport triggers, so no proxy churn here.
 * ------------------------------------------------------------------------- */

const sceneAnchors = new Map<string, { x: number; y: number }>()
const lastSceneRect = new Map<string, { x: number; y: number; w: number; h: number }>()

/** The anchor for a scene, seeded to the box's top-left (`seedX/seedY`) on first sight. */
export function ensureSceneAnchor(id: string, seedX: number, seedY: number): { x: number; y: number } {
  let a = sceneAnchors.get(id)
  if (!a) {
    a = { x: seedX, y: seedY }
    sceneAnchors.set(id, a)
  }
  return a
}

/**
 * Update a scene's anchor from a committed box rect. A size-preserving position
 * change is a MOVE → translate the anchor so the scene travels with the box; any
 * size change is a RESIZE → leave the anchor frozen so the scene stays put. Runs on
 * every commit (incl. undo/redo, whose inverse move translates the anchor back).
 */
export function reconcileSceneAnchorOnRect(
  id: string,
  rect: { x: number; y: number; w: number; h: number },
): void {
  const last = lastSceneRect.get(id)
  lastSceneRect.set(id, rect)
  if (!last) return
  const moved = rect.x !== last.x || rect.y !== last.y
  const resized = Math.abs(rect.w - last.w) > 0.5 || Math.abs(rect.h - last.h) > 0.5
  if (moved && !resized) {
    const a = sceneAnchors.get(id)
    if (a) {
      a.x += rect.x - last.x
      a.y += rect.y - last.y
    }
  }
}

function clearSceneAnchor(id: string): void {
  sceneAnchors.delete(id)
  lastSceneRect.delete(id)
}

/** Drop all anchors (document load / page switch — they re-seed on next draw). */
export function clearAllSceneAnchors(): void {
  sceneAnchors.clear()
  lastSceneRect.clear()
}

/**
 * Recenter the peephole crop so the box is symmetric on the design frustum: the box
 * center then maps to the frustum center (where the camera looks). Used by Frame-view
 * so that aiming the camera at an object also lands it in the middle of what's
 * *visible*, not just the middle of the (possibly off-screen) design frustum.
 */
export function centerSceneAnchorOnBox(id: string, boxCenterX: number, boxCenterY: number): void {
  const ax = boxCenterX - SCENE3D_BASE_VIEW.w / 2
  const ay = boxCenterY - SCENE3D_BASE_VIEW.h / 2
  const a = ensureSceneAnchor(id, ax, ay)
  a.x = ax
  a.y = ay
}

/**
 * Min/max dolly distance for a scene's camera, derived from its *home* (design)
 * distance so scroll-zoom can't fly through the content or escape to nothing. The
 * bounds are proportional, so they auto-scale to whatever distance the scene was
 * framed at; base them on the stable home distance (captured once) — not the live
 * one — or repeated zoom-in/exit/re-enter would ratchet the camera ever closer.
 */
export function dollyBounds(homeDistance: number): { min: number; max: number } {
  const d = homeDistance > 0 ? homeDistance : 1
  return { min: d * 0.2, max: d * 5 }
}

/**
 * Camera distance at which a bounding sphere of `radius` just fits a vertical
 * `fovDeg` field of view, with a little padding. Used by Frame-view to dolly so the
 * focused object fills the peephole without clipping.
 */
export function frameDistanceForRadius(radius: number, fovDeg: number, padding = 1.25): number {
  const half = ((Math.max(1, fovDeg) * Math.PI) / 180) / 2
  return (Math.max(radius, 1e-4) / Math.sin(half)) * padding
}

/**
 * Frame-view request — a runtime nudge (NOT machine state, like dolly/pan) that the
 * overlay watches to recenter + refit the camera on the focused object (or reset to
 * the home pose). Bumped by the SCENE3D_FRAME_VIEW command; edge-triggered, so only
 * the change matters, not the value.
 */
export const sceneFrameViewRequest = signal(0)
export function requestSceneFrameView(): void {
  sceneFrameViewRequest.value += 1
}

/* ----------------------------------------------------------------------------
 * Model actions (mutate the serializable proxy). Persisted edits go through the
 * document (scene3d-commit); these are for registration + transient edit state +
 * uncommitted live previews (gizmo / colour drag).
 * ------------------------------------------------------------------------- */

export function addScene(doc: Scene3DDocument): void {
  scene3dProxy.scenes.set(doc.sceneId, doc)
}

export function removeScene(id: string): void {
  scene3dProxy.scenes.delete(id)
  deleteInstance(id)
  clearSceneAnchor(id)
  // Exiting 3D-edit mode if this was the edited scene is reconciled by the overlay
  // (it owns the canvasMachine actor); here we just drop the model + GPU instance.
}

export function isScene3D(id: string): boolean {
  return scene3dProxy.scenes.has(id)
}

export function setFocusedObject(id: string | null): void {
  scene3dProxy.focusedObjectId = id
}

/** Live (uncommitted) transform preview while a gizmo drags; committed on drag end. */
export function patchObjectTransformLocal(
  sceneId: string,
  objId: string,
  patch: Partial<Object3DEntry['transform3d']>,
): void {
  const obj = scene3dProxy.scenes.get(sceneId)?.objects.find((o) => o.id === objId)
  if (obj) Object.assign(obj.transform3d, patch)
}

/** Live (uncommitted) edit-backdrop preview while the colour picker drags; committed on blur. */
export function patchSceneBackgroundLocal(sceneId: string, background: string | null): void {
  const scene = scene3dProxy.scenes.get(sceneId)
  if (scene) scene.background = background
}

/** Live (uncommitted) material preview while the colour picker drags; committed on blur. */
export function patchObjectMaterialLocal(
  sceneId: string,
  objId: string,
  patch: Partial<Object3DEntry['material']>,
): void {
  const obj = scene3dProxy.scenes.get(sceneId)?.objects.find((o) => o.id === objId)
  if (obj) Object.assign(obj.material, patch)
}
