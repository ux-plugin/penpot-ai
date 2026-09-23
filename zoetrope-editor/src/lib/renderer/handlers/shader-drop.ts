/**
 * Applying a shader material by drag from the Assets panel. The pointer-driven
 * drag (see `signals/shader-drag`) resolves its own target as you move, so these
 * helpers take an already-resolved destination: apply to a specific node, or
 * create a new rectangle carrying the shader on empty canvas. Both mirror the
 * draw tool's creation so a dropped shape is undoable like any other.
 */

import type { PenpotNode } from 'penpot-exporter/types'
import type { Material } from '../api/material'
import { viewport } from '../signals/pointer'
import { addNode, getActiveOrSinglePageId, getNode } from '../../doc'
import { setSelectedIds } from '../store/document-selection'
import { screenToWorld } from '../viewport'
import { commitNodePartialUpdate } from '../properties/commit-node-properties'
import { createRect } from '../node-factory'
import { applyChanges } from '../../page-crud'

/** Default size of a rectangle created by dropping a shader on empty canvas. */
const NEW_SHAPE_W = 240
const NEW_SHAPE_H = 160

/** Apply `material` to a specific node — the resolved drag target — and select it. */
export async function applyShaderToNode(material: Material, nodeId: string): Promise<void> {
  const before = getNode(nodeId)
  if (!before) return
  await commitNodePartialUpdate(nodeId, before, { material } as Partial<PenpotNode>)
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
  const page = getActiveOrSinglePageId()
  if (!vp || !page) return
  const world = screenToWorld(vp, screenX, screenY)
  const node = {
    ...createRect({
      x: world.x - NEW_SHAPE_W / 2,
      y: world.y - NEW_SHAPE_H / 2,
      width: NEW_SHAPE_W,
      height: NEW_SHAPE_H,
      fillColor: '#8A8A8A',
    }),
    material,
  } as PenpotNode
  await applyChanges([addNode(node, { page })])
  setSelectedIds(new Set([node.id]))
}
