/**
 * A page-level change kind that swaps a page's `interactions` block.
 *
 * Penpot's `Change` union is shape-oriented (add/mod/del-obj, …) and has no
 * page-metadata kind. Interaction edits still want to ride the SAME commit +
 * undo/redo pipeline as shape edits, so we model an edit as this local change:
 * `processChange` recognizes it via `isPageInteractionsChange` (before the shape
 * switch) and the redo/undo pair carries next/prev interactions respectively.
 *
 * It is cast to `Change` at the single boundary in `buildSetPageInteractions` so
 * the rest of the pipeline (grouping, history frames, replay) treats it like any
 * other change without widening every signature.
 */

import type { Change } from 'penpot-exporter/types'
import type { PageInteractions } from '../renderer/interactions/ir'

export const SET_PAGE_INTERACTIONS = 'set-page-interactions' as const

export interface PageInteractionsChange {
  type: typeof SET_PAGE_INTERACTIONS
  pageId: string
  interactions: PageInteractions | undefined
}

export function isPageInteractionsChange(change: unknown): change is PageInteractionsChange {
  return (
    typeof change === 'object' &&
    change !== null &&
    (change as { type?: unknown }).type === SET_PAGE_INTERACTIONS
  )
}

/**
 * Redo/undo pair for replacing a page's interactions. `next` is the edit, `prev`
 * is what to restore on undo (may be `undefined` for a first-ever edit).
 */
export function buildSetPageInteractions(
  pageId: string,
  prev: PageInteractions | undefined,
  next: PageInteractions | undefined,
): { redo: Change; undo: Change } {
  const make = (interactions: PageInteractions | undefined): Change =>
    ({ type: SET_PAGE_INTERACTIONS, pageId, interactions }) as unknown as Change
  return { redo: make(next), undo: make(prev) }
}
