/**
 * scene3d persistence wiring (Phase 1.5, scene-container model).
 *
 * Boots the real commit pipeline + stores (renderer stubbed null, worker mocked)
 * and asserts that a 3D scene living on `node.scene3d` stays in sync with
 * `scene3dProxy`, is undoable, and is rebuilt on load:
 *   - add carrying scene3d              → proxy gains the scene (create path)
 *   - mod editing an object             → node + proxy update; Cmd-Z reverts both
 *   - non-scene3d mod (geometry)        → scene untouched
 *   - del                               → scene dropped
 *   - hydrateScene3dFromDocument        → proxy reseeded from nodes
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PenpotDocument, PenpotNode } from 'penpot-exporter/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { commitChanges } from '../../../../src/lib/renderer/store/commit'
import { addNode, del, getNode, mod, undo } from '../../../../src/lib/doc'
import { framesOf } from '../../../../src/lib/doc/undo'
import { resetWorkspace, seedDocument } from '../../fixtures'
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
const RECT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const NEW = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const OBJ = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

function squareShape(id: string, size: number, scene3d?: Scene3DDocument): PenpotNode {
  const sel = { x: 0, y: 0, width: size, height: size, x1: 0, y1: 0, x2: size, y2: size }
  return {
    id,
    type: 'rect',
    name: '3D scene',
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
    ...(scene3d ? { scene3d } : {}),
  } as unknown as PenpotNode
}

/** One page holding RECT, optionally carrying `scene3d`. */
function seedRect(scene3d?: Scene3DDocument): void {
  const doc: PenpotDocument = {
    name: 'Test',
    children: [{ id: PAGE_ID, name: 'Page 1', background: '#FFFFFF', children: [squareShape(RECT, 100, scene3d)] }],
    components: {},
    images: {},
    paintStyles: {},
    textStyles: {},
    componentProperties: {},
    externalLibraries: {},
    missingFonts: [],
    isShared: false,
  }
  seedDocument(doc)
}

/** A scene document with one cube object (creation now makes an empty scene). */
function sceneWithObject(sceneId: string, objId: string): Scene3DDocument {
  return {
    ...defaultSceneDocument(sceneId),
    objects: [defaultObject(objId, { kind: 'primitive', ref: 'cube' })],
  }
}

function nodeScene3d(id: string): Scene3DDocument | undefined {
  return getNode(id)?.scene3d
}

function firstObjectColor(scene: Scene3DDocument | undefined): string | undefined {
  return scene?.objects[0]?.material.color
}

describe('scene3d persistence', () => {
  beforeEach(() => {
    resetWorkspace()
    scene3dProxy.scenes.clear()
    scene3dProxy.focusedObjectId = null
    useWorkspaceStore.setState({ workerClient: { applyChanges: vi.fn(async () => {}) } as never, renderer: null })
    seedRect()
  })

  it('an add carrying scene3d populates scene3dProxy (create path)', async () => {
    const doc = sceneWithObject(NEW, OBJ)
    await commitChanges({
      changes: [addNode(squareShape(NEW, 240, doc), { page: PAGE_ID })],
      saveUndo: false,
    })

    expect(isScene3D(NEW)).toBe(true)
    expect(scene3dProxy.scenes.get(NEW)).toEqual(doc)
    expect(nodeScene3d(NEW)).toEqual(doc)
  })

  it('editing an object via commitObjectMaterial updates node + proxy and is undoable', async () => {
    const base = sceneWithObject(RECT, OBJ)
    seedRect(base)
    hydrateScene3dFromDocument()
    expect(firstObjectColor(scene3dProxy.scenes.get(RECT))).toBe(base.objects[0].material.color)

    await commitObjectMaterial(RECT, OBJ, { color: '#ff0000' })

    expect(nodeScene3d(RECT)?.objects[0].material.color).toBe('#ff0000')
    expect(firstObjectColor(scene3dProxy.scenes.get(RECT))).toBe('#ff0000')
    expect(framesOf()).toHaveLength(1)

    await undo()

    expect(nodeScene3d(RECT)?.objects[0].material.color).toBe(base.objects[0].material.color)
    expect(firstObjectColor(scene3dProxy.scenes.get(RECT))).toBe(base.objects[0].material.color)
  })

  it('a non-scene3d edit (geometry) leaves the scene intact', async () => {
    const base = sceneWithObject(RECT, OBJ)
    seedRect(base)
    hydrateScene3dFromDocument()

    await commitChanges({ changes: [mod('node', RECT, { x: 42 })], saveUndo: false })

    expect(isScene3D(RECT)).toBe(true)
    expect(scene3dProxy.scenes.get(RECT)).toEqual(base)
  })

  it('a delete drops the scene', async () => {
    seedRect(sceneWithObject(RECT, OBJ))
    hydrateScene3dFromDocument()
    expect(isScene3D(RECT)).toBe(true)

    await commitChanges({ changes: [del('node', RECT)], saveUndo: false })

    expect(isScene3D(RECT)).toBe(false)
    expect(scene3dProxy.scenes.has(RECT)).toBe(false)
  })

  it('hydrateScene3dFromDocument seeds from nodes and clears when absent', () => {
    seedRect(sceneWithObject(RECT, OBJ))
    scene3dProxy.scenes.clear()

    hydrateScene3dFromDocument()
    expect(scene3dProxy.scenes.has(RECT)).toBe(true)

    seedRect() // same node, no scene3d
    hydrateScene3dFromDocument()
    expect(scene3dProxy.scenes.size).toBe(0)
  })
})
