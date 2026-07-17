/**
 * The live camera tracks the DOCUMENT's camera pose.
 *
 * Regression: a camera's `transform3d` only reached the three.js camera at BUILD time,
 * so editing a camera's position in the inspector did nothing on screen. applyDocToInstance
 * now re-poses the live camera when the doc's pose changed — while still never fighting
 * the user's live orbit (where the camera moves and the doc lags until the commit lands).
 *
 * Builds a Scene3DInstance by hand (buildSceneInstance needs a WebGLRenderer, which
 * headless vitest has no GPU for); applyDocToInstance only touches scene/camera/objects.
 */

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildCamera, applyDocToInstance } from '@/lib/renderer/three/three-scene'
import {
  defaultSceneDocument,
  activeCamera,
  type Scene3DDocument,
  type Scene3DInstance,
} from '@/lib/renderer/three/scene3d-store'

function sceneWithCameraPose(pose?: { position: [number, number, number]; rotationEuler: [number, number, number] }): Scene3DDocument {
  const doc = defaultSceneDocument('s1')
  doc.cameras = [{ ...doc.cameras![0], transform3d: pose }]
  return doc
}

/** A minimal instance around the doc's active camera (no GPU needed). */
function instanceFor(doc: Scene3DDocument): Scene3DInstance {
  return {
    scene: new THREE.Scene(),
    camera: buildCamera(activeCamera(doc), 1),
    activeCamId: activeCamera(doc).id,
    objects: new Map(),
    dispose: () => {},
  }
}

describe('live camera tracks the document pose', () => {
  it('an external pose change (inspector/undo) re-poses the live camera', () => {
    const doc = sceneWithCameraPose({ position: [1, 1, 1], rotationEuler: [0, 0, 0] })
    const inst = instanceFor(doc)
    expect(inst.camera.position.toArray()).toEqual([1, 1, 1])

    // The inspector commits a new position → the doc changes under the live camera.
    doc.cameras![0] = {
      ...doc.cameras![0],
      transform3d: { position: [5, 2, -3], rotationEuler: [0, 90, 0] },
    }
    applyDocToInstance(inst, doc)

    expect(inst.camera.position.toArray()).toEqual([5, 2, -3])
    expect(inst.camera.rotation.y).toBeCloseTo(Math.PI / 2, 6)
  })

  it('does NOT fight a live orbit: an unchanged doc leaves the moved camera alone', () => {
    const doc = sceneWithCameraPose({ position: [1, 1, 1], rotationEuler: [0, 0, 0] })
    const inst = instanceFor(doc)

    // Simulate OrbitControls moving the camera; the doc still holds the last commit.
    inst.camera.position.set(9, 9, 9)
    applyDocToInstance(inst, doc)

    expect(inst.camera.position.toArray()).toEqual([9, 9, 9]) // not snapped back
  })

  it('a camera with no pose sits at the canonical home view and stays put', () => {
    const doc = sceneWithCameraPose(undefined)
    const inst = instanceFor(doc)
    expect(inst.camera.position.toArray()).toEqual([2.4, 1.8, 2.8])

    inst.camera.position.set(0, 0, 7) // orbited away
    applyDocToInstance(inst, doc)
    expect(inst.camera.position.toArray()).toEqual([0, 0, 7]) // still not fought
  })
})
