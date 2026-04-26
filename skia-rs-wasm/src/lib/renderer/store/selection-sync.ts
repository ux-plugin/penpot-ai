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
