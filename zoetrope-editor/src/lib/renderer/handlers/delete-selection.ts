/**
 * deleteSelectedNodes — remove the current selection from the document, undoable.
 *
 * `del` cascades to descendants and undo restores them. Bound to
 * Backspace/Delete in idle selection; path- and text-editing handle their own deletion,
 * and typing is skipped via the binding's `notInInput` guard.
 */

import { commitChanges } from '../store/commit'
import { deleteNodes, getNode } from '../../doc'
import { getSelectedIdsSet, setSelectedIds } from '../store/document-selection'

export async function deleteSelectedNodes(): Promise<void> {
  const selected = [...getSelectedIdsSet()].filter((id) => getNode(id))
  if (selected.length === 0) return

  await commitChanges({ changes: deleteNodes(selected), saveUndo: true })
  setSelectedIds(new Set())
}
