/**
 * three-scene — pure three.js helpers for building/syncing a 3D *scene* instance.
 *
 * No React, no store mutation. Given a serializable `Scene3DDocument`, builds one
 * live three.js scene (shared lights + IBL + camera) holding one root group per
 * object, and reconciles them from the document on demand. IBL comes from
 * `RoomEnvironment` via `PMREMGenerator` so we ship no HDR asset.
 */

import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { Object3DEntry, Scene3DDocument, Scene3DInstance, Vec3 } from './scene3d-store'
import { activeCamera, type Camera3DEntry } from './scene3d-store'
import { CAM_FAR, CAM_NEAR, isOrtho, isPersp, orthoFrustum, perspHalfHeightAtDistance } from './camera3d'

const DEG = Math.PI / 180

/** The default camera placement (a 3/4 view) both projections start from. */
const CAM_HOME_POS: readonly [number, number, number] = [2.4, 1.8, 2.8]

/**
 * Place a freshly-built camera at its pose: the persisted `transform3d` (position +
 * XYZ-Euler-degree aim) when present, else the canonical 3/4 home view looking at the
 * origin. The rendered image depends only on position + orientation, so restoring
 * these two reproduces the saved view exactly (the orbit pivot — not in the model —
 * is reconstructed by the overlay from the camera's forward ray).
 */
export function applyCameraPose(
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  cam: Camera3DEntry,
): void {
  const pose = cam.transform3d
  // Stamp the pose's document identity on the camera so applyDocToInstance can tell an
  // EXTERNAL pose change apart from the user's own live orbit (see poseKeyOf).
  camera.userData.poseKey = poseKeyOf(pose)
  if (pose) {
    camera.position.set(pose.position[0], pose.position[1], pose.position[2])
    camera.rotation.set(
      pose.rotationEuler[0] * DEG,
      pose.rotationEuler[1] * DEG,
      pose.rotationEuler[2] * DEG,
    )
  } else {
    camera.position.set(CAM_HOME_POS[0], CAM_HOME_POS[1], CAM_HOME_POS[2])
    camera.lookAt(0, 0, 0)
  }
}

/**
 * Identity of a pose AS THE DOCUMENT HOLDS IT, stamped on the live camera whenever we
 * apply one. It lets `applyDocToInstance` distinguish:
 *  - an EXTERNAL change (inspector edit, undo) — the doc's key differs from the camera's
 *    stamp ⇒ re-pose the live camera; and
 *  - the user's own live orbit — the camera has moved but the doc still holds the last
 *    committed pose, so the keys MATCH ⇒ leave the camera alone.
 * Without it the doc would fight OrbitControls every frame (or the pose would never
 * reach the camera at all, which is exactly what it did before).
 */
function poseKeyOf(pose: Camera3DEntry['transform3d']): string {
  return pose ? JSON.stringify(pose) : 'default'
}

/**
 * Build the scene's active camera. Perspective is framed by FOV; orthographic by a
 * world half-height chosen to match the perspective framing at the home distance
 * (so a fresh ortho scene reads at the same scale). `orthoHalfHeight` is stashed on
 * `userData` so draw() can rebuild the frustum when the viewport aspect changes.
 * The pose (position + aim) is then applied from the camera's persisted `transform3d`.
 */
export function buildCamera(
  cam: Camera3DEntry,
  aspect = 1,
): THREE.PerspectiveCamera | THREE.OrthographicCamera {
  if (cam.projection === 'orthographic') {
    // Ortho framing is the camera's own `orthoSize` (persisted, independent of FOV);
    // absent ⇒ derive a sensible default from the FOV at the home distance so a first
    // switch to ortho reads at the same scale.
    const halfH = cam.orthoSize ?? perspHalfHeightAtDistance(cam.fov, Math.hypot(...CAM_HOME_POS))
    const f = orthoFrustum(halfH, aspect)
    const ortho = new THREE.OrthographicCamera(f.left, f.right, f.top, f.bottom, CAM_NEAR, CAM_FAR)
    ortho.userData.orthoHalfHeight = halfH
    applyCameraPose(ortho, cam)
    return ortho
  }
  const persp = new THREE.PerspectiveCamera(cam.fov, aspect, CAM_NEAR, CAM_FAR)
  applyCameraPose(persp, cam)
  return persp
}

/** Read a live camera's pose back into a serializable patch (after orbit/pan/dolly, or
 *  a gizmo drag on a camera-proxy Object3D), mirroring `readTransformFromObject`. */
export function readCameraPose(
  camera: THREE.Object3D,
): { position: Vec3; rotationEuler: Vec3 } {
  return {
    position: [camera.position.x, camera.position.y, camera.position.z],
    rotationEuler: [camera.rotation.x / DEG, camera.rotation.y / DEG, camera.rotation.z / DEG],
  }
}

/**
 * The canonical default pose (the 3/4 home view looking at the origin) as serializable
 * numbers — what a camera with no `transform3d` yet actually renders at. The inspector
 * shows this so an unposed camera reads its real values, and materialises it on edit.
 */
export function defaultCameraPose(): { position: Vec3; rotationEuler: Vec3 } {
  const cam = new THREE.PerspectiveCamera()
  cam.position.set(CAM_HOME_POS[0], CAM_HOME_POS[1], CAM_HOME_POS[2])
  cam.lookAt(0, 0, 0)
  return readCameraPose(cam)
}

function makePrimitiveGeometry(ref: 'cube' | 'sphere' | 'plane'): THREE.BufferGeometry {
  switch (ref) {
    case 'sphere':
      return new THREE.SphereGeometry(0.85, 48, 32)
    case 'plane':
      return new THREE.PlaneGeometry(1.7, 1.7)
    case 'cube':
    default:
      return new THREE.BoxGeometry(1.3, 1.3, 1.3)
  }
}

function makeMaterial(m: Object3DEntry['material']): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(m.color),
    metalness: m.metalness,
    roughness: m.roughness,
    transparent: m.opacity < 1,
    opacity: m.opacity,
  })
}

/** Build the root group for one object (mesh or async-loaded glTF). */
function makeObject3D(entry: Object3DEntry): THREE.Object3D {
  const root = new THREE.Group()
  root.name = entry.id
  if (entry.source.kind === 'primitive') {
    root.add(new THREE.Mesh(makePrimitiveGeometry(entry.source.ref), makeMaterial(entry.material)))
  } else if (entry.source.kind === 'gltf') {
    void loadGLTFInto(root, entry.source.ref)
  }
  applyTransform(root, entry)
  return root
}

/** Build the live three.js instance for a whole scene. */
export function buildSceneInstance(
  renderer: THREE.WebGLRenderer,
  doc: Scene3DDocument,
): Scene3DInstance {
  const scene = new THREE.Scene()

  // Image-based lighting from a procedural room — no HDR file to ship.
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04)
  scene.environment = envRT.texture
  pmrem.dispose()

  const ambient = new THREE.AmbientLight(0xffffff, 0.35 * doc.env.intensity)
  const dir = new THREE.DirectionalLight(0xffffff, 1.1 * doc.env.intensity)
  dir.position.set(3, 5, 4)
  scene.add(ambient, dir)

  const active = activeCamera(doc)
  const camera = buildCamera(active, 1)

  const objects = new Map<string, THREE.Object3D>()
  for (const entry of doc.objects ?? []) {
    const obj = makeObject3D(entry)
    objects.set(entry.id, obj)
    scene.add(obj)
  }

  const dispose = () => {
    disposeObject(scene)
    envRT.dispose()
  }

  return {
    scene,
    camera,
    activeCamId: active.id,
    objects,
    cameraHelpers: new Map(),
    dispose,
  }
}

async function loadGLTFInto(parent: THREE.Object3D, url: string): Promise<void> {
  try {
    const gltf = await new GLTFLoader().loadAsync(url)
    fitToUnit(gltf.scene)
    parent.add(gltf.scene)
  } catch (e) {
    console.error('[Scene3D] GLTF load failed:', e)
  }
}

/** Center a loaded model at the origin and scale it into a ~1.6-unit box. */
function fitToUnit(obj: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(obj)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z) || 1
  const s = 1.6 / maxDim
  obj.scale.setScalar(s)
  obj.position.set(-center.x * s, -center.y * s, -center.z * s)
}

function applyTransform(root: THREE.Object3D, entry: Object3DEntry): void {
  const t = entry.transform3d
  root.position.set(t.position[0], t.position[1], t.position[2])
  root.rotation.set(t.rotationEuler[0] * DEG, t.rotationEuler[1] * DEG, t.rotationEuler[2] * DEG)
  root.scale.set(t.scale[0], t.scale[1], t.scale[2])
}

function applyMaterial(root: THREE.Object3D, entry: Object3DEntry): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    const mat = mesh.material as THREE.MeshStandardMaterial | undefined
    if (mesh.isMesh && mat?.isMeshStandardMaterial) {
      mat.color.set(entry.material.color)
      mat.metalness = entry.material.metalness
      mat.roughness = entry.material.roughness
      mat.opacity = entry.material.opacity
      mat.transparent = entry.material.opacity < 1
    }
  })
}

/**
 * Reconcile the live instance with the document: add/remove object roots to match,
 * sync each object's transform + material, and apply scene-level camera + env.
 * `skipTransformFor` is the object a gizmo currently owns (don't fight its drag).
 */
export function applyDocToInstance(
  inst: Scene3DInstance,
  doc: Scene3DDocument,
  skipTransformFor?: string | null,
): void {
  const docObjects = doc.objects ?? []
  const wanted = new Set(docObjects.map((o) => o.id))

  // Remove objects no longer in the document.
  for (const [id, obj] of inst.objects) {
    if (!wanted.has(id)) {
      inst.scene.remove(obj)
      disposeObject(obj)
      inst.objects.delete(id)
    }
  }

  // Add/sync objects.
  for (const entry of docObjects) {
    let obj = inst.objects.get(entry.id)
    if (!obj) {
      obj = makeObject3D(entry)
      inst.objects.set(entry.id, obj)
      inst.scene.add(obj)
    }
    if (entry.id !== skipTransformFor) applyTransform(obj, entry)
    applyMaterial(obj, entry)
  }

  // Scene-level: perspective FOV + environment. A projection swap (persp⇄ortho)
  // rebuilds the instance elsewhere, so here inst.camera's type already matches the
  // active camera; only the perspective FOV can drift within the same instance.
  const activeCam = activeCamera(doc)

  // Re-pose the live camera when the DOCUMENT's pose changed under it (inspector edit,
  // undo). The pose used to reach the camera only at build time, so editing a camera's
  // position did nothing until something forced a rebuild. Guarded by the pose key so we
  // never fight the user's live orbit — during a drag the doc still holds the last
  // committed pose, so the keys match and the camera is left alone.
  if (inst.camera.userData.poseKey !== poseKeyOf(activeCam.transform3d)) {
    applyCameraPose(inst.camera, activeCam)
  }

  if (isPersp(inst.camera) && inst.camera.fov !== activeCam.fov) {
    inst.camera.fov = activeCam.fov
    inst.camera.updateProjectionMatrix()
  } else if (isOrtho(inst.camera)) {
    // Ortho framing is driven by `orthoHalfHeight` on userData, which
    // renderSceneIntoBox turns into the frustum each frame — keep it in sync with the
    // active camera's persisted `orthoSize` (live-editable via the popover).
    const halfH =
      activeCam.orthoSize ?? perspHalfHeightAtDistance(activeCam.fov, Math.hypot(...CAM_HOME_POS))
    inst.camera.userData.orthoHalfHeight = halfH
  }
  inst.scene.traverse((o) => {
    const light = o as THREE.Light
    if ((light as THREE.AmbientLight).isAmbientLight) light.intensity = 0.35 * doc.env.intensity
    else if ((light as THREE.DirectionalLight).isDirectionalLight) light.intensity = 1.1 * doc.env.intensity
  })
}

/** What a viewport click resolved to — an object (mesh) or a camera (its frustum/body). */
export type Scene3DPick = { kind: 'object'; id: string } | { kind: 'camera'; id: string }

/**
 * Raycast a normalized-device point to the nearest pickable thing in the scene — an
 * object OR a camera frustum-helper (both selectable from the canvas). `cam` is the
 * camera the ray is cast from (what's on screen).
 */
export function pickScene3d(
  inst: Scene3DInstance,
  ndcX: number,
  ndcY: number,
  cam: THREE.Camera = inst.camera,
): Scene3DPick | null {
  const raycaster = new THREE.Raycaster()
  // The frustums are thin LineSegments; give the ray a little tolerance so they're
  // clickable, not just their solid body box.
  raycaster.params.Line = { threshold: 0.04 }
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), cam)

  let best: { pick: Scene3DPick; dist: number } | null = null
  const consider = (pick: Scene3DPick, root: THREE.Object3D) => {
    const hits = raycaster.intersectObject(root, true)
    if (hits.length && (!best || hits[0].distance < best.dist)) best = { pick, dist: hits[0].distance }
  }
  for (const [id, obj] of inst.objects) consider({ kind: 'object', id }, obj)
  for (const [id, h] of inst.cameraHelpers) consider({ kind: 'camera', id }, h.group)
  return best?.pick ?? null
}

/** Read a live object root's transform back into a serializable patch (after a gizmo drag). */
export function readTransformFromObject(obj: THREE.Object3D): Object3DEntry['transform3d'] {
  return {
    position: [obj.position.x, obj.position.y, obj.position.z],
    rotationEuler: [obj.rotation.x / DEG, obj.rotation.y / DEG, obj.rotation.z / DEG],
    scale: [obj.scale.x, obj.scale.y, obj.scale.z],
  }
}

export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    // Anything carrying GPU resources — meshes AND lines (the camera-helper frustums are
    // LineSegments, which an isMesh-only check would silently leak).
    const res = o as unknown as {
      geometry?: THREE.BufferGeometry
      material?: THREE.Material | THREE.Material[]
    }
    res.geometry?.dispose()
    const m = res.material
    if (Array.isArray(m)) m.forEach((mm) => mm.dispose())
    else m?.dispose()
  })
}
