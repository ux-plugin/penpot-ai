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
import type { Object3DEntry, Scene3DDocument } from './scene3d-store'

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

export async function commitSceneEnv(
  sceneId: string,
  patch: Partial<Scene3DDocument['env']>,
): Promise<void> {
  const doc = currentScene(sceneId)
  if (!doc) return
  Object.assign(doc.env, patch)
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
