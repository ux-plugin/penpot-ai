/**
 * scene3d-store — the model for embedded 3D objects.
 *
 * Two layers, deliberately separated (see plan):
 *  - `scene3dProxy` (valtio): SERIALIZABLE model only. Reactive, saveable,
 *    bindable. The right panel reads it via `useSnapshot`; the overlay
 *    subscribes for on-demand redraw.
 *  - `instances` (plain Map): the live three.js objects. three objects are
 *    NEVER put in the valtio proxy — deep-proxying breaks three's identity /
 *    `instanceof` / internal WeakMaps, chokes on the cyclic scene graph, and
 *    would proxy-trap every per-frame matrix write. They're keyed by the same
 *    `shapeId` and are disposable GPU-backed runtime state.
 *
 * Each 3D object is backed by a real (invisible) `rect` shape in the document,
 * whose id is `shapeId` here — that rect is the source of truth for world
 * bounds / selection / move-resize / undo.
 */

import { proxy } from 'valtio'
import { proxyMap } from 'valtio/utils'
import type * as THREE from 'three'

export type Vec3 = [number, number, number]

export type Source3D =
  | { kind: 'primitive'; ref: 'cube' | 'sphere' | 'plane' }
  | { kind: 'gltf'; ref: string }
  | { kind: 'spline'; ref: string }

/** The serializable spec for one 3D object. Plain JSON only — no three objects. */
export interface Scene3DEntry {
  shapeId: string
  source: Source3D
  transform3d: { position: Vec3; rotationEuler: Vec3; scale: Vec3 }
  material: { color: string; metalness: number; roughness: number; opacity: number }
  camera: { fov: number }
  env: { preset: 'studio'; intensity: number }
  /** Phase 1: always 'front' (3D renders above all 2D). 'back' lands with the sandwich. */
  band: 'front'
  // --- interaction-ready surface: declared now, wired into the Interactions graph in Phase 2 ---
  bindable: string[]
  emits: string[]
}

interface Scene3DState {
  objects: Map<string, Scene3DEntry>
  /** The 3D object currently being manipulated (mirrors the document selection when it's a 3D object). */
  selectedId: string | null
  /** True while the gizmo/orbit are active (overlay captures the pointer). */
  editing: boolean
}

export const scene3dProxy = proxy<Scene3DState>({
  objects: proxyMap<string, Scene3DEntry>(),
  selectedId: null,
  editing: false,
})

/** Build a default entry for a freshly created object. */
export function defaultEntry(shapeId: string, source: Source3D): Scene3DEntry {
  return {
    shapeId,
    source,
    transform3d: { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    material: { color: '#8a8de0', metalness: 0.6, roughness: 0.35, opacity: 1 },
    camera: { fov: 45 },
    env: { preset: 'studio', intensity: 1 },
    band: 'front',
    bindable: [
      'transform3d.position',
      'transform3d.rotationEuler',
      'transform3d.scale',
      'material.color',
      'visible',
    ],
    emits: ['onClick', 'onPointerEnter', 'onPointerLeave'],
  }
}

/* ----------------------------------------------------------------------------
 * Non-reactive runtime instance registry (three.js objects live here, not in
 * the proxy). Keyed by the same shapeId.
 * ------------------------------------------------------------------------- */

export interface Scene3DInstance {
  root: THREE.Object3D
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
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
 * Model actions (mutate the serializable proxy).
 * ------------------------------------------------------------------------- */

export function add3DObject(entry: Scene3DEntry): void {
  scene3dProxy.objects.set(entry.shapeId, entry)
}

export function remove3DObject(id: string): void {
  scene3dProxy.objects.delete(id)
  deleteInstance(id)
  if (scene3dProxy.selectedId === id) {
    scene3dProxy.selectedId = null
    scene3dProxy.editing = false
  }
}

export function is3DObject(id: string): boolean {
  return scene3dProxy.objects.has(id)
}

export function setSelected3D(id: string | null): void {
  scene3dProxy.selectedId = id
  if (id === null) scene3dProxy.editing = false
}

export function setEditing(v: boolean): void {
  scene3dProxy.editing = v
}

export function setTransform3d(id: string, patch: Partial<Scene3DEntry['transform3d']>): void {
  const e = scene3dProxy.objects.get(id)
  if (e) Object.assign(e.transform3d, patch)
}

export function setMaterial(id: string, patch: Partial<Scene3DEntry['material']>): void {
  const e = scene3dProxy.objects.get(id)
  if (e) Object.assign(e.material, patch)
}

export function setCamera(id: string, patch: Partial<Scene3DEntry['camera']>): void {
  const e = scene3dProxy.objects.get(id)
  if (e) Object.assign(e.camera, patch)
}

export function setEnv(id: string, patch: Partial<Scene3DEntry['env']>): void {
  const e = scene3dProxy.objects.get(id)
  if (e) Object.assign(e.env, patch)
}
