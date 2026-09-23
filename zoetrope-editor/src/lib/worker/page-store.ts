/**
 * The hit-index worker's copy of a page: nodes by id with child lists, as
 * the quadtree code reads them. Fed by the same three change ops as the
 * document; updated copy-on-write so the index can diff by reference.
 * The synthetic root frame is present, as WASM and the index expect.
 */
import type { Change, Node, NodeId, PageObjects, TreeNode } from '../doc'
import { ROOT } from '../doc/ids'
import { toWasmNode } from '../doc/export'

export interface WorkerPage {
  id: string
  objects: PageObjects
}

function keyOf(n: { parentId?: string }): NodeId {
  return n.parentId && n.parentId !== ROOT ? n.parentId : ROOT
}

function sortedChildren(objects: PageObjects, key: NodeId): NodeId[] {
  const kids: TreeNode[] = []
  for (const n of Object.values(objects)) if (n.id !== ROOT && keyOf(n) === key) kids.push(n)
  kids.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
  return kids.map((k) => k.id)
}

function setChildren(objects: PageObjects, key: NodeId): void {
  const parent = objects[key]
  if (!parent) return
  const kids = sortedChildren(objects, key)
  objects[key] = { ...parent, shapes: kids.length ? kids : undefined }
}

/** Apply `changes` to `page.objects`, returning the new objects map. Untouched nodes keep identity. */
export function applyToPage(page: WorkerPage, changes: readonly Change[]): PageObjects {
  const objects: PageObjects = { ...page.objects }
  const parents = new Set<NodeId>()
  for (const c of changes) {
    if (c.kind !== 'node') continue
    switch (c.op) {
      case 'add': {
        const rec = c.record as Node
        if (rec.page !== page.id) break
        const prev = objects[rec.id]
        objects[rec.id] = { ...toWasmNode(rec), shapes: prev?.shapes }
        parents.add(keyOf(rec))
        if (prev) parents.add(keyOf(prev))
        break
      }
      case 'del': {
        const prev = objects[c.id]
        if (!prev) break
        delete objects[c.id]
        parents.add(keyOf(prev))
        break
      }
      case 'mod': {
        const prev = objects[c.id]
        if (!prev) break
        const next: Record<string, unknown> = { ...prev }
        for (const [k, v] of Object.entries(c.set)) {
          if (v === undefined) delete next[k]
          else next[k] = v
        }
        const rec = toWasmNode(next as unknown as TreeNode) as TreeNode
        objects[c.id] = rec
        if (prev.parentId !== rec.parentId || prev.order !== rec.order) {
          parents.add(keyOf(prev))
          parents.add(keyOf(rec))
        }
        break
      }
    }
  }
  for (const key of parents) setChildren(objects, key)
  return objects
}
