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
 * Counts are derived, not tracked: every commit re-derives the summary, so it
 * can never drift from the document it describes.
 */

import { children, get, meta, pagesInOrder, type Imported, type Node, type Page } from '../doc'

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

function pageSummary(page: Page, i: number, boardCount: number): PageSummary {
  return { id: page.id, name: page.name || `Page ${i + 1}`, boardCount }
}

const nameOf = (name: unknown): string => (typeof name === 'string' && name ? name : 'Untitled')

/** Describe an imported document for the list. Boards are a page's top-level frames. */
export function summarizeImported(im: Imported): DerivedSummary {
  const boards = new Map<string, number>()
  for (const n of im.nodes) if (!n.parentId && n.type === 'frame') boards.set(n.page, (boards.get(n.page) ?? 0) + 1)
  const pages = [...im.pages].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
  return { name: nameOf(im.meta.name), pages: pages.map((p, i) => pageSummary(p, i, boards.get(p.id) ?? 0)) }
}

/** Describe the document in the editor, from the child index (no node scan). */
export function summarizeLive(): DerivedSummary {
  return {
    name: nameOf(meta.peek()?.name),
    pages: pagesInOrder().map((p, i) =>
      pageSummary(p, i, children(p.id).filter((id) => (get('node', id) as Node | undefined)?.type === 'frame').length),
    ),
  }
}
