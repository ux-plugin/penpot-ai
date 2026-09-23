/**
 * Pen tool entry (Phase C — one pen). The Pen no longer has its own click-driven
 * drawing session: the first click makes an empty 1-node path and the caller drops
 * into the path editor's Add sub-tool, anchored on that node; every later click is
 * handled by `PathEditorOverlay` (extend / close / drag-handle), exactly like
 * editing an existing path. The old self-contained `handlePenDraw` RxJS session
 * (its own window listeners + `penDrawPreview` signal) is gone.
 */

import { setSelectedIds } from '../store/document-selection'
import { addNode, beginGroup, getActiveOrSinglePageId } from '../../doc'
import { applyChanges } from '../../page-crud'
import { createBezierPath } from '../node-factory'

/** Undo group that bundles a freshly-penned dot with its first edge. */
export const PEN_CREATE_TX = 'pen-path-create'

type Pt = { x: number; y: number }

/**
 * Create an empty 1-node path at `world` and commit it. Returns the new shape id
 * (or null if there's no page). Async because it commits the add first, so the
 * editor finds a committed shape to edit; the caller then sends START_PATH_EDIT +
 * PATH_SET_SUBTOOL('add') + PATH_SET_DRAFT_FROM(0).
 */
export async function createPenStartPath(world: Pt): Promise<string | null> {
  const page = getActiveOrSinglePageId()
  if (!page) return null
  const node = createBezierPath([{ point: { x: world.x, y: world.y } }], {
    strokeColor: '#1E40AF',
    strokeWidth: 2,
  })
  // Open an undo group so this dot bundles with the first edge into ONE
  // undo entry: undoing the first segment removes the whole shape and never lands
  // on a lone 1-node path. `commitVN` closes it after the first edge; abandoning
  // the dot before any edge (`deleteSelfShape`) discards it, leaving no orphan.
  beginGroup(PEN_CREATE_TX)
  await applyChanges([addNode(node, { page })])
  setSelectedIds(new Set([node.id]))
  return node.id
}
