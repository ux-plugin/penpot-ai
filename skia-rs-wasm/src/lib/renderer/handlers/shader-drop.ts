/**
 * Drag-and-drop a shader preset from the Assets panel onto the canvas: drop onto
 * a shape and its material is applied; drop onto empty space and a new rectangle
 * is created with the shader. The click-to-apply path (apply to the current
 * selection) lives in the Assets panel; this is the pointer half of the same
 * apply model.
 *
 * All renderer-internal — the same hit-test the click-selection uses
 * (`queryNodesAtPoint`/`pickTopmostNode`) and the same `add-obj` creation the
 * draw tool uses, so a dropped shape behaves like any other.
 */

import type { AddObjChange, DelObjChange, PenpotNode } from 'penpot-exporter/types'
import type { Material } from '../api/material'
import { SHADER_PRESETS } from '../shader-lang/presets'
import { viewport } from '../signals/pointer'
import { useWorkspaceStore } from '../store/workspace-store'
import { getActiveOrSinglePageId, getPage } from '../store/doc-proxy'
import { setSelectedIds } from '../store/document-selection'
import { screenToWorld } from '../viewport'
import { queryNodesAtPoint, pickTopmostNode } from '../selection/query-at-point'
import {
  commitNodePartialUpdate,
  getCommittedNodeOnActivePage,
} from '../properties/commit-node-properties'
import { createRect } from '../node-factory'
import { applyChanges } from '../../page-crud'

/** DataTransfer MIME type carrying the dragged preset's id. */
export const SHADER_PRESET_DND_TYPE = 'application/x-shader-preset-id'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'
/** Default size of a rectangle created by dropping a shader on empty canvas. */
const NEW_SHAPE_W = 240
const NEW_SHAPE_H = 160

/**
 * Apply `material` at a surface-relative point: to the topmost shape under it,
 * or — on empty canvas — to a new rectangle centered there. `screenX`/`screenY`
 * are relative to the pointer-sink surface (client coords minus its rect).
 */
export async function dropShaderAtPoint(
  material: Material,
  screenX: number,
  screenY: number,
): Promise<void> {
  const vp = viewport.value
  const pageId = getActiveOrSinglePageId()
  const { workerClient } = useWorkspaceStore.getState()
  if (!vp || !pageId || !workerClient) return

  const ids = await queryNodesAtPoint(workerClient, pageId, vp, screenX, screenY)
  const page = getPage(pageId)
  const topId = pickTopmostNode(page, ids)

  if (topId && topId !== ROOT_UUID) {
    const before = getCommittedNodeOnActivePage(topId)
    if (before) {
      await commitNodePartialUpdate(topId, before, { material } as Partial<PenpotNode>, pageId)
    }
    setSelectedIds(new Set([topId]))
    return
  }

  // Empty canvas → create a rectangle carrying the material, centered on the drop.
  const world = screenToWorld(vp, screenX, screenY)
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

/** Surface `onDragOver`: accept the drop only when a shader preset is being dragged. */
export function onSurfaceShaderDragOver(e: React.DragEvent): void {
  if (e.dataTransfer.types.includes(SHADER_PRESET_DND_TYPE)) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
}

/** Surface `onDrop`: resolve the dragged preset and apply it at the drop point. */
export function onSurfaceShaderDrop(e: React.DragEvent): void {
  const id = e.dataTransfer.getData(SHADER_PRESET_DND_TYPE)
  if (!id) return
  e.preventDefault()
  const preset = SHADER_PRESETS.find((p) => p.id === id)
  if (!preset) return
  const rect = e.currentTarget.getBoundingClientRect()
  void dropShaderAtPoint(preset.material, e.clientX - rect.left, e.clientY - rect.top)
}
