/**
 * Subscriber that refreshes the selection overlay when a commit touches an
 * already-selected shape. Without this, undo/redo (and any other
 * non-gesture commit affecting a selected shape's geometry) leaves the
 * cyan overlay stuck at its pre-commit position.
 *
 * Registers AFTER `renderer-sync` so WASM has already absorbed the new
 * shape state before we query its selection rect.
 */

import type { Change } from 'penpot-exporter/types'
import type { ChangesAppliedEvent } from '../../changes/change-emitter'
import { docProxy } from './doc-proxy'
import { setSelectedIds } from './document-selection'
import { useWorkspaceStore } from './workspace-store'
import { querySelectionRect, wasmSelectionRect } from '../signals/selection'

function commitTouchesAnyId(changes: Change[], ids: ReadonlySet<string>): boolean {
  for (const c of changes) {
    const cId = (c as { id?: string }).id
    if (cId && ids.has(cId)) return true
    if (c.type === 'mov-objects') {
      const mov = c as { shapes: readonly string[] }
      for (const sid of mov.shapes) if (ids.has(sid)) return true
    }
  }
  return false
}

export function selectionSyncHandler(event: ChangesAppliedEvent): void {
  if (event.ignoreRendererSync) return
  if (docProxy.selectedIds.size === 0) return
  const renderer = useWorkspaceStore.getState().renderer
  if (!renderer) return
  // Snapshot the proxySet to a plain Set — small, allocates once per commit
  // when something is selected, gives us a clean ReadonlySet shape.
  const selected = new Set<string>(docProxy.selectedIds)

  // Drop any selected id whose shape this commit removed (e.g. undoing a
  // creation deletes the shape). Without this its overlay box/handles linger,
  // and querying the dead id yields a stale rect.
  let removedSelected = false
  for (const page of event.pages) {
    const oldObjects = page.oldPage?.objects
    if (!oldObjects) continue
    const newObjects = page.updatedPage.objects
    for (const id of selected) {
      if (oldObjects[id] && !newObjects[id]) {
        selected.delete(id)
        removedSelected = true
      }
    }
  }
  if (removedSelected) {
    // Re-apply through the canonical setter — it prunes the selection AND
    // refreshes the overlay rect (null when the selection is now empty), so the
    // dead shape's box and handles disappear.
    setSelectedIds(selected)
    return
  }

  // Iterate per-page changes; if any touches a selected id, the selection's
  // geometry has changed and the overlay rect needs to be re-queried.
  let touched = false
  for (const page of event.pages) {
    if (commitTouchesAnyId(page.changes, selected)) {
      touched = true
      break
    }
  }
  if (!touched) return
  wasmSelectionRect.value = querySelectionRect(renderer, selected)
}
