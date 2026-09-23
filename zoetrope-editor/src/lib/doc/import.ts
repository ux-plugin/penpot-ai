/**
 * The door: an exporter document in, records out. The nil-UUID root frame is
 * not a record; its children are the page's top level.
 */
import type { PenpotDocument, PenpotNode, PenpotPage } from 'penpot-exporter/types'
import { applyGeometryDefaults } from '@zoetrope-editor/common/shape-defaults'
import type { AnyPageInteractions } from '../renderer/interactions/ir'
import { upgradePageInteractions } from '../renderer/interactions/upgrade'
import { emptyTokensLib } from '../tokens/types'
import { ROOT, type NodeId, type PageId } from './ids'
import type { DocumentMeta } from './meta'
import { initialOrders } from './order'
import type { Node, Page } from './schema'

export interface Imported {
  meta: DocumentMeta
  pages: Page[]
  nodes: Node[]
}

/** A UUID with garbage appended (an old concatenation bug) truncated to 36 chars. */
function normalizeId(id: string): string {
  if (!id || id.length <= 36) return id
  const p = id.slice(0, 36)
  return p[8] === '-' && p[13] === '-' && p[18] === '-' && p[23] === '-' ? p : id
}

function importNodes(
  page: PageId,
  shapes: readonly PenpotNode[],
  parentId: NodeId | undefined,
  frameId: NodeId | undefined,
  out: Node[],
): void {
  const orders = initialOrders(shapes.length)
  shapes.forEach((shape, i) => {
    const id = normalizeId(shape.id)
    const { shapes: _s, children, ...rest } = shape as PenpotNode & { children?: PenpotNode[]; shapes?: unknown }
    const node = {
      ...applyGeometryDefaults(rest as PenpotNode),
      id,
      page,
      parentId,
      frameId,
      order: orders[i],
    } as Node
    out.push(node)
    if (children?.length) importNodes(page, children, id, shape.type === 'frame' ? id : frameId, out)
  })
}

/**
 * One exporter page as records. A Penpot page lists the nil root first, with
 * the top level as its siblings (flat) or its children (nested); a Figma
 * export has no root at all. Either way the root is dropped.
 */
export function importPage(page: PenpotPage, order: string): { page: Page; nodes: Node[] } {
  const id = page.id ?? crypto.randomUUID()
  const kids = page.children ?? []
  const first = kids[0]
  const hasRoot = first?.id === ROOT
  const rootChildren = hasRoot ? ((first as { children?: PenpotNode[] }).children ?? []) : []
  const topLevel = hasRoot ? [...rootChildren, ...kids.slice(1)] : kids
  const nodes: Node[] = []
  importNodes(id, topLevel, undefined, undefined, nodes)
  const stored = (page as { interactions?: AnyPageInteractions }).interactions
  return {
    page: {
      id,
      name: page.name,
      background: page.background,
      order,
      interactions: stored ? upgradePageInteractions(stored).ir : undefined,
    },
    nodes,
  }
}

export function importDocument(doc: PenpotDocument): Imported {
  const { children, ...rest } = doc
  const meta = rest as DocumentMeta
  const pages: Page[] = []
  const nodes: Node[] = []
  const orders = initialOrders(children?.length ?? 0)
  const stores = [...(meta.stores ?? [])]
  ;(children ?? []).forEach((p, i) => {
    const stored = (p as { interactions?: AnyPageInteractions }).interactions
    if (stored) for (const s of upgradePageInteractions(stored).stores) if (!stores.some((x) => x.id === s.id)) stores.push(s)
    const r = importPage(p, orders[i])
    pages.push(r.page)
    nodes.push(...r.nodes)
  })
  meta.stores = stores
  if (!Array.isArray((meta.tokens as { sets?: unknown } | undefined)?.sets)) meta.tokens = emptyTokensLib()
  return { meta, pages, nodes }
}
