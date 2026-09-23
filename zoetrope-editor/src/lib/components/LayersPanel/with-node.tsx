import type { ReactNode } from 'react'
import { useNode, type Node } from '../../doc'

/**
 * Renders `children` with the node `id`, subscribed to that node only: a
 * rename re-renders one row, not the tree. Renders nothing for a missing node.
 */
export function WithNode({ id, children }: { id: string; children: (node: Node) => ReactNode }) {
  const node = useNode(id)
  return node ? <>{children(node)}</> : null
}
