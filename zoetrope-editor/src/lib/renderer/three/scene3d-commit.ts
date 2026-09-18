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
import type {
  Camera3DEntry,
  CameraProjection,
  Object3DEntry,
  Scene3DDocument,
  Scene3DResizeMode,
} from './scene3d-store'
import { sceneWindow, windowFittedToBox, type BoxRect } from './scene3d-viewframe'
import { nodeBoxRect } from './scene3d-crop-resize'

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

/** The scene container's current box, for sizing a view frame. */
function sceneBox(sceneId: string): BoxRect | null {
  return nodeBoxRect(getCommittedNodeOnActivePage(sceneId))
}

/**
 * Switch how resizing the box treats the 3D. Deliberately writes NO view frame: leaving it
 * absent means the renderer materialises the identity crop from the very box it is drawing,
 * so flipping the switch is pixel-identical rather than nudging the content. Writing one
 * here re-derived it from a slightly different rect than the renderer's, and that mismatch
 * was visible as a small jump. The frame becomes concrete on the first resize, materialised
 * from the box as it stood before that gesture (see scene3d-crop-resize).
 */
export async function commitSceneResizeMode(
  sceneId: string,
  mode: Scene3DResizeMode,
): Promise<void> {
  const doc = currentScene(sceneId)
  if (!doc) return
  doc.resizeMode = mode
  await commitScene3d(sceneId, doc)
}

/**
 * Reshape the view to the box's proportions, so it fills the box with no empty bands. Only
 * ever reveals — the short axis widens to meet the box rather than the long one being
 * trimmed, so nothing currently on screen is lost.
 */
export async function commitFitViewToBox(sceneId: string): Promise<void> {
  const doc = currentScene(sceneId)
  const box = sceneBox(sceneId)
  if (!doc || !box) return
  doc.viewWindow = windowFittedToBox(sceneWindow(doc, box), box.w, box.h)
  await commitScene3d(sceneId, doc)
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
 * Patch a specific camera entry (e.g. `projection`, `fov`, `transform3d`). Materialises
 * the `cameras[]` array for legacy scenes (synthesised from the old single `camera.fov`).
 * FOV is mirrored onto the legacy `camera` field only when patching the ACTIVE camera,
 * so the render (which reads `activeCamera`) and the legacy field stay consistent. One
 * undoable `mod-obj`. No-op if `camId` isn't in the scene.
 */
export async function commitCameraPatch(
  sceneId: string,
  camId: string,
  patch: Partial<Camera3DEntry>,
): Promise<void> {
  const doc = currentScene(sceneId)
  if (!doc) return
  const cams = doc.cameras && doc.cameras.length > 0 ? doc.cameras : sceneCameras(doc)
  const idx = cams.findIndex((c) => c.id === camId)
  if (idx < 0) return
  cams[idx] = { ...cams[idx], ...patch }
  doc.cameras = cams
  doc.activeCameraId = doc.activeCameraId ?? cams[0].id
  if (typeof patch.fov === 'number' && cams[idx].id === doc.activeCameraId) {
    doc.camera.fov = patch.fov // legacy mirror (active camera only)
  }
  await commitScene3d(sceneId, doc)
}

/** Patch the ACTIVE (look-through) camera — the pose-persistence path (orbit end). */
export async function commitActiveCameraPatch(
  sceneId: string,
  patch: Partial<Camera3DEntry>,
): Promise<void> {
  const doc = currentScene(sceneId)
  if (!doc) return
  const cams = doc.cameras && doc.cameras.length > 0 ? doc.cameras : sceneCameras(doc)
  await commitCameraPatch(sceneId, doc.activeCameraId ?? cams[0].id, patch)
}

/**
 * Append a new camera to the scene and return its id (or null if the scene is gone).
 * Does NOT change the look-through camera — the caller decides whether to select it
 * (`setSelectedCamera`) and/or look through it (`commitSetActiveCamera`). The pose is
 * the caller's (typically the current live view, so the camera starts "here").
 */
export async function commitAddCamera(
  sceneId: string,
  entry: {
    name: string
    transform3d?: Camera3DEntry['transform3d']
    projection?: CameraProjection
    fov?: number
  },
): Promise<string | null> {
  const doc = currentScene(sceneId)
  if (!doc) return null
  const cams = doc.cameras && doc.cameras.length > 0 ? doc.cameras : sceneCameras(doc)
  const id = `${sceneId}:cam-${crypto.randomUUID()}`
  const cam: Camera3DEntry = {
    id,
    name: entry.name,
    projection: entry.projection ?? 'perspective',
    fov: entry.fov ?? cams[0].fov,
    transform3d: entry.transform3d,
  }
  doc.cameras = [...cams, cam]
  doc.activeCameraId = doc.activeCameraId ?? cams[0].id
  await commitScene3d(sceneId, doc)
  return id
}

/** Look through a camera: make it the scene's ACTIVE (rendered-through) camera. Keeps
 *  the legacy `camera.fov` in sync with the newly-active camera. One undoable `mod-obj`. */
export async function commitSetActiveCamera(sceneId: string, camId: string): Promise<void> {
  const doc = currentScene(sceneId)
  if (!doc) return
  const cams = doc.cameras && doc.cameras.length > 0 ? doc.cameras : sceneCameras(doc)
  const cam = cams.find((c) => c.id === camId)
  if (!cam) return
  doc.cameras = cams
  doc.activeCameraId = camId
  doc.camera.fov = cam.fov
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
