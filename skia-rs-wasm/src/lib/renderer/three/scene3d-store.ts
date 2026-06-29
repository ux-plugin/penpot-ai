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
}

interface Scene3DState {
  scenes: Map<string, Scene3DDocument>
  /** The scene currently in 3D-edit mode (null = none). Editor state, not document state. */
  editingSceneId: string | null
  /** The object focused within the editing scene (the gizmo target). */
  focusedObjectId: string | null
}

export const scene3dProxy = proxy<Scene3DState>({
  scenes: proxyMap<string, Scene3DDocument>(),
  editingSceneId: null,
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

/** A default scene with one starter object. */
export function defaultSceneDocument(
  sceneId: string,
  firstObjectId: string,
  source: Source3D = { kind: 'primitive', ref: 'cube' },
): Scene3DDocument {
  return {
    sceneId,
    camera: { fov: 45 },
    env: { preset: 'studio', intensity: 1 },
    objects: [defaultObject(firstObjectId, source)],
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
  if (scene3dProxy.editingSceneId === id) {
    scene3dProxy.editingSceneId = null
    scene3dProxy.focusedObjectId = null
  }
}

export function isScene3D(id: string): boolean {
  return scene3dProxy.scenes.has(id)
}

/** Enter/exit 3D-edit mode for a scene. Entering defaults focus to the first object. */
export function setEditingScene(id: string | null): void {
  scene3dProxy.editingSceneId = id
  if (id === null) {
    scene3dProxy.focusedObjectId = null
    return
  }
  const scene = scene3dProxy.scenes.get(id)
  if (scene && !scene3dProxy.focusedObjectId) {
    scene3dProxy.focusedObjectId = scene.objects[0]?.id ?? null
  }
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

/** Live (uncommitted) material preview while the colour picker drags; committed on blur. */
export function patchObjectMaterialLocal(
  sceneId: string,
  objId: string,
  patch: Partial<Object3DEntry['material']>,
): void {
  const obj = scene3dProxy.scenes.get(sceneId)?.objects.find((o) => o.id === objId)
  if (obj) Object.assign(obj.material, patch)
}
