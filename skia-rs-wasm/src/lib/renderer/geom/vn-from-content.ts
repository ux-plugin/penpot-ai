/**
 * Read the vector network a path node carries. Extracted from PathEditorOverlay
 * so non-React code (the machine's path-session cleanup) can inspect a path's
 * edges without importing the overlay.
 */

import { getSubpaths } from './subpaths'
import { subpathsToVN, type VectorNetwork } from './vector-network'

export const cloneNet = (vn: VectorNetwork): VectorNetwork => ({
  nodes: vn.nodes.map((n) => ({ x: n.x, y: n.y })),
  edges: vn.edges.map((e) => ({
    a: e.a,
    b: e.b,
    ...(e.ha ? { ha: { x: e.ha.x, y: e.ha.y } } : {}),
    ...(e.hb ? { hb: { x: e.hb.x, y: e.hb.y } } : {}),
  })),
})

/** The network a node carries: explicit `content.network`, else built (with merge,
 *  so coincident endpoints heal into shared nodes) from its sub-paths. */
export function vnFromContent(content: unknown): VectorNetwork {
  const net = (content as { network?: VectorNetwork } | null | undefined)?.network
  if (net && Array.isArray(net.nodes) && net.nodes.length > 0) return cloneNet(net)
  return subpathsToVN(getSubpaths(content as Parameters<typeof getSubpaths>[0]), true)
}
