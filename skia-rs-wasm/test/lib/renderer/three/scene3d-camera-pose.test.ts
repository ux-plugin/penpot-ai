import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildCamera, readCameraPose } from '@/lib/renderer/three/three-scene'
import { defaultCamera, type Camera3DEntry } from '@/lib/renderer/three/scene3d-store'

const DEG = Math.PI / 180

describe('camera pose persistence', () => {
  it('a camera with no transform3d builds at the canonical 3/4 home view', () => {
    const cam = defaultCamera('s1')
    expect(cam.transform3d).toBeUndefined()
    const built = buildCamera(cam)
    // The home placement (2.4, 1.8, 2.8), looking at the origin.
    expect(built.position.toArray()).toEqual([2.4, 1.8, 2.8])
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(built.quaternion).normalize()
    const toOrigin = built.position.clone().negate().normalize()
    // Forward should point back at the origin (lookAt(0,0,0)).
    expect(fwd.dot(toOrigin)).toBeCloseTo(1, 5)
  })

  it('a persisted pose restores the camera position + aim exactly', () => {
    const cam: Camera3DEntry = {
      id: 's1:cam0',
      name: 'Camera',
      projection: 'perspective',
      fov: 45,
      transform3d: { position: [1, 2, 3], rotationEuler: [10, 20, 30] },
    }
    const built = buildCamera(cam)
    expect(built.position.toArray()).toEqual([1, 2, 3])
    expect(built.rotation.x).toBeCloseTo(10 * DEG, 6)
    expect(built.rotation.y).toBeCloseTo(20 * DEG, 6)
    expect(built.rotation.z).toBeCloseTo(30 * DEG, 6)
  })

  it('readCameraPose round-trips through buildCamera', () => {
    const pose = { position: [4, -1, 2] as [number, number, number], rotationEuler: [5, -15, 45] as [number, number, number] }
    const built = buildCamera({
      id: 'c',
      name: 'Camera',
      projection: 'perspective',
      fov: 50,
      transform3d: pose,
    })
    const read = readCameraPose(built)
    expect(read.position[0]).toBeCloseTo(4, 6)
    expect(read.position[1]).toBeCloseTo(-1, 6)
    expect(read.position[2]).toBeCloseTo(2, 6)
    expect(read.rotationEuler[0]).toBeCloseTo(5, 4)
    expect(read.rotationEuler[1]).toBeCloseTo(-15, 4)
    expect(read.rotationEuler[2]).toBeCloseTo(45, 4)
  })

  it('an orthographic camera also honours the persisted pose', () => {
    const cam: Camera3DEntry = {
      id: 's1:cam0',
      name: 'Camera',
      projection: 'orthographic',
      fov: 45,
      transform3d: { position: [0, 5, 5], rotationEuler: [-45, 0, 0] },
    }
    const built = buildCamera(cam)
    expect((built as THREE.OrthographicCamera).isOrthographicCamera).toBe(true)
    expect(built.position.toArray()).toEqual([0, 5, 5])
    expect(built.rotation.x).toBeCloseTo(-45 * DEG, 6)
  })
})
