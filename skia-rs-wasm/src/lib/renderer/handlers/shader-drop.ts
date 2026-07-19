/**
 * Applying a shader material by drag from the Assets panel. The pointer-driven
 * drag (see `signals/shader-drag`) resolves its own target as you move, so these
 * helpers take an already-resolved destination: apply to a specific node, or
 * create a new rectangle carrying the shader on empty canvas. Both mirror the
 * draw tool's `add-obj` creation so a dropped shape is undoable like any other.
 */

import type { AddObjChange, DelObjChange, PenpotNode } from 'penpot-exporter/types'
import type { Material } from '../api/material'
import { viewport } from '../signals/pointer'
import { getActiveOrSinglePageId, getPage } from '../store/doc-proxy'
import { setSelectedIds } from '../store/document-selection'
import { screenToWorld } from '../viewport'
import {
  commitNodePartialUpdate,
  getCommittedNodeOnActivePage,
} from '../properties/commit-node-properties'
import { createRect } from '../node-factory'
import { applyChanges } from '../../page-crud'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'
/** Default size of a rectangle created by dropping a shader on empty canvas. */
const NEW_SHAPE_W = 240
const NEW_SHAPE_H = 160

/** Apply `material` to a specific node — the resolved drag target — and select it. */
export async function applyShaderToNode(material: Material, nodeId: string): Promise<void> {
  const pageId = getActiveOrSinglePageId()
  if (!pageId || nodeId === ROOT_UUID) return
  const before = getCommittedNodeOnActivePage(nodeId)
  if (!before) return
  await commitNodePartialUpdate(nodeId, before, { material } as Partial<PenpotNode>, pageId)
  setSelectedIds(new Set([nodeId]))
}

/**
 * Create a rectangle carrying `material`, centered on a surface-relative point
 * (drop on empty canvas), and select it.
 */
export async function createRectWithShader(
  material: Material,
  screenX: number,
  screenY: number,
): Promise<void> {
  const vp = viewport.value
  const pageId = getActiveOrSinglePageId()
  if (!vp || !pageId) return
  const world = screenToWorld(vp, screenX, screenY)
  const page = getPage(pageId)
  const root = page ? Object.values(page.objects).find((o) => o.parentId == null) : undefined
  const rootId = root?.id ?? ROOT_UUID
  const node = {
    ...createRect({
      x: world.x - NEW_SHAPE_W / 2,
      y: world.y - NEW_SHAPE_H / 2,
      width: NEW_SHAPE_W,
      height: NEW_SHAPE_H,
      parentId: rootId,
      fillColor: '#8A8A8A',
    }),
    material,
  } as PenpotNode
  const addChange: AddObjChange = {
    type: 'add-obj',
    id: node.id,
    obj: node,
    frameId: rootId,
    parentId: rootId,
    index: root?.shapes?.length ?? 0,
    pageId,
  }
  const undoChange: DelObjChange = { type: 'del-obj', id: node.id, pageId }
  await applyChanges([addChange], { undoChanges: [undoChange] })
  setSelectedIds(new Set([node.id]))
}
