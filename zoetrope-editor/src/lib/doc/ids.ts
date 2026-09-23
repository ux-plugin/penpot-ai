export type PageId = string
export type NodeId = string

/**
 * The nil UUID. The WASM renderer needs a root frame with this id; the
 * document does not store one. A node with no `parentId` is top-level on its
 * page, and the renderer boundary supplies the root.
 */
export const ROOT: NodeId = '00000000-0000-0000-0000-000000000000'

/** The key `childrenOf` uses: a node id, or a page id for that page's top level. */
export type ParentKey = NodeId | PageId
