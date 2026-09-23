/**
 * Tree edits as changes. The tree is `parentId` + `order` on each node;
 * `frameId` is the nearest frame ancestor, kept current here.
 */
import type { PenpotNode } from 'penpot-exporter/types'
import { applyGeometryDefaults } from '@zoetrope-editor/common/shape-defaults'
import { add, del, mod, type Change } from './changes'
import { children, descendants } from './derived'
import { ROOT, type NodeId, type PageId, type ParentKey } from './ids'
import { orderAt, orderBetween } from './order'
import type { Node } from './schema'
import { get } from './store'

export function isFrame(n: Pick<Node, 'type'> | undefined): boolean {
  return n?.type === 'frame'
}

/** The frame a child of `parentId` belongs to; `undefined` when that is the page. */
export function frameFor(parentId: NodeId | undefined): NodeId | undefined {
  if (!parentId) return undefined
  const p = get('node', parentId)
  if (!p) return undefined
  return isFrame(p) ? p.id : p.frameId
}

/** `ROOT` and `undefined` both mean top-level. */
function parentOrTop(parentId: NodeId | null | undefined): NodeId | undefined {
  return parentId && parentId !== ROOT ? parentId : undefined
}

export function parentKey(page: PageId, parentId: NodeId | undefined): ParentKey {
  return parentId ?? page
}

export interface Placement {
  page: PageId
  parentId?: NodeId | null
  /** Position among the parent's children. Appends when absent. */
  index?: number | null
  /** Place right after this sibling. Wins over `index`. */
  after?: NodeId | null
}

function orderFor(place: Placement, excluding: ReadonlySet<NodeId> = new Set()): string {
  const key = parentKey(place.page, parentOrTop(place.parentId))
  const siblings = children(key).filter((id) => !excluding.has(id))
  const orders = siblings.map((id) => get('node', id)?.order ?? '')
  if (place.after) {
    const i = siblings.indexOf(place.after)
    if (i >= 0) return orderBetween(orders[i], orders[i + 1])
  }
  return orderAt(orders, place.index ?? siblings.length)
}

/** Strip what the exporter tree carries but a record does not. */
function stripTree(shape: PenpotNode): Omit<PenpotNode, 'shapes'> {
  const { shapes: _shapes, ...rest } = shape as PenpotNode & { shapes?: unknown; children?: unknown }
  delete (rest as { children?: unknown }).children
  return rest
}

/** The record for `shape` placed at `place`. */
export function placeNode(shape: PenpotNode, place: Placement): Node {
  const parentId = parentOrTop(place.parentId ?? shape.parentId)
  const base = stripTree(applyGeometryDefaults(shape))
  return {
    ...base,
    page: place.page,
    parentId,
    frameId: frameFor(parentId),
    order: orderFor({ ...place, parentId }),
  } as Node
}

/** Add one node. */
export function addNode(shape: PenpotNode, place: Placement): Change {
  return add('node', placeNode(shape, place))
}

/**
 * Add a subtree given as exporter nodes with `children`. The root is placed at
 * `place`; descendants keep their order.
 */
export function addSubtree(shape: PenpotNode, place: Placement): Change[] {
  const out: Change[] = []
  const root = placeNode(shape, place)
  out.push(add('node', root))
  const walk = (parent: Node, kids: PenpotNode[] | undefined): void => {
    if (!kids?.length) return
    const frameId = isFrame(parent) ? parent.id : parent.frameId
    let prev: string | undefined
    for (const kid of kids) {
      const order = orderBetween(prev, undefined)
      prev = order
      const rec = {
        ...stripTree(applyGeometryDefaults(kid)),
        page: place.page,
        parentId: parent.id,
        frameId,
        order,
      } as Node
      out.push(add('node', rec))
      walk(rec, (kid as { children?: PenpotNode[] }).children)
    }
  }
  walk(root, (shape as { children?: PenpotNode[] }).children)
  return out
}

/** Delete nodes. Descendants follow through cascade in `commitChanges`. */
export function deleteNodes(ids: readonly NodeId[]): Change[] {
  return ids.map((id) => del('node', id))
}

/**
 * Move nodes under `parentId` (top level when absent) at `index` / after
 * `after`. Emits a `mod` per moved node and one per descendant whose frame
 * changes.
 */
export function moveNodes(ids: readonly NodeId[], place: Placement): Change[] {
  const out: Change[] = []
  const moving = new Set(ids)
  const parentId = parentOrTop(place.parentId)
  const key = parentKey(place.page, parentId)
  const siblings = children(key).filter((id) => !moving.has(id))
  const orders = siblings.map((id) => get('node', id)?.order ?? '')
  let lo: string | undefined
  let hi: string | undefined
  if (place.after && siblings.includes(place.after)) {
    const i = siblings.indexOf(place.after)
    lo = orders[i]
    hi = orders[i + 1]
  } else {
    const i = Math.max(0, Math.min(place.index ?? siblings.length, siblings.length))
    lo = orders[i - 1]
    hi = orders[i]
  }
  const frameId = frameFor(parentId)
  for (const id of ids) {
    const n = get('node', id)
    if (!n) continue
    const order = orderBetween(lo, hi)
    lo = order
    const set: Partial<Node> = { order }
    if (n.parentId !== parentId) set.parentId = parentId
    if (n.page !== place.page) set.page = place.page
    if (n.frameId !== frameId) set.frameId = frameId
    out.push(mod('node', id, set))
    out.push(...reframe(n, isFrame(n) ? n.id : frameId, place.page))
  }
  return out
}

/** `mod`s that set the frame of every descendant of `n` to what it becomes under `frameId`. */
function reframe(n: Node, frameId: NodeId | undefined, page: PageId): Change[] {
  const out: Change[] = []
  const frameOf = new Map<NodeId, NodeId | undefined>([[n.id, frameId]])
  for (const id of descendants(n.id)) {
    const d = get('node', id)
    if (!d) continue
    const f = frameOf.get(d.parentId!) ?? undefined
    frameOf.set(id, isFrame(d) ? d.id : f)
    const set: Partial<Node> = {}
    if (d.frameId !== f) set.frameId = f
    if (d.page !== page) set.page = page
    if (Object.keys(set).length) out.push(mod('node', id, set))
  }
  return out
}

/** Reorder siblings to `order` (ids, first to last). */
export function reorderChildren(order: readonly NodeId[]): Change[] {
  const out: Change[] = []
  let prev: string | undefined
  for (const id of order) {
    const n = get('node', id)
    if (!n) continue
    if (prev === undefined || n.order > prev) {
      prev = n.order
      continue
    }
    const o = orderBetween(prev, undefined)
    out.push(mod('node', id, { order: o }))
    prev = o
  }
  return out
}

/** Index of `id` among its siblings. */
export function siblingIndex(id: NodeId): number {
  const n = get('node', id)
  if (!n) return -1
  return children(parentKey(n.page, n.parentId)).indexOf(id)
}

/** Nearest ancestors, parent first. */
export function ancestors(id: NodeId): NodeId[] {
  const out: NodeId[] = []
  let cur = get('node', id)?.parentId
  while (cur) {
    out.push(cur)
    cur = get('node', cur)?.parentId
  }
  return out
}
