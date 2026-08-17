/**
 * deleteSelectedNodes — remove the current selection from the document, undoable.
 *
 * `del-obj` cascades on the worker (it removes the node + all descendants and cleans
 * the parent's `shapes`), so the undo vector re-adds each deleted subtree PARENT-FIRST
 * via `add-obj`, restoring every node's parent / frame / sibling index. Bound to
 * Backspace/Delete in idle selection; path- and text-editing handle their own deletion,
 * and typing is skipped via the binding's `notInInput` guard.
 */

import type { Change } from 'penpot-exporter/types'
import { commitChanges } from '../store/commit'
import { getActiveOrSinglePageId, getPage } from '../store/doc-proxy'
import { getSelectedIdsSet, setSelectedIds } from '../store/document-selection'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'

export async function deleteSelectedNodes(): Promise<void> {
  const pageId = getActiveOrSinglePageId()
  if (!pageId) return
  const page = getPage(pageId)
  if (!page) return

  const selected = [...getSelectedIdsSet()].filter((id) => id !== ROOT_UUID && page.objects[id])
  if (selected.length === 0) return

  const redoChanges: Change[] = []
  const undoChanges: Change[] = []
  const seen = new Set<string>()

  // Re-add order is pre-order (parent before children) so each child's `add-obj` lands
  // in an already-restored parent; `index` is the node's slot in its parent's `shapes`.
  const collectSubtree = (id: string): void => {
    if (seen.has(id)) return
    const node = page.objects[id]
    if (!node) return
    seen.add(id)
    const parentId = node.parentId ?? node.frameId ?? ROOT_UUID
    const index = page.objects[parentId]?.shapes?.indexOf(id) ?? 0
    undoChanges.push({
      type: 'add-obj',
      id,
      obj: node,
      frameId: node.frameId ?? parentId,
      parentId,
      index,
      pageId,
    } as unknown as Change)
    for (const childId of node.shapes ?? []) collectSubtree(childId)
  }

  for (const id of selected) {
    redoChanges.push({ type: 'del-obj', id, pageId } as unknown as Change)
    collectSubtree(id)
  }

  await commitChanges({ redoChanges, undoChanges, saveUndo: true })
  setSelectedIds(new Set())
}
