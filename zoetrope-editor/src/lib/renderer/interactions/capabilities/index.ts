/**
 * Capability layer — the single read/write surface over the live document.
 *
 * One set of functions for perceiving the page (nodes, selection, current IR) and
 * acting on it (commit an IR edit). Today the Build-mode chat gathers context with
 * these before calling a ConversationSession; later the MCP server will expose the
 * same functions as tools to a user-driven `claude`. Keeping them here means both
 * consumers read/write the document the same way.
 *
 * These are IMPERATIVE reads — call them from event handlers, not during React
 * render (use the doc hooks for reactive render reads).
 */

import { getActiveOrSinglePageId, treeOf } from '../../../doc'
import { getSelectedIdsSet } from '../../store/document-selection'
import type { PageInteractions } from '../ir'
import { emptyPageInteractions } from '../ir'
import { commitInteractions as commitIR, currentInteractions } from '../document/commit-interactions'

export interface CapNode {
  id: string
  name?: string
  type?: string
}

/** Resolve which page to act on: explicit id, the current page, or the only page. */
export function getActivePageId(pid?: string | null): string | null {
  return pid ?? getActiveOrSinglePageId()
}

/** All authorable nodes on the page, in tree order. */
export function getNodes(pid?: string | null): CapNode[] {
  const id = getActivePageId(pid)
  if (!id) return []
  return treeOf(id).map(({ node }) => ({ id: node.id, name: node.name, type: node.type }))
}

/** The currently selected nodes (a subset of getNodes). */
export function getSelection(pid?: string | null): CapNode[] {
  const byId = new Map(getNodes(pid).map((n) => [n.id, n]))
  return Array.from(getSelectedIdsSet())
    .map((sid) => byId.get(sid))
    .filter((n): n is CapNode => Boolean(n))
}

/** The page's current interactions IR (empty if none authored yet). */
export function getInteractions(pid?: string | null): PageInteractions {
  const id = getActivePageId(pid)
  return (id ? currentInteractions(id) : undefined) ?? emptyPageInteractions()
}

/** Commit an interactions IR edit to the page (updates inspector + live preview). */
export function commitInteractions(pid: string, ir: PageInteractions): void {
  void commitIR(pid, ir)
}
