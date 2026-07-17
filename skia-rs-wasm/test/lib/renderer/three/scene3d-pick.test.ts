/**
 * Viewport picking: a click selects the nearest thing under the cursor — an object OR a
 * camera frustum. Pure raycasting, so it's testable headlessly with a hand-built scene.
 */

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { pickScene3d } from '@/lib/renderer/three/three-scene'
import { syncCameraHelpers } from '@/lib/renderer/three/scene3d-camera-helpers'
import {
  defaultSceneDocument,
  type Scene3DInstance,
} from '@/lib/renderer/three/scene3d-store'

/** A camera at (0,0,5) looking down -Z, so NDC (0,0) rays through the origin. */
function rayCam(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  c.position.set(0, 0, 5)
  c.lookAt(0, 0, 0)
  c.updateMatrixWorld(true)
  return c
}

function emptyInstance(cam: THREE.PerspectiveCamera): Scene3DInstance {
  return {
    scene: new THREE.Scene(),
    camera: cam,
    activeCamId: 'x',
    objects: new Map(),
    cameraHelpers: new Map(),
    dispose: () => {},
  }
}

describe('pickScene3d', () => {
  it('hits an object at screen centre', () => {
    const cam = rayCam()
    const inst = emptyInstance(cam)
    const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    cube.updateMatrixWorld(true)
    inst.objects.set('obj1', cube)
    inst.scene.add(cube)
    expect(pickScene3d(inst, 0, 0, cam)).toEqual({ kind: 'object', id: 'obj1' })
  })

  it('hits a camera frustum at screen centre', () => {
    const cam = rayCam()
    const inst = emptyInstance(cam)
    // A scene whose non-active camera sits at the origin → its helper body is drawn there.
    const doc = defaultSceneDocument('s1')
    const c0 = doc.cameras![0]
    doc.cameras = [
      c0,
      { ...c0, id: 's1:c2', name: 'Camera 2', transform3d: { position: [0, 0, 0], rotationEuler: [0, 0, 0] } },
    ]
    doc.activeCameraId = c0.id
    syncCameraHelpers(inst, doc, { visible: true, aspect: 1, selectedCameraId: null })
    inst.scene.updateMatrixWorld(true)
    expect(pickScene3d(inst, 0, 0, cam)).toEqual({ kind: 'camera', id: 's1:c2' })
  })

  it('returns null on empty space', () => {
    const cam = rayCam()
    expect(pickScene3d(emptyInstance(cam), 0, 0, cam)).toBeNull()
  })
})
