/**
 * The interactions block as an aspect: when nodes are deleted, the behaviour
 * they own leaves the page in the same frame (changes/aspects.ts).
 *
 * Copies are not followed yet — a component copy gets no behaviour of its own
 * until the machine stream decides what a copy's cells mean.
 */

import type { Aspect, AspectEffects, DeletedNodes } from '../../../changes/aspects'
import { buildSetPageInteractions } from '../../../changes/page-interactions-change'
import { dropNodes, upgradePageInteractions, type AnyPageInteractions } from '../ir'

function onDeleted({ pageId, page, ids }: DeletedNodes): AspectEffects | null {
  const stored = page.interactions as AnyPageInteractions | undefined
  if (!stored) return null
  const prev = upgradePageInteractions(stored).ir
  const next = dropNodes(prev, ids)
  if (next === prev) return null
  const { redo, undo } = buildSetPageInteractions(pageId, prev, next)
  return { redoChanges: [redo], undoChanges: [undo] }
}

export const interactionsAspect: Aspect = { key: 'interactions', onDeleted }
