/**
 * Capability layer — the single read/write surface over the live document.
 *
 * One set of functions for perceiving the page (nodes, selection, current IR) and
 * acting on it (commit an IR edit). Today the Build-mode chat gathers context with
 * these before calling a ConversationSession; later the MCP server will expose the
 * same functions as tools to a user-driven `claude`. Keeping them here means both
 * consumers read/write the document the same way, and the docProxy munging lives in
 * exactly one place.
 *
 * These are IMPERATIVE reads of the valtio proxy — call them from event handlers,
 * not during React render (use useSnapshot for reactive render reads).
 */

import { docProxy, getActiveOrSinglePageId } from '../../store/doc-proxy'
import type { IndexedShape } from '../../../worker/types'
import type { PageInteractions } from '../ir'
import { emptyPageInteractions } from '../ir'
import { commitInteractions as commitIR, currentInteractions } from '../document/commit-interactions'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'

export interface CapNode {
  id: string
  name?: string
  type?: string
}

/** Resolve which page to act on: explicit id, the current page, or the only page. */
export function getActivePageId(pid?: string | null): string | null {
  return pid ?? docProxy.currentPageId ?? getActiveOrSinglePageId()
}

/** All authorable nodes on the page (objects minus the canvas root). */
export function getNodes(pid?: string | null): CapNode[] {
  const id = getActivePageId(pid)
  const page = id ? docProxy.pageMap.get(id) : undefined
  if (!page) return []
  return (Object.values(page.objects) as IndexedShape[])
    .filter((o) => o.id !== ROOT_UUID)
    .map((o) => ({ id: o.id, name: o.name, type: (o as { type?: string }).type }))
}

/** The currently selected nodes (a subset of getNodes). */
export function getSelection(pid?: string | null): CapNode[] {
  const byId = new Map(getNodes(pid).map((n) => [n.id, n]))
  return Array.from(docProxy.selectedIds)
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
