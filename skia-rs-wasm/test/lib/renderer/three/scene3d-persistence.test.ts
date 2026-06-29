/**
 * scene3d persistence wiring (Phase 1.5, scene-container model).
 *
 * Boots the real commit pipeline + stores (renderer stubbed null, worker mocked)
 * and asserts that a 3D scene living on `node.scene3d` stays in sync with
 * `scene3dProxy`, is undoable, and is rebuilt on load:
 *   - add-obj carrying scene3d         → proxy gains the scene (create path)
 *   - mod-obj editing an object        → node + proxy update; Cmd-Z reverts both
 *   - non-scene3d mod-obj (geometry)   → scene untouched
 *   - del-obj                          → scene dropped
 *   - hydrateScene3dFromDocument       → proxy reseeded from nodes
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddObjChange, Change } from 'penpot-exporter/types'
import type { IndexedPage, IndexedShape } from '../../../../src/lib/worker/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { docProxy } from '../../../../src/lib/renderer/store/doc-proxy'
import { useHistoryStore } from '../../../../src/lib/history/history-store'
import { commitChanges } from '../../../../src/lib/renderer/store/commit'
import { undo } from '../../../../src/lib/page-crud'
import {
  scene3dProxy,
  defaultObject,
  defaultSceneDocument,
  isScene3D,
  type Scene3DDocument,
} from '../../../../src/lib/renderer/three/scene3d-store'
import { hydrateScene3dFromDocument } from '../../../../src/lib/renderer/three/scene3d-sync'
import { commitObjectMaterial } from '../../../../src/lib/renderer/three/scene3d-commit'

const PAGE_ID = 'page1'
const ROOT = '00000000-0000-0000-0000-000000000000'
const RECT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const NEW = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const OBJ = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

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
        points: [
          { x: 0, y: 0 },
          { x: 800, y: 0 },
          { x: 800, y: 600 },
          { x: 0, y: 600 },
        ],
        shapes: [RECT],
      } as IndexedShape,
      [RECT]: squareShape(RECT, 100),
    },
  }
}

/** A scene document with one cube object (creation now makes an empty scene). */
function sceneWithObject(sceneId: string, objId: string): Scene3DDocument {
  return {
    ...defaultSceneDocument(sceneId),
    objects: [defaultObject(objId, { kind: 'primitive', ref: 'cube' })],
  }
}

function nodeScene3d(id: string): Scene3DDocument | undefined {
  return (docProxy.pageMap.get(PAGE_ID)?.objects[id] as IndexedShape | undefined)?.scene3d
}

function firstObjectColor(scene: Scene3DDocument | undefined): string | undefined {
  return scene?.objects[0]?.material.color
}

function seedScene3d(id: string, doc: Scene3DDocument): void {
  const node = docProxy.pageMap.get(PAGE_ID)!.objects[id] as IndexedShape
  node.scene3d = doc
}

describe('scene3d persistence', () => {
  beforeEach(() => {
    useHistoryStore.setState({ undoStack: [], redoStack: [] })

    docProxy.pageMap.clear()
    docProxy.pageMap.set(PAGE_ID, structuredClone(makePage()))
    docProxy.currentPageId = PAGE_ID
    docProxy.selectedIds.clear()

    scene3dProxy.scenes.clear()
    scene3dProxy.editingSceneId = null
    scene3dProxy.focusedObjectId = null

    useWorkspaceStore.setState({
      workerClient: {
        updatePageWithChanges: vi.fn(async () => {}),
        updatePage: vi.fn(async () => {}),
      } as never,
      renderer: null,
    })
  })

  it('add-obj carrying scene3d populates scene3dProxy (create path)', async () => {
    const doc = sceneWithObject(NEW, OBJ)
    const add: AddObjChange = {
      type: 'add-obj',
      id: NEW,
      obj: { ...squareShape(NEW, 240), scene3d: doc } as AddObjChange['obj'],
      parentId: ROOT,
      frameId: ROOT,
      index: 1,
      pageId: PAGE_ID,
    }
    await commitChanges({ redoChanges: [add], pageId: PAGE_ID, saveUndo: false })

    expect(isScene3D(NEW)).toBe(true)
    expect(scene3dProxy.scenes.get(NEW)).toEqual(doc)
    expect(nodeScene3d(NEW)).toEqual(doc)
  })

  it('editing an object via commitObjectMaterial updates node + proxy and is undoable', async () => {
    const base = sceneWithObject(RECT, OBJ)
    seedScene3d(RECT, base)
    hydrateScene3dFromDocument()
    expect(firstObjectColor(scene3dProxy.scenes.get(RECT))).toBe(base.objects[0].material.color)

    await commitObjectMaterial(RECT, OBJ, { color: '#ff0000' })

    expect(nodeScene3d(RECT)?.objects[0].material.color).toBe('#ff0000')
    expect(firstObjectColor(scene3dProxy.scenes.get(RECT))).toBe('#ff0000')
    expect(useHistoryStore.getState().undoStack).toHaveLength(1)

    await undo()

    expect(nodeScene3d(RECT)?.objects[0].material.color).toBe(base.objects[0].material.color)
    expect(firstObjectColor(scene3dProxy.scenes.get(RECT))).toBe(base.objects[0].material.color)
  })

  it('a non-scene3d edit (geometry) leaves the scene intact', async () => {
    const base = sceneWithObject(RECT, OBJ)
    seedScene3d(RECT, base)
    hydrateScene3dFromDocument()

    const moveX: Change = {
      type: 'mod-obj',
      id: RECT,
      operations: [{ type: 'assign', value: { x: 42 } }],
    }
    await commitChanges({ redoChanges: [moveX], pageId: PAGE_ID, saveUndo: false })

    expect(isScene3D(RECT)).toBe(true)
    expect(scene3dProxy.scenes.get(RECT)).toEqual(base)
  })

  it('del-obj drops the scene', async () => {
    seedScene3d(RECT, sceneWithObject(RECT, OBJ))
    hydrateScene3dFromDocument()
    expect(isScene3D(RECT)).toBe(true)

    const del: Change = { type: 'del-obj', id: RECT, pageId: PAGE_ID }
    await commitChanges({ redoChanges: [del], pageId: PAGE_ID, saveUndo: false })

    expect(isScene3D(RECT)).toBe(false)
    expect(scene3dProxy.scenes.has(RECT)).toBe(false)
  })

  it('hydrateScene3dFromDocument seeds from nodes and clears when absent', () => {
    seedScene3d(RECT, sceneWithObject(RECT, OBJ))
    scene3dProxy.scenes.clear()

    hydrateScene3dFromDocument()
    expect(scene3dProxy.scenes.has(RECT)).toBe(true)

    const node = docProxy.pageMap.get(PAGE_ID)!.objects[RECT] as IndexedShape
    delete node.scene3d
    hydrateScene3dFromDocument()
    expect(scene3dProxy.scenes.size).toBe(0)
  })
})
