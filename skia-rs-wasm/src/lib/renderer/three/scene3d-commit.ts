/**
 * scene3d-commit — write 3D-scene state into the document (undoable).
 *
 * The serializable `Scene3DDocument` lives on the scene container node as
 * `node.scene3d`. Every edit — scene-level (camera/env) or object-level
 * (transform/material/add/remove) — replaces that blob through the same `mod-obj`
 * pipeline the 2D inspector uses (`commitNodePartialUpdate`), so each edit is one
 * undo frame with a paired inverse. `scene3d` is opaque to WASM. `scene3dProxy`
 * is reconciled from the document by scene3d-sync; callers here don't touch it.
 */

import type { PenpotNode } from 'penpot-exporter/types'
import {
  commitNodePartialUpdate,
  getCommittedNodeOnActivePage,
} from '../properties/commit-node-properties'
import { getActiveOrSinglePageId } from '../store/doc-proxy'
import { sceneCameras } from './scene3d-store'
import type { Camera3DEntry, Object3DEntry, Scene3DDocument } from './scene3d-store'

/** The committed scene document on the node (plain clone, detached from the proxy). */
function currentScene(sceneId: string): Scene3DDocument | null {
  const node = getCommittedNodeOnActivePage(sceneId) as { scene3d?: Scene3DDocument } | null
  const doc = node?.scene3d
  return doc ? (structuredClone(doc) as Scene3DDocument) : null
}

/** Commit a full Scene3DDocument onto the node as one undoable `mod-obj`. */
export async function commitScene3d(sceneId: string, next: Scene3DDocument): Promise<void> {
  const before = getCommittedNodeOnActivePage(sceneId)
  const pid = getActiveOrSinglePageId()
  if (!before || !pid) return
  await commitNodePartialUpdate(sceneId, before, { scene3d: next } as Partial<PenpotNode>, pid)
}

export async function commitSceneCamera(
  sceneId: string,
  patch: Partial<Scene3DDocument['camera']>,
): Promise<void> {
  const doc = currentScene(sceneId)
  if (!doc) return
  Object.assign(doc.camera, patch)
  await commitScene3d(sceneId, doc)
}

/**
 * Patch the scene's ACTIVE camera entry (e.g. `projection`, `fov`). Materialises the
 * `cameras[]` array for legacy scenes (synthesised from the old single `camera.fov`)
 * and mirrors FOV back onto the legacy `camera` field so both representations stay
 * consistent. One undoable `mod-obj`.
 */
export async function commitActiveCameraPatch(
  sceneId: string,
  patch: Partial<Camera3DEntry>,
): Promise<void> {
  const doc = currentScene(sceneId)
  if (!doc) return
  const cams = doc.cameras && doc.cameras.length > 0 ? doc.cameras : sceneCameras(doc)
  const activeId = doc.activeCameraId ?? cams[0].id
  const idx = Math.max(
    0,
    cams.findIndex((c) => c.id === activeId),
  )
  cams[idx] = { ...cams[idx], ...patch }
  doc.cameras = cams
  doc.activeCameraId = cams[idx].id
  if (typeof patch.fov === 'number') doc.camera.fov = patch.fov // legacy mirror
  await commitScene3d(sceneId, doc)
}

export async function commitSceneEnv(
  sceneId: string,
  patch: Partial<Scene3DDocument['env']>,
): Promise<void> {
  const doc = currentScene(sceneId)
  if (!doc) return
  Object.assign(doc.env, patch)
  await commitScene3d(sceneId, doc)
}

/** Set the edit-mode backdrop colour (`null` = default studio backdrop). */
export async function commitSceneBackground(
  sceneId: string,
  background: string | null,
): Promise<void> {
  const doc = currentScene(sceneId)
  if (!doc) return
  doc.background = background
  await commitScene3d(sceneId, doc)
}

export async function commitObjectTransform(
  sceneId: string,
  objId: string,
  transform: Object3DEntry['transform3d'],
): Promise<void> {
  const doc = currentScene(sceneId)
  const obj = doc?.objects.find((o) => o.id === objId)
  if (!doc || !obj) return
  obj.transform3d = transform
  await commitScene3d(sceneId, doc)
}

export async function commitObjectMaterial(
  sceneId: string,
  objId: string,
  patch: Partial<Object3DEntry['material']>,
): Promise<void> {
  const doc = currentScene(sceneId)
  const obj = doc?.objects.find((o) => o.id === objId)
  if (!doc || !obj) return
  Object.assign(obj.material, patch)
  await commitScene3d(sceneId, doc)
}

export async function commitAddObject(sceneId: string, entry: Object3DEntry): Promise<void> {
  const doc = currentScene(sceneId)
  if (!doc) return
  doc.objects.push(entry)
  await commitScene3d(sceneId, doc)
}

export async function commitRemoveObject(sceneId: string, objId: string): Promise<void> {
  const doc = currentScene(sceneId)
  if (!doc) return
  doc.objects = doc.objects.filter((o) => o.id !== objId)
  await commitScene3d(sceneId, doc)
}
