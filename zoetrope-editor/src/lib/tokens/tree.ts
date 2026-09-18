/**
 * Folder-tree view of the token library. It is a pure *rendering* of the
 * existing model — no schema change: a set is a collection folder, a token is a
 * leaf. Two levels of nesting come for free from the naming convention:
 *   - SET names nest by "/"  ("core/colors" → folder core ▸ set colors)
 *   - TOKEN names nest by "." ("color.bg.default" → group color ▸ bg ▸ default)
 *
 * A path segment that is *also* a real set (e.g. a set literally named "core"
 * plus a set "core/colors") upgrades the folder node to a set node in place.
 */

import type { Token, TokenSet, TokensLib } from './types'

export type TokenTreeNode =
  | { kind: 'folder'; id: string; name: string; children: TokenTreeNode[] }
  | { kind: 'set'; id: string; name: string; set: TokenSet; children: TokenTreeNode[] }
  | { kind: 'group'; id: string; name: string; children: TokenTreeNode[] }
  | { kind: 'token'; id: string; name: string; set: TokenSet; token: Token }

type FolderNode = Extract<TokenTreeNode, { kind: 'folder' }>
type SetNode = Extract<TokenTreeNode, { kind: 'set' }>
type GroupNode = Extract<TokenTreeNode, { kind: 'group' }>

/** Stable id for a token leaf — also the key used by the visibility set. */
export function tokenNodeId(setId: string, tokenId: string): string {
  return `t:${setId}:${tokenId}`
}

/** Tokens of a set, nested by their dot-separated name groups. */
function tokenChildren(set: TokenSet): TokenTreeNode[] {
  const roots: TokenTreeNode[] = []
  for (const token of set.tokens) {
    const parts = token.name.split('.')
    let list = roots
    let path = set.id
    for (let i = 0; i < parts.length - 1; i++) {
      path = `${path}.${parts[i]}`
      const seg = parts[i]
      let group = list.find((n): n is GroupNode => n.kind === 'group' && n.name === seg)
      if (!group) {
        group = { kind: 'group', id: `g:${path}`, name: seg, children: [] }
        list.push(group)
      }
      list = group.children
    }
    list.push({
      kind: 'token',
      id: tokenNodeId(set.id, token.id),
      name: parts[parts.length - 1],
      set,
      token,
    })
  }
  return roots
}

/** Build the set/folder tree (sets nest by "/") with each set's token tree inside. */
export function buildTokenTree(lib: TokensLib | undefined): TokenTreeNode[] {
  const roots: TokenTreeNode[] = []
  for (const set of lib?.sets ?? []) {
    const parts = set.name.split('/')
    let list = roots
    let path = ''
    for (let i = 0; i < parts.length - 1; i++) {
      path = path ? `${path}/${parts[i]}` : parts[i]
      const seg = parts[i]
      let node = list.find(
        (n): n is FolderNode | SetNode => (n.kind === 'folder' || n.kind === 'set') && n.name === seg,
      )
      if (!node) {
        node = { kind: 'folder', id: `f:${path}`, name: seg, children: [] }
        list.push(node)
      }
      list = node.children
    }
    const leaf = parts[parts.length - 1]
    const kids = tokenChildren(set)
    const existing = list.find((n): n is FolderNode => n.kind === 'folder' && n.name === leaf)
    if (existing) {
      // The folder path is also a real set — upgrade it, keep its sub-folders.
      list[list.indexOf(existing)] = {
        kind: 'set',
        id: `s:${set.id}`,
        name: leaf,
        set,
        children: [...existing.children, ...kids],
      }
    } else {
      list.push({ kind: 'set', id: `s:${set.id}`, name: leaf, set, children: kids })
    }
  }
  return roots
}

/** Number of token leaves under a node (inclusive). */
export function countTokenLeaves(node: TokenTreeNode): number {
  if (node.kind === 'token') return 1
  return node.children.reduce((n, c) => n + countTokenLeaves(c), 0)
}

/** Keep only branches that contain a visible token id; drops now-empty folders/sets/groups. */
export function pruneTokenTree(nodes: TokenTreeNode[], visible: Set<string>): TokenTreeNode[] {
  const out: TokenTreeNode[] = []
  for (const n of nodes) {
    if (n.kind === 'token') {
      if (visible.has(n.id)) out.push(n)
    } else {
      const kids = pruneTokenTree(n.children, visible)
      if (kids.length > 0) out.push({ ...n, children: kids })
    }
  }
  return out
}
