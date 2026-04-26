/**
 * Subscriber that pushes committed changes to WASM.
 *
 * Receives a `ChangesAppliedEvent` from `change-emitter`, walks the per-page
 * payload, and calls `renderer.addShape` / `renderer.updateShape` /
 * `renderer.updateParentChildren` for each affected id. Was previously inlined
 * inside `commitChanges` as `syncRendererAfterUpdate`; relocated here so the
 * commit step doesn't own renderer concerns.
 *
 * Also exports `syncRendererAfterUpdate` for the page-metadata path
 * (`commit-page-properties.ts`), which doesn't go through the change-emitter.
 */

import type { IndexedPage, IndexedNode } from '../../worker/types'
import type { Change } from 'penpot-exporter/types'
import type {
  ChangesAppliedEvent,
  ChangesAppliedPagePayload,
} from '../../changes/change-emitter'
import { useWorkspaceStore } from './workspace-store'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'

interface RendererLike {
  isInitialized(): boolean
  addShape(node: IndexedNode): Promise<void>
  updateShape(node: IndexedNode, changedKeys?: ReadonlySet<string>): Promise<void>
  updateParentChildren(parentId: string, childIds: string[]): void
}

/**
 * Build the union of `assign` keys across every mod-obj in `changes` for a
 * specific shape id, plus `parentId`/`frameId` if a `mov-objects` reparented
 * the shape (so `setParentId` / layout block re-fires correctly). Returns
 * `undefined` when the shape needs a full push (any non-assign mod-obj op,
 * or the shape isn't in `changes` at all).
 *
 * The renderer-sync subscriber uses this to drive `setObject`'s partial-aware
 * mode — only the primitives whose keys are in the set get pushed to WASM,
 * skipping the layout block on transform-only edits.
 */
function changedKeysFor(
  id: string,
  changes: Change[],
): ReadonlySet<string> | undefined {
  const keys = new Set<string>()
  let touched = false
  for (const c of changes) {
    if (c.type === 'mov-objects') {
      const mov = c as { shapes: readonly string[] }
      if (mov.shapes.includes(id)) {
        // Reparent: docProxy's `processMovObjects` updates the shape's
        // parentId AND frameId. WASM needs both re-pushed so its parent /
        // layout-frame caches don't go stale and orphan the shape under its
        // old parent.
        keys.add('parentId')
        keys.add('frameId')
        touched = true
      }
      continue
    }
    const cId = (c as { id?: string }).id
    if (cId !== id) continue
    if (c.type !== 'mod-obj') return undefined
    touched = true
    const ops = (c as { operations?: Array<{ type: string; value?: Record<string, unknown> }> }).operations ?? []
    for (const op of ops) {
      if (op.type === 'assign' && op.value) {
        for (const k of Object.keys(op.value)) keys.add(k)
      } else {
        // Non-assign op (set, set-touched, …) — fall back to a full push to
        // be safe; partial-awareness only knows about assign keys today.
        return undefined
      }
    }
  }
  if (!touched) return undefined
  return keys
}

function getRootFrameId(page: IndexedPage): string | undefined {
  const root = Object.values(page.objects).find((o) => o.parentId == null)
  return root?.id
}

function getRootFrameChildIds(page: IndexedPage): string[] {
  const root = Object.values(page.objects).find((o) => o.parentId == null)
  return root?.shapes ?? []
}

/**
 * Walk the diff between `oldPage` and `updatedPage`, calling renderer ops for
 * added / deleted / changed ids. Pure given the renderer (no docProxy reads).
 *
 * `changes`, when provided, is forwarded into per-shape `updateShape` calls so
 * `setObject` can run in partial-aware mode (skipping unrelated blocks). When
 * absent, every shape is pushed in full — used by `commitPageUpdate` which
 * doesn't go through the Change[] pipeline.
 *
 * Exported because `commitPageUpdate` (page-metadata path) calls it directly.
 */
export async function syncRendererAfterUpdate(
  renderer: RendererLike,
  oldPage: IndexedPage | undefined,
  updatedPage: IndexedPage,
  modifiedIds?: Set<string>,
  changes?: Change[],
): Promise<void> {
  if (!renderer.isInitialized()) return
  const oldObjects = oldPage?.objects ?? {}
  const newObjects = updatedPage.objects
  const oldIds = new Set(Object.keys(oldObjects))
  const newIds = new Set(Object.keys(newObjects))
  const added = [...newIds].filter((id) => !oldIds.has(id))
  const deleted = [...oldIds].filter((id) => !newIds.has(id))
  const rootId = getRootFrameId(updatedPage) ?? ROOT_UUID
  const childIds = getRootFrameChildIds(updatedPage)

  if (added.length > 0) {
    for (const id of added) {
      const node = newObjects[id]
      if (node) await renderer.addShape(node)
    }
    renderer.updateParentChildren(rootId, childIds)
    const subParentsToUpdate = new Set<string>()
    for (const id of added) {
      const node = newObjects[id]
      if (node?.parentId && node.parentId !== rootId) {
        subParentsToUpdate.add(node.parentId)
      }
    }
    for (const parentId of subParentsToUpdate) {
      const parentNode = newObjects[parentId]
      const parentShapes = (parentNode as { shapes?: string[] })?.shapes
      if (parentShapes) {
        renderer.updateParentChildren(parentId, parentShapes)
      }
    }
  } else if (deleted.length > 0) {
    renderer.updateParentChildren(rootId, childIds)
  } else {
    // When we know which shapes were touched by the changes, only diff those
    // instead of JSON-stringifying every object on the page.
    const idsToCheck = modifiedIds && modifiedIds.size > 0 ? modifiedIds : newIds
    const changed = [...idsToCheck].filter((id) => {
      const oldNode = oldObjects[id]
      const newNode = newObjects[id]
      return oldNode && newNode && JSON.stringify(oldNode) !== JSON.stringify(newNode)
    })
    for (const id of changed) {
      const node = newObjects[id]
      if (!node) continue
      const keys = changes ? changedKeysFor(id, changes) : undefined
      await renderer.updateShape(node, keys)
    }
  }
}

/** Same id-collection logic that previously lived inline in `applyChangesLocally`. */
function collectModifiedIds(
  changes: Change[],
  oldPage: IndexedPage | undefined,
): Set<string> {
  const modifiedIds = new Set<string>()
  for (const c of changes) {
    const id = (c as { id?: string }).id
    if (id) modifiedIds.add(id)
    if (c.type === 'mov-objects') {
      const mov = c as { parentId: string; shapes: readonly string[] }
      modifiedIds.add(mov.parentId)
      for (const sid of mov.shapes) {
        modifiedIds.add(sid)
        const oldShape = oldPage?.objects[sid]
        const oldParent = (oldShape as { parentId?: string } | undefined)?.parentId
        if (oldParent) modifiedIds.add(oldParent)
      }
    }
  }
  return modifiedIds
}

async function handlePagePayload(
  renderer: RendererLike,
  page: ChangesAppliedPagePayload,
): Promise<void> {
  const modifiedIds = collectModifiedIds(page.changes, page.oldPage)
  await syncRendererAfterUpdate(renderer, page.oldPage, page.updatedPage, modifiedIds, page.changes)
}

export async function rendererSyncHandler(event: ChangesAppliedEvent): Promise<void> {
  if (event.ignoreRendererSync) return
  const { renderer } = useWorkspaceStore.getState()
  if (!renderer) return
  for (const page of event.pages) {
    await handlePagePayload(renderer, page)
  }
}
