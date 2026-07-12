/**
 * Pen tool entry (Phase C — one pen). The Pen no longer has its own click-driven
 * drawing session: the first click makes an empty 1-node path and the caller drops
 * into the path editor's Add sub-tool, anchored on that node; every later click is
 * handled by `PathEditorOverlay` (extend / close / drag-handle), exactly like
 * editing an existing path. The old self-contained `handlePenDraw` RxJS session
 * (its own window listeners + `penDrawPreview` signal) is gone.
 */

import { setSelectedIds } from '../store/document-selection'
import { getActiveOrSinglePageId, getPage } from '../store/doc-proxy'
import { applyChanges } from '../../page-crud'
import { useHistoryStore } from '../../history/history-store'
import { createBezierPath } from '../node-factory'
import type { AddObjChange, DelObjChange } from 'penpot-exporter/types'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'

/** Undo transaction that bundles a freshly-penned dot with its first edge. */
export const PEN_CREATE_TX = 'pen-path-create'

type Pt = { x: number; y: number }

/**
 * Create an empty 1-node path at `world` and commit it. Returns the new shape id
 * (or null if there's no page). Async because it commits the add-obj first, so the
 * editor finds a committed shape to edit; the caller then sends START_PATH_EDIT +
 * PATH_SET_SUBTOOL('add') + PATH_SET_DRAFT_FROM(0).
 */
export async function createPenStartPath(world: Pt): Promise<string | null> {
  const pageId = getActiveOrSinglePageId()
  const page = pageId ? getPage(pageId) : undefined
  if (!pageId || !page) return null
  const root = Object.values(page.objects).find((o) => o.parentId == null)
  const rootId = root?.id ?? ROOT_UUID
  const node = createBezierPath([{ point: { x: world.x, y: world.y } }], {
    parentId: rootId,
    strokeColor: '#1E40AF',
    strokeWidth: 2,
  })
  const change: AddObjChange = {
    type: 'add-obj',
    id: node.id,
    obj: node,
    frameId: rootId,
    parentId: rootId,
    index: root?.shapes?.length ?? 0,
    pageId,
  }
  // Open an undo transaction so this dot bundles with the first edge into ONE
  // undo entry: undoing the first segment removes the whole shape and never lands
  // on a lone 1-node path. `commitVN` closes it after the first edge; abandoning
  // the dot before any edge (`deleteSelfShape`) discards it, leaving no orphan.
  useHistoryStore.getState().beginTransaction(PEN_CREATE_TX)
  const undoChange: DelObjChange = { type: 'del-obj', id: node.id, pageId }
  await applyChanges([change], { undoChanges: [undoChange] })
  setSelectedIds(new Set([node.id]))
  return node.id
}
