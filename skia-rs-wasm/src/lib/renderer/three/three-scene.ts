/**
 * three-scene — pure three.js helpers for building/syncing a 3D object instance.
 *
 * No React, no store mutation. Given a serializable `Scene3DEntry`, builds the
 * live three objects (scene + lights + IBL + mesh + camera) and syncs them from
 * the entry on demand. IBL comes from `RoomEnvironment` via `PMREMGenerator` so
 * we ship no HDR asset.
 */

import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { Scene3DEntry, Scene3DInstance } from './scene3d-store'

const DEG = Math.PI / 180

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

function makeMaterial(m: Scene3DEntry['material']): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(m.color),
    metalness: m.metalness,
    roughness: m.roughness,
    transparent: m.opacity < 1,
    opacity: m.opacity,
  })
}

/** Build the live three.js instance for one entry. */
export function buildInstance(renderer: THREE.WebGLRenderer, entry: Scene3DEntry): Scene3DInstance {
  const scene = new THREE.Scene()

  // Image-based lighting from a procedural room — no HDR file to ship.
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04)
  scene.environment = envRT.texture
  pmrem.dispose()

  const ambient = new THREE.AmbientLight(0xffffff, 0.35 * entry.env.intensity)
  const dir = new THREE.DirectionalLight(0xffffff, 1.1 * entry.env.intensity)
  dir.position.set(3, 5, 4)
  scene.add(ambient, dir)

  const root = new THREE.Group()
  if (entry.source.kind === 'primitive') {
    root.add(new THREE.Mesh(makePrimitiveGeometry(entry.source.ref), makeMaterial(entry.material)))
  } else if (entry.source.kind === 'gltf') {
    void loadGLTFInto(root, entry.source.ref)
  }
  scene.add(root)

  const camera = new THREE.PerspectiveCamera(entry.camera.fov, 1, 0.01, 100)
  camera.position.set(2.4, 1.8, 2.8)
  camera.lookAt(0, 0, 0)

  const dispose = () => {
    disposeObject(scene)
    envRT.dispose()
  }

  const inst: Scene3DInstance = { root, scene, camera, dispose }
  applyEntryToInstance(inst, entry)
  return inst
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

/**
 * Sync the live instance from the serializable entry.
 * `syncTransform=false` while a gizmo owns the transform (avoids a feedback loop).
 */
export function applyEntryToInstance(
  inst: Scene3DInstance,
  entry: Scene3DEntry,
  syncTransform = true,
): void {
  if (syncTransform) {
    const t = entry.transform3d
    inst.root.position.set(t.position[0], t.position[1], t.position[2])
    inst.root.rotation.set(t.rotationEuler[0] * DEG, t.rotationEuler[1] * DEG, t.rotationEuler[2] * DEG)
    inst.root.scale.set(t.scale[0], t.scale[1], t.scale[2])
  }
  inst.root.traverse((o) => {
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
  if (inst.camera.fov !== entry.camera.fov) {
    inst.camera.fov = entry.camera.fov
    inst.camera.updateProjectionMatrix()
  }
}

/** Read the live root transform back into a serializable patch (after a gizmo drag). */
export function readTransformFromInstance(inst: Scene3DInstance): Scene3DEntry['transform3d'] {
  const r = inst.root
  return {
    position: [r.position.x, r.position.y, r.position.z],
    rotationEuler: [r.rotation.x / DEG, r.rotation.y / DEG, r.rotation.z / DEG],
    scale: [r.scale.x, r.scale.y, r.scale.z],
  }
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
