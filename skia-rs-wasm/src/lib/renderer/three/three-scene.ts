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
import type { Object3DEntry, Scene3DDocument, Scene3DInstance } from './scene3d-store'
import { activeCamera, type Camera3DEntry } from './scene3d-store'
import { CAM_FAR, CAM_NEAR, isPersp, orthoFrustum, perspHalfHeightAtDistance } from './camera3d'

const DEG = Math.PI / 180

/** The default camera placement (a 3/4 view) both projections start from. */
const CAM_HOME_POS: readonly [number, number, number] = [2.4, 1.8, 2.8]

/**
 * Build the scene's active camera. Perspective is framed by FOV; orthographic by a
 * world half-height chosen to match the perspective framing at the home distance
 * (so a fresh ortho scene reads at the same scale). `orthoHalfHeight` is stashed on
 * `userData` so draw() can rebuild the frustum when the viewport aspect changes.
 */
export function buildCamera(
  cam: Camera3DEntry,
  aspect = 1,
): THREE.PerspectiveCamera | THREE.OrthographicCamera {
  const [px, py, pz] = CAM_HOME_POS
  if (cam.projection === 'orthographic') {
    const halfH = perspHalfHeightAtDistance(cam.fov, Math.hypot(px, py, pz))
    const f = orthoFrustum(halfH, aspect)
    const ortho = new THREE.OrthographicCamera(f.left, f.right, f.top, f.bottom, CAM_NEAR, CAM_FAR)
    ortho.userData.orthoHalfHeight = halfH
    ortho.position.set(px, py, pz)
    ortho.lookAt(0, 0, 0)
    return ortho
  }
  const persp = new THREE.PerspectiveCamera(cam.fov, aspect, CAM_NEAR, CAM_FAR)
  persp.position.set(px, py, pz)
  persp.lookAt(0, 0, 0)
  return persp
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

  const camera = buildCamera(activeCamera(doc), 1)

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

  return { scene, camera, objects, dispose }
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
  if (isPersp(inst.camera) && inst.camera.fov !== activeCam.fov) {
    inst.camera.fov = activeCam.fov
    inst.camera.updateProjectionMatrix()
  }
  inst.scene.traverse((o) => {
    const light = o as THREE.Light
    if ((light as THREE.AmbientLight).isAmbientLight) light.intensity = 0.35 * doc.env.intensity
    else if ((light as THREE.DirectionalLight).isDirectionalLight) light.intensity = 1.1 * doc.env.intensity
  })
}

/** Read a live object root's transform back into a serializable patch (after a gizmo drag). */
export function readTransformFromObject(obj: THREE.Object3D): Object3DEntry['transform3d'] {
  return {
    position: [obj.position.x, obj.position.y, obj.position.z],
    rotationEuler: [obj.rotation.x / DEG, obj.rotation.y / DEG, obj.rotation.z / DEG],
    scale: [obj.scale.x, obj.scale.y, obj.scale.z],
  }
}

/** Raycast scene-space normalized device coords → the id of the nearest hit object. */
export function pickObject(inst: Scene3DInstance, ndcX: number, ndcY: number): string | null {
  const raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), inst.camera)
  let best: { id: string; dist: number } | null = null
  for (const [id, obj] of inst.objects) {
    const hits = raycaster.intersectObject(obj, true)
    if (hits.length && (!best || hits[0].distance < best.dist)) best = { id, dist: hits[0].distance }
  }
  return best?.id ?? null
}

export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh) {
      mesh.geometry?.dispose()
      const m = mesh.material
      if (Array.isArray(m)) m.forEach((mm) => mm.dispose())
      else m?.dispose()
    }
  })
}
