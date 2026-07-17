/**
 * Multi-camera model + commits (Phase: named/addable/switchable/look-through cameras).
 *
 * Pure helpers (nextCameraName) are tested directly; the commits
 * (add / set-active / patch) run through the real commit pipeline on a booted doc,
 * asserting they land on `node.scene3d.cameras` / `activeCameraId` and are undoable.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IndexedPage, IndexedShape } from '../../../../src/lib/worker/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { docProxy } from '../../../../src/lib/renderer/store/doc-proxy'
import { useHistoryStore } from '../../../../src/lib/history/history-store'
import { undo } from '../../../../src/lib/page-crud'
import {
  scene3dProxy,
  defaultSceneDocument,
  nextCameraName,
  activeCamera,
  sceneCameras,
  setFocusedObject,
  setSelectedCamera,
  type Scene3DDocument,
} from '../../../../src/lib/renderer/three/scene3d-store'
import { hydrateScene3dFromDocument } from '../../../../src/lib/renderer/three/scene3d-sync'
import {
  commitAddCamera,
  commitSetActiveCamera,
  commitCameraPatch,
} from '../../../../src/lib/renderer/three/scene3d-commit'

const PAGE_ID = 'page1'
const ROOT = '00000000-0000-0000-0000-000000000000'
const RECT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

function squareShape(id: string, size: number, extra: Partial<IndexedShape> = {}): IndexedShape {
  const sel = { x: 0, y: 0, width: size, height: size, x1: 0, y1: 0, x2: size, y2: size }
  return {
    id,
    type: 'rect',
    name: '3D scene',
    parentId: ROOT,
    frameId: ROOT,
    x: 0,
    y: 0,
    width: size,
    height: size,
    selrect: sel,
    points: [
      { x: 0, y: 0 },
      { x: size, y: 0 },
      { x: size, y: size },
      { x: 0, y: size },
    ],
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    ...extra,
  } as IndexedShape
}

function makePage(): IndexedPage {
  const rootSel = { x: 0, y: 0, width: 800, height: 600, x1: 0, y1: 0, x2: 800, y2: 600 }
  return {
    id: PAGE_ID,
    objects: {
      [ROOT]: {
        id: ROOT,
        type: 'frame',
        name: 'Root',
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        selrect: rootSel,
        points: [],
        shapes: [RECT],
      } as IndexedShape,
      [RECT]: squareShape(RECT, 100),
    },
  }
}

function nodeScene(id: string): Scene3DDocument | undefined {
  return (docProxy.pageMap.get(PAGE_ID)?.objects[id] as IndexedShape | undefined)?.scene3d
}

function seedScene(id: string, doc: Scene3DDocument): void {
  ;(docProxy.pageMap.get(PAGE_ID)!.objects[id] as IndexedShape).scene3d = doc
}

describe('multi-camera model helpers', () => {
  it('nextCameraName is one past the highest existing Camera N', () => {
    const scene = defaultSceneDocument('s1') // one camera named "Camera 1"
    expect(nextCameraName(scene)).toBe('Camera 2')
    scene.cameras = [
      ...(scene.cameras ?? []),
      { id: 's1:c2', name: 'Camera 3', projection: 'perspective', fov: 45 },
    ]
    expect(nextCameraName(scene)).toBe('Camera 4')
  })

  it('focusing an object and selecting a camera are mutually exclusive', () => {
    setFocusedObject('obj1')
    setSelectedCamera('cam1')
    expect(scene3dProxy.selectedCameraId).toBe('cam1')
    expect(scene3dProxy.focusedObjectId).toBeNull() // selecting a camera cleared focus
    setFocusedObject('obj2')
    expect(scene3dProxy.focusedObjectId).toBe('obj2')
    expect(scene3dProxy.selectedCameraId).toBeNull() // focusing cleared the camera selection
    setFocusedObject(null)
    setSelectedCamera(null)
  })
})

describe('multi-camera commits', () => {
  beforeEach(() => {
    useHistoryStore.setState({ undoStack: [], redoStack: [] })
    docProxy.pageMap.clear()
    docProxy.pageMap.set(PAGE_ID, structuredClone(makePage()))
    docProxy.currentPageId = PAGE_ID
    docProxy.selectedIds.clear()
    scene3dProxy.scenes.clear()
    scene3dProxy.focusedObjectId = null
    scene3dProxy.selectedCameraId = null
    useWorkspaceStore.setState({
      workerClient: {
        updatePageWithChanges: vi.fn(async () => {}),
        updatePage: vi.fn(async () => {}),
      } as never,
      renderer: null,
    })
    seedScene(RECT, defaultSceneDocument(RECT))
    hydrateScene3dFromDocument()
  })

  it('commitAddCamera appends a camera at the given pose without switching active', async () => {
    const before = nodeScene(RECT)!
    const activeBefore = before.activeCameraId
    const id = await commitAddCamera(RECT, {
      name: 'Camera 2',
      transform3d: { position: [1, 2, 3], rotationEuler: [0, 90, 0] },
    })
    expect(id).toBeTruthy()
    const doc = nodeScene(RECT)!
    expect(doc.cameras).toHaveLength(2)
    expect(doc.activeCameraId).toBe(activeBefore) // add does NOT look through
    const added = doc.cameras!.find((c) => c.id === id)!
    expect(added.name).toBe('Camera 2')
    expect(added.transform3d).toEqual({ position: [1, 2, 3], rotationEuler: [0, 90, 0] })
    // undoable
    await undo()
    expect(nodeScene(RECT)!.cameras).toHaveLength(1)
  })

  it('commitSetActiveCamera looks through a camera and mirrors its fov', async () => {
    const id = await commitAddCamera(RECT, { name: 'Camera 2', fov: 80 })
    await commitSetActiveCamera(RECT, id!)
    const doc = nodeScene(RECT)!
    expect(doc.activeCameraId).toBe(id)
    expect(activeCamera(doc).id).toBe(id)
    expect(doc.camera.fov).toBe(80) // legacy mirror follows the active camera
  })

  it('commitCameraPatch edits a specific camera; legacy fov mirrors only the active one', async () => {
    const doc0 = nodeScene(RECT)!
    const activeId = doc0.activeCameraId!
    const other = await commitAddCamera(RECT, { name: 'Camera 2', fov: 45 })

    // Patch the NON-active camera → its fov changes, legacy mirror does not.
    await commitCameraPatch(RECT, other!, { fov: 30, projection: 'orthographic' })
    let doc = nodeScene(RECT)!
    expect(doc.cameras!.find((c) => c.id === other)!.fov).toBe(30)
    expect(doc.cameras!.find((c) => c.id === other)!.projection).toBe('orthographic')
    expect(doc.camera.fov).not.toBe(30)

    // Patch the ACTIVE camera → legacy mirror follows.
    await commitCameraPatch(RECT, activeId, { fov: 55 })
    doc = nodeScene(RECT)!
    expect(sceneCameras(doc).find((c) => c.id === activeId)!.fov).toBe(55)
    expect(doc.camera.fov).toBe(55)
  })

  it('projection toggle is lossless: fov and orthoSize persist independently', async () => {
    const activeId = nodeScene(RECT)!.activeCameraId!
    await commitCameraPatch(RECT, activeId, { fov: 60 })
    await commitCameraPatch(RECT, activeId, { projection: 'orthographic', orthoSize: 3.5 })
    await commitCameraPatch(RECT, activeId, { projection: 'perspective' })
    const cam = sceneCameras(nodeScene(RECT)!).find((c) => c.id === activeId)!
    expect(cam.projection).toBe('perspective')
    expect(cam.fov).toBe(60) // FOV retained across the ortho round-trip
    expect(cam.orthoSize).toBe(3.5) // ortho size retained too
  })
})
