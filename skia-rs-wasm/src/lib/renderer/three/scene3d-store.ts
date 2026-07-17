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

export type CameraProjection = 'perspective' | 'orthographic'

/** A camera placed in a scene — perspective or orthographic, positioned like an
 *  object (aim = rotationEuler, place = position; no material/scale). The scene
 *  renders through its ACTIVE camera. */
export interface Camera3DEntry {
  id: string
  name: string
  projection: CameraProjection
  /** Vertical field of view in degrees (used when `projection === 'perspective'`). */
  fov: number
  /** World half-height of the orthographic frustum (used when `projection ===
   *  'orthographic'`). Stored SEPARATELY from `fov` so toggling persp⇄ortho is lossless
   *  — each projection keeps its own framing. Absent ⇒ derived from `fov` at the home
   *  distance the first time the camera goes orthographic. */
  orthoSize?: number
  /** Persisted view pose (position + aim as XYZ Euler degrees). ABSENT ⇒ the camera
   *  uses the canonical default 3/4 framing (`buildCamera`); it is written when the
   *  user navigates (orbit/pan/dolly) in edit mode, so a reload restores the last
   *  view. Ortho "dolly" is a zoom, not a position, so ortho zoom is not captured
   *  here — only the angle + pan persist for an ortho camera. */
  transform3d?: { position: Vec3; rotationEuler: Vec3 }
}

/** A whole 3D scene: shared camera + environment + an ordered list of objects. */
export interface Scene3DDocument {
  /** The container (placeholder rect) node id — the scene's id in the document. */
  sceneId: string
  camera: { fov: number }
  env: { preset: 'studio'; intensity: number }
  objects: Object3DEntry[]
  /** Cameras placed in the scene; the scene renders through `activeCameraId`. Optional
   *  for back-compat — legacy scenes (only `camera.fov`) synthesise a default via
   *  `sceneCameras`/`activeCamera`. */
  cameras?: Camera3DEntry[]
  activeCameraId?: string
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
  /** The camera SELECTED for editing in the editing scene (its props show in the
   *  popover). Distinct from the scene's `activeCameraId` (the look-through camera the
   *  scene renders through, persisted on the doc): you can select a camera to tweak it
   *  without switching the view. Transient editor state; `null` ⇒ edit the active one. */
  selectedCameraId: string | null
}

export const scene3dProxy = proxy<Scene3DState>({
  scenes: proxyMap<string, Scene3DDocument>(),
  focusedObjectId: null,
  selectedCameraId: null,
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

/** The scene's default camera — a perspective camera matching the initial view.
 *  No `transform3d`: an unset pose means `buildCamera` uses the canonical 3/4
 *  framing. Navigating in edit mode writes the pose, and reload restores it. */
export function defaultCamera(sceneId: string): Camera3DEntry {
  return {
    id: `${sceneId}:cam0`,
    name: 'Camera 1',
    projection: 'perspective',
    fov: 45,
  }
}

/** A unique "Camera N" name for a new camera in a scene (N = one past the highest
 *  existing "Camera N", so names don't collide even after deletes). */
export function nextCameraName(scene: Scene3DDocument): string {
  const nums = sceneCameras(scene).map((c) => {
    const m = /^Camera (\d+)$/.exec(c.name)
    return m ? Number(m[1]) : 0
  })
  return `Camera ${Math.max(0, ...nums) + 1}`
}

/** The scene's cameras, synthesising a default for legacy scenes that predate the
 *  `cameras[]` field (only `camera.fov`). Never empty. */
export function sceneCameras(scene: Scene3DDocument): Camera3DEntry[] {
  if (scene.cameras && scene.cameras.length > 0) return scene.cameras
  const cam = defaultCamera(scene.sceneId)
  return [{ ...cam, fov: scene.camera?.fov ?? cam.fov }]
}

/** The active camera the scene renders through (falls back to the first). */
export function activeCamera(scene: Scene3DDocument): Camera3DEntry {
  const cams = sceneCameras(scene)
  return cams.find((c) => c.id === scene.activeCameraId) ?? cams[0]
}

/** A default empty scene. Objects are added from the contextual menu in 3D-edit mode. */
export function defaultSceneDocument(sceneId: string): Scene3DDocument {
  const cam = defaultCamera(sceneId)
  return {
    sceneId,
    camera: { fov: cam.fov },
    env: { preset: 'studio', intensity: 1 },
    objects: [],
    cameras: [cam],
    activeCameraId: cam.id,
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

/**
 * The on-canvas stand-in for a camera you are NOT looking through: a wireframe frustum
 * plus a small body, so you can see where your other cameras are and (later) grab them.
 * Editor chrome — only ever added while the scene is being edited, never in preview.
 */
export interface Scene3DCameraHelper {
  /** Identity-transformed holder for the frustum + body, added to / removed from the scene. */
  group: THREE.Group
  /** A stand-in camera carrying the entry's pose + lens, with a SHORT far plane so the
   *  drawn frustum is a compact cone rather than one spanning the whole scene. */
  cam: THREE.PerspectiveCamera | THREE.OrthographicCamera
  helper: THREE.CameraHelper
  /** The lens/selection the helper geometry was built from — rebuilt when it changes
   *  (the pose is cheap to re-apply every sync, so it isn't part of this). */
  lensKey: string
}

export interface Scene3DInstance {
  scene: THREE.Scene
  /** The scene's active camera — perspective (FOV) or orthographic (parallel). */
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera
  /** The camera-entry id `camera` was built from. Switching the look-through camera
   *  (`activeCameraId`) rebuilds the instance so the new camera's pose/projection take. */
  activeCamId: string
  /** objectId → its root group in the scene. */
  objects: Map<string, THREE.Object3D>
  /** cameraId → its frustum helper, for every camera EXCEPT the one being looked
   *  through. Populated only while the scene is edited (see scene3d-camera-helpers). */
  cameraHelpers: Map<string, Scene3DCameraHelper>
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
  // Exiting 3D-edit mode if this was the edited scene is reconciled by the overlay
  // (it owns the canvasMachine actor); here we just drop the model + GPU instance.
}

export function isScene3D(id: string): boolean {
  return scene3dProxy.scenes.has(id)
}

export function setFocusedObject(id: string | null): void {
  scene3dProxy.focusedObjectId = id
  // Focusing an object and selecting a camera are mutually exclusive within a scene,
  // so the tree row and the camera popover never show two different "selected" things.
  if (id !== null) scene3dProxy.selectedCameraId = null
}

/** Select a camera — its properties open in the right panel (`ThreeDCameraInspector`).
 *  Does NOT change the look-through camera — that's `activeCameraId` on the doc, set via
 *  commitSetActiveCamera. */
export function setSelectedCamera(id: string | null): void {
  scene3dProxy.selectedCameraId = id
  if (id !== null) scene3dProxy.focusedObjectId = null
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
