/**
 * Subscriber that refreshes the selection overlay when a commit touches a
 * selected shape, and prunes selected ids the commit deleted. Registered
 * AFTER `renderer-sync` so WASM already holds the new geometry.
 */
import type { ChangesAppliedEvent } from '../../doc/commit'
import { getSelectedIdsSet, setSelectedIds } from './document-selection'
import { useWorkspaceStore } from './workspace-store'
import { querySelectionRect, wasmSelectionRect } from '../signals/selection'

export function selectionSyncHandler(event: ChangesAppliedEvent): void {
  if (event.ignoreRendererSync) return
  const selected = getSelectedIdsSet()
  if (selected.size === 0) return
  const renderer = useWorkspaceStore.getState().renderer
  if (!renderer) return

  let removed = false
  let touched = false
  for (const a of event.applied) {
    if (a.change.kind !== 'node') continue
    const id = a.change.op === 'add' ? a.change.record.id : a.change.id
    if (!selected.has(id)) continue
    touched = true
    if (!a.after) {
      selected.delete(id)
      removed = true
    }
  }
  if (removed) {
    setSelectedIds(selected)
    return
  }
  if (!touched) return
  wasmSelectionRect.value = querySelectionRect(renderer, selected)
}
