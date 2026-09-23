import { z } from 'zod'
import type { PenpotNode } from 'penpot-exporter/types'
import type { Scene3DDocument } from '../../renderer/three/scene3d-store'
import type { NodeId, PageId } from '../ids'
import { ref, refs } from './ref'

/**
 * A node: the exporter's shape fields (values, no identity inside) plus the
 * tree. The tree is `parentId` and `order`; a child list is never stored.
 *
 * - `page`: owner. Deleting the page deletes the node.
 * - `parentId`: owner, or absent for a top-level node. Deleting the parent
 *   deletes the node.
 * - `frameId`: nearest frame ancestor, or absent when that is the page. Read
 *   by the renderer and the hit index; maintained by the tree builder.
 * - `shapeRef`: in a component copy, the node of the main it mirrors.
 * - `views`, `activeView`: a slot's candidate view frames and the one shown.
 */
export const NodeSchema = z
  .object({
    id: z.string(),
    page: ref('page', 'cascade'),
    parentId: ref('node', 'cascade').optional(),
    frameId: ref('node').optional(),
    shapeRef: ref('node').optional(),
    views: refs('node').optional(),
    activeView: ref('node').optional(),
    order: z.string(),
    type: z.string(),
  })
  .loose()

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** The exporter's shape fields without the tree it carries (`shapes`, `children`): children come from `childrenOf`. */
export type ShapeFields = DistributiveOmit<PenpotNode, 'shapes' | 'children'>

export type Node = ShapeFields & {
  page: PageId
  parentId?: NodeId
  frameId?: NodeId
  order: string
  scene3d?: Scene3DDocument
}
