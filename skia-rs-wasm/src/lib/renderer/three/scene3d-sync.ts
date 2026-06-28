/**
 * scene3d-sync — reconcile `scene3dProxy` from the document.
 *
 * `node.scene3d` is the source of truth (durable, undoable). This handler runs as
 * a `onChangesApplied` subscriber (registered in store/commit.ts) on EVERY commit,
 * including undo/redo — they re-commit through the same pipeline — so the proxy
 * (the overlay/inspector read-cache) always tracks the document in both directions:
 *
 *   - add-obj carrying `scene3d`     → upsert the entry
 *   - mod-obj assigning `scene3d`    → upsert the new entry (undo/redo of 3D edits)
 *   - del-obj                        → drop the entry + dispose its three instance
 *
 * The handler never emits changes, so there's no commit re-entrancy.
 */

import type { Change } from 'penpot-exporter/types'
import type { ChangesAppliedEvent } from '../../changes/change-emitter'
import type { IndexedPage, IndexedShape } from '../../worker/types'
import { docProxy } from '../store/doc-proxy'
import { scene3dProxy, remove3DObject, type Scene3DEntry } from './scene3d-store'

/**
 * Detached plain clone of an entry. `node.scene3d` is read from the valtio
 * document proxy, and `structuredClone` throws DataCloneError on a Proxy — but
 * Scene3DEntry is pure JSON, so a JSON round-trip clones it safely whether the
 * source is a proxy or already plain.
 */
function clonePlain(entry: Scene3DEntry): Scene3DEntry {
  return JSON.parse(JSON.stringify(entry)) as Scene3DEntry
}

/** Whether a mod-obj's operations write the `scene3d` attribute. */
function modTouchesScene3d(change: Extract<Change, { type: 'mod-obj' }>): boolean {
  type Op = { type: string; value?: Record<string, unknown>; attr?: string }
  return (
    change.operations?.some(
      (op: Op) =>
        (op.type === 'assign' && !!op.value && 'scene3d' in op.value) ||
        (op.type === 'set' && op.attr === 'scene3d'),
    ) ?? false
  )
}

/** Node ids whose 3D state this change may have altered. */
function idsToReconcile(change: Change): string[] {
  switch (change.type) {
    case 'add-obj':
    case 'del-obj':
      return [change.id]
    case 'mod-obj':
      return modTouchesScene3d(change) ? [change.id] : []
    default:
      return []
  }
}

/** Bring `scene3dProxy` into line with `page.objects[id].scene3d`. */
function reconcile(id: string, page: IndexedPage): void {
  const node = page.objects[id] as IndexedShape | undefined
  const entry = node?.scene3d
  if (entry) {
    scene3dProxy.objects.set(id, clonePlain(entry))
  } else if (scene3dProxy.objects.has(id)) {
    // Node deleted (or its 3D spec removed) — drop the entry and free the GPU instance.
    remove3DObject(id)
  }
}

export function scene3dSyncHandler(event: ChangesAppliedEvent): void {
  for (const page of event.pages) {
    const ids = new Set<string>()
    for (const ch of page.changes) for (const id of idsToReconcile(ch)) ids.add(id)
    for (const id of ids) reconcile(id, page.updatedPage)
  }
}

/**
 * Rebuild `scene3dProxy` from the whole document. Called on document load / page
 * switch: disposes any prior three instances, then re-seeds from every `scene3d`
 * found on a node. A no-op on a blank document; lights up once persistence/import
 * brings 3D-bearing nodes back.
 */
export function hydrateScene3dFromDocument(): void {
  for (const id of Array.from(scene3dProxy.objects.keys())) remove3DObject(id)
  for (const page of docProxy.pageMap.values()) {
    for (const node of Object.values(page.objects)) {
      const entry = (node as IndexedShape).scene3d
      if (entry) scene3dProxy.objects.set(node.id, clonePlain(entry))
    }
  }
  scene3dProxy.selectedId = null
  scene3dProxy.editing = false
}
