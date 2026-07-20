/**
 * Camera frustum helpers: the cameras you are NOT looking through get drawn so you can
 * see (and later grab) them. Pure three geometry — no renderer needed, so the sync is
 * testable headlessly with a hand-built instance.
 */

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildCamera } from '@/lib/renderer/three/three-scene'
import { syncCameraHelpers } from '@/lib/renderer/three/scene3d-camera-helpers'
import {
  defaultSceneDocument,
  activeCamera,
  type Camera3DEntry,
  type Scene3DDocument,
  type Scene3DInstance,
} from '@/lib/renderer/three/scene3d-store'

function cam(id: string, extra: Partial<Camera3DEntry> = {}): Camera3DEntry {
  return { id, name: id, projection: 'perspective', fov: 45, ...extra }
}

/** Two-camera scene; cam0 is active. */
function twoCameraScene(): Scene3DDocument {
  const doc = defaultSceneDocument('s1')
  const first = doc.cameras![0]
  doc.cameras = [first, cam('s1:cam1', { transform3d: { position: [4, 0, 0], rotationEuler: [0, 90, 0] } })]
  doc.activeCameraId = first.id
  return doc
}

function instanceFor(doc: Scene3DDocument): Scene3DInstance {
  return {
    scene: new THREE.Scene(),
    camera: buildCamera(activeCamera(doc), 1),
    activeCamId: activeCamera(doc).id,
    objects: new Map(),
    cameraHelpers: new Map(),
    dispose: () => {},
  }
}

const OPTS = { visible: true, aspect: 1.5, selectedCameraId: null }

describe('camera frustum helpers', () => {
  it('draws every camera except the one being looked through', () => {
    const doc = twoCameraScene()
    const inst = instanceFor(doc)
    syncCameraHelpers(inst, doc, OPTS)

    expect([...inst.cameraHelpers.keys()]).toEqual(['s1:cam1']) // not the active cam0
    expect(inst.scene.children).toContain(inst.cameraHelpers.get('s1:cam1')!.group)
  })

  it('is editor chrome: nothing is added when not visible, and existing helpers are removed', () => {
    const doc = twoCameraScene()
    const inst = instanceFor(doc)
    syncCameraHelpers(inst, doc, OPTS)
    expect(inst.cameraHelpers.size).toBe(1)

    syncCameraHelpers(inst, doc, { ...OPTS, visible: false })
    expect(inst.cameraHelpers.size).toBe(0)
    expect(inst.scene.children.length).toBe(0)
  })

  it('follows a look-through switch: the camera you leave becomes visible, the one you enter hides', () => {
    const doc = twoCameraScene()
    const inst = instanceFor(doc)
    syncCameraHelpers(inst, doc, OPTS)
    expect([...inst.cameraHelpers.keys()]).toEqual(['s1:cam1'])

    doc.activeCameraId = 's1:cam1' // look through the other one
    syncCameraHelpers(inst, doc, OPTS)
    expect([...inst.cameraHelpers.keys()]).toEqual(['s1:cam0'])
  })

  it("the frustum sits at the camera's pose and follows it", () => {
    const doc = twoCameraScene()
    const inst = instanceFor(doc)
    syncCameraHelpers(inst, doc, OPTS)
    const h = inst.cameraHelpers.get('s1:cam1')!
    expect(h.cam.position.toArray()).toEqual([4, 0, 0])

    // Move the camera in the document (an inspector edit) → the frustum tracks it.
    doc.cameras![1] = {
      ...doc.cameras![1],
      transform3d: { position: [-2, 3, 1], rotationEuler: [0, 0, 0] },
    }
    syncCameraHelpers(inst, doc, OPTS)
    expect(inst.cameraHelpers.get('s1:cam1')!.cam.position.toArray()).toEqual([-2, 3, 1])
  })
})
