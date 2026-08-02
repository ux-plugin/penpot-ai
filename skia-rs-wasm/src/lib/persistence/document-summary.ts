/**
 * document-summary — the cheap, listable description of a stored document.
 *
 * The documents home screen renders from these, never from the documents
 * themselves: decoding every stored document just to draw a list would be
 * O(total bytes on disk) for a screen that shows a name and a filmstrip.
 *
 * The summary carries per-page detail rather than two totals, because the list
 * draws one filmstrip cell per page with the page's name under it. Keeping the
 * shape here means the screen can render honestly — right cell count, real
 * captions — before page thumbnails exist.
 *
 * Counts are derived, not tracked. `save` re-derives on every write, so a summary
 * can never drift from the document it describes — the alternative (incrementing
 * counters at every page/board mutation site) has to be correct everywhere.
 */

import type { PenpotDocument, PenpotNode } from 'penpot-exporter/types'

/** The synthetic per-page root frame every page carries; boards are its children.
 *  Mirrors `createNewDocument` in ../page-crud.ts. */
const ROOT_UUID = '00000000-0000-0000-0000-000000000000'

export interface PageSummary {
  id: string
  name: string
  /** Boards on this page — what one filmstrip cell draws. */
  boardCount: number
}

export interface DocumentSummary {
  id: string
  name: string
  pages: PageSummary[]
  createdAt: number
  updatedAt: number
  /** Archived documents stay in the library but out of the default list.
   *  A reversible alternative to deleting. */
  archived?: boolean
  /** The project this document is filed under, or absent for unfiled.
   *  Library organisation, so it lives in the store — never in the document. */
  projectId?: string | null
}

/** A folder in the library. Projects group documents; they hold no content of
 *  their own, which is why they live under their own key rather than inside any
 *  document. */
export interface Project {
  id: string
  name: string
  createdAt: number
}

/** Everything about a summary that comes from the document itself. `id` and
 *  `createdAt` belong to the store, not the document. */
export type DerivedSummary = Pick<DocumentSummary, 'name' | 'pages'>

export const boardCount = (summary: Pick<DocumentSummary, 'pages'>): number =>
  summary.pages.reduce((total, page) => total + page.boardCount, 0)

export const pageCount = (summary: Pick<DocumentSummary, 'pages'>): number => summary.pages.length

/** Boards on one page: the `frame` children of that page's root frame. Anything
 *  unshaped counts as zero rather than throwing — a summary is not worth failing
 *  a save over. */
function countBoards(pageChildren: PenpotNode[] | undefined): number {
  if (!Array.isArray(pageChildren)) return 0
  const root = pageChildren.find((node) => node?.id === ROOT_UUID) ?? pageChildren[0]
  const boards = (root as { children?: PenpotNode[] } | undefined)?.children
  if (!Array.isArray(boards)) return 0
  return boards.filter((node) => node?.type === 'frame').length
}

/** Describe a document for the list. Total-defensive: a malformed document
 *  summarizes as an empty one. */
export function summarize(doc: PenpotDocument): DerivedSummary {
  const pages = Array.isArray(doc?.children) ? doc.children : []
  return {
    name: typeof doc?.name === 'string' && doc.name ? doc.name : 'Untitled',
    pages: pages.map((page, i) => ({
      id: typeof page?.id === 'string' ? page.id : `page-${i}`,
      name: typeof page?.name === 'string' && page.name ? page.name : `Page ${i + 1}`,
      boardCount: countBoards(page?.children),
    })),
  }
}
