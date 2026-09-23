/**
 * Subscriber that pushes committed node changes to WASM: `addShape` for adds,
 * `updateShape` with the written keys for mods, `updateParentChildren` for
 * every parent whose child list changed.
 */
import type { PenpotNode } from 'penpot-exporter/types'
import type { ChangesAppliedEvent } from '../../doc/commit'
import { children, currentPageId, toWasmNode, ROOT, type Node, type ParentKey } from '../../doc'
import { useWorkspaceStore } from './workspace-store'

interface RendererLike {
  isInitialized(): boolean
  addShape(node: PenpotNode): Promise<void>
  updateShape(node: PenpotNode, changedKeys?: ReadonlySet<string>): Promise<void>
  updateParentChildren(parentId: string, childIds: string[]): void
}

function keyOf(n: Node): ParentKey {
  return n.parentId ?? n.page
}

export async function syncRenderer(renderer: RendererLike, event: ChangesAppliedEvent): Promise<void> {
  if (!renderer.isInitialized()) return
  const pageId = currentPageId.peek()
  if (!pageId) return
  const parents = new Set<ParentKey>()
  const deleted = new Set<string>()
  for (const a of event.applied) if (a.change.kind === 'node' && !a.after) deleted.add(a.change.op === 'del' ? a.change.id : '')

  for (const a of event.applied) {
    if (a.change.kind !== 'node') continue
    const before = a.before as Node | undefined
    const after = a.after as Node | undefined
    const onPage = (after ?? before)?.page === pageId
    if (!onPage) continue
    if (after && !before) {
      await renderer.addShape(toWasmNode(after))
      parents.add(keyOf(after))
    } else if (after && before) {
      const keys = a.change.op === 'mod' ? new Set(Object.keys(a.change.set)) : undefined
      const moved = before.parentId !== after.parentId || before.order !== after.order
      if (moved) {
        keys?.add('parentId')
        keys?.add('frameId')
        parents.add(keyOf(before))
        parents.add(keyOf(after))
      }
      await renderer.updateShape(toWasmNode(after), keys)
    } else if (before) {
      parents.add(keyOf(before))
    }
  }
  for (const key of parents) {
    if (deleted.has(key)) continue
    renderer.updateParentChildren(key === pageId ? ROOT : key, [...children(key)])
  }
}

export async function rendererSyncHandler(event: ChangesAppliedEvent): Promise<void> {
  if (event.ignoreRendererSync) return
  const { renderer } = useWorkspaceStore.getState()
  if (!renderer) return
  await syncRenderer(renderer, event)
}
