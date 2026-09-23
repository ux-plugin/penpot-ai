/**
 * Records out, exporter document in: the inverse of `import.ts`. Also the
 * `pageObjects` view — a page's nodes as an id map with child lists and the
 * synthetic root — for the tree walkers (codegen, preview, hit-test, WASM
 * init) that want a whole page at once. Both are O(page) materialisations,
 * built on demand, never stored.
 */
import type { PenpotDocument, PenpotNode, PenpotPage } from 'penpot-exporter/types'
import { children, descendants } from './derived'
import { ROOT, type NodeId, type PageId, type ParentKey } from './ids'
import { meta } from './meta'
import type { Node, Page } from './schema'
import { get, records } from './store'

/** A node as the tree walkers see it: with its child list. */
export type TreeNode = Node & { shapes?: NodeId[] }

export type PageObjects = Record<NodeId, TreeNode>

function withShapes(n: Node): TreeNode {
  const kids = children(n.id)
  return kids.length ? { ...n, shapes: [...kids] } : (n as TreeNode)
}

/** The synthetic root frame the renderer needs. Not a record. */
export function rootFrame(page: Page): TreeNode {
  return {
    id: ROOT,
    type: 'frame',
    name: page.name ?? 'Root',
    page: page.id,
    order: '',
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    frameId: ROOT,
    shapes: [...children(page.id)],
  } as unknown as TreeNode
}

/** Every node of `page` by id, plus the root. `frameId` of top-level nodes is `ROOT`. */
export function pageObjects(pageId: PageId): PageObjects {
  const page = get('page', pageId)
  const out: PageObjects = {}
  if (!page) return out
  out[ROOT] = rootFrame(page)
  const stack = [...children(pageId)].reverse()
  while (stack.length) {
    const id = stack.pop()!
    const n = get('node', id)
    if (!n) continue
    out[id] = toWasmNode(withShapes(n))
    const kids = children(id)
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
  }
  return out
}

/** A node as WASM and the hit index read it: the page is the root frame. */
export function toWasmNode<T extends { parentId?: string; frameId?: string }>(n: T): T {
  if (n.parentId && n.frameId) return n
  return { ...n, parentId: n.parentId ?? ROOT, frameId: n.frameId ?? ROOT }
}

export interface DepthNode {
  node: Node
  depth: number
}

/** A page's nodes depth first in sibling order, top level at depth 0. */
export function treeOf(pageId: PageId): DepthNode[] {
  const out: DepthNode[] = []
  const walk = (key: ParentKey, depth: number): void => {
    for (const id of children(key)) {
      const node = get('node', id)
      if (!node) continue
      out.push({ node, depth })
      walk(id, depth + 1)
    }
  }
  walk(pageId, 0)
  return out
}

/** Every node of `pageId`, parents before children. From the child index, no scan. */
export function nodesOfPage(pageId: PageId): Node[] {
  const out: Node[] = []
  for (const id of descendants(pageId)) {
    const n = get('node', id)
    if (n) out.push(n)
  }
  return out
}

function toExporterNode(n: Node): PenpotNode {
  const { page: _p, order: _o, ...rest } = n
  const kids = children(n.id).map((id) => get('node', id)).filter((k): k is Node => !!k)
  const node = { ...rest } as PenpotNode & { children?: PenpotNode[] }
  if (kids.length) node.children = kids.map(toExporterNode)
  return node
}

export function exportPage(page: Page): PenpotPage {
  const top = children(page.id).map((id) => get('node', id)).filter((k): k is Node => !!k)
  const root = { ...rootFrame(page), children: [] } as unknown as PenpotNode
  delete (root as { shapes?: unknown }).shapes
  return {
    id: page.id,
    name: page.name ?? 'Page',
    background: page.background,
    children: [root, ...top.map(toExporterNode)],
    interactions: page.interactions,
  } as PenpotPage
}

export function pagesInOrder(): Page[] {
  return [...records('page')].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
}

export function exportDocument(): PenpotDocument | null {
  const m = meta.peek()
  if (!m) return null
  return { ...m, children: pagesInOrder().map(exportPage) } as PenpotDocument
}
