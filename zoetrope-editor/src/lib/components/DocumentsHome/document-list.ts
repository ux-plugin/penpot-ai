/**
 * document-list — the behaviour behind the documents screen, kept out of the
 * component so it can be tested.
 *
 * This follows the convention the codebase already uses for panel logic
 * (Settings/shortcut-display.ts, LayersPanel/reparent.ts): vitest collects only
 * `test/**\/*.test.ts` and there's no jsdom here, so anything worth asserting
 * lives in a plain module and the `.tsx` stays presentational.
 */

import type { DocumentSummary } from '../../persistence'
import { boardCount, pageCount } from '../../persistence'

/** Match on the document's own name or any of its page names. Page names are
 *  searchable because they're the part of a document a person actually
 *  remembers — "the pricing page" rather than which file it lives in. */
export function matchesQuery(doc: DocumentSummary, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (doc.name.toLowerCase().includes(q)) return true
  return doc.pages.some((page) => page.name.toLowerCase().includes(q))
}

/** Which slice of the library the rail is pointing at. */
export type Scope =
  | { kind: 'all' }
  | { kind: 'archived' }
  | { kind: 'project'; projectId: string }

export const ALL: Scope = { kind: 'all' }

/** Archived documents are excluded everywhere except the Archive scope —
 *  including inside a project, so archiving reliably gets something out of the
 *  way wherever it was filed. */
export function inScope(doc: DocumentSummary, scope: Scope): boolean {
  if (scope.kind === 'archived') return doc.archived === true
  if (doc.archived) return false
  if (scope.kind === 'project') return doc.projectId === scope.projectId
  return true
}

/** The list as shown: scoped, filtered, most recently edited first. */
export function visibleDocuments(
  documents: DocumentSummary[],
  query: string,
  scope: Scope = ALL,
): DocumentSummary[] {
  return documents
    .filter((doc) => inScope(doc, scope) && matchesQuery(doc, query))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Rail counts. Archived documents don't count towards All or a project — the
 *  number next to a scope has to match what clicking it shows. */
export function scopeCounts(documents: DocumentSummary[]): {
  all: number
  archived: number
  byProject: Record<string, number>
} {
  const byProject: Record<string, number> = {}
  let all = 0
  let archived = 0
  for (const doc of documents) {
    if (doc.archived) {
      archived++
      continue
    }
    all++
    if (doc.projectId) byProject[doc.projectId] = (byProject[doc.projectId] ?? 0) + 1
  }
  return { all, archived, byProject }
}

/**
 * Which document the "Continue" slot offers: the one last opened, else the most
 * recently edited. A stale id (the document was deleted) falls through rather
 * than showing nothing — there's still a sensible document to continue into.
 */
export function continueDocument(
  documents: DocumentSummary[],
  lastOpenedId: string | null,
): DocumentSummary | null {
  // Archived documents are never offered: you put them out of the way, so
  // surfacing one at the top of the screen would undo that.
  const active = documents.filter((doc) => !doc.archived)
  if (!active.length) return null
  const byRecency = [...active].sort((a, b) => b.updatedAt - a.updatedAt)
  return byRecency.find((doc) => doc.id === lastOpenedId) ?? byRecency[0]!
}

/** "5 pages · 14 boards" — the document's size in the two units that mean
 *  something here. Singular forms matter; "1 pages" reads as a bug. */
export function describeSize(doc: DocumentSummary): string {
  const pages = pageCount(doc)
  const boards = boardCount(doc)
  return `${pages} ${pages === 1 ? 'page' : 'pages'} · ${boards} ${boards === 1 ? 'board' : 'boards'}`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Coarse relative time. Deliberately vague past a week: an exact timestamp on a
 *  month-old document is noise, and the list is scanned, not audited. */
export function describeEdited(updatedAt: number, now: number): string {
  const elapsed = Math.max(0, now - updatedAt)
  if (elapsed < MINUTE) return 'Just now'
  if (elapsed < HOUR) {
    const mins = Math.floor(elapsed / MINUTE)
    return `${mins} ${mins === 1 ? 'minute' : 'minutes'} ago`
  }
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR)
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  }
  const days = Math.floor(elapsed / DAY)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  if (days < 14) return 'Last week'
  if (days < 31) return `${Math.floor(days / 7)} weeks ago`
  if (days < 60) return 'Last month'
  return `${Math.floor(days / 30)} months ago`
}

/** Chromolithograph-ish tints, muted enough to sit behind board rectangles on
 *  either ground. Lives here rather than in PageStrip.tsx so that file exports
 *  only components (react-refresh). */
const TINTS = ['#b4574a', '#a8781f', '#3f7a64', '#43648f', '#74558a']

/** A document's colour, picked by id so it stays the same across sessions and
 *  reorderings — position in the list would make it flicker as things move. */
export function tintFor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return TINTS[hash % TINTS.length]!
}

/** A name for a duplicate that doesn't collide with what's already listed.
 *  "Checkout copy", then "Checkout copy 2", and so on. */
export function nextCopyName(documents: DocumentSummary[], sourceName: string): string {
  const taken = new Set(documents.map((doc) => doc.name))
  const base = `${sourceName} copy`
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`
    if (!taken.has(candidate)) return candidate
  }
}
