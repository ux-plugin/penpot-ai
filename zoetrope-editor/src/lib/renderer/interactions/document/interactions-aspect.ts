/**
 * The interactions block as an aspect: when nodes are deleted, the behaviour
 * they own leaves the page in the same frame (changes/aspects.ts).
 *
 * Copies are not followed yet — a component copy gets no behaviour of its own
 * until the machine stream decides what a copy's cells mean.
 */
import type { Aspect, DeletedNodes } from '../../../changes/aspects'
import { get, mod, type LocalChange } from '../../../doc'
import { dropNodes } from '../ir'

function onDeleted({ ids }: DeletedNodes): LocalChange[] | null {
  const byPage = new Map<string, Set<string>>()
  for (const id of ids) {
    const page = get('node', id)?.page
    if (!page) continue
    let set = byPage.get(page)
    if (!set) byPage.set(page, (set = new Set()))
    set.add(id)
  }
  const out: LocalChange[] = []
  for (const [pageId, nodeIds] of byPage) {
    const prev = get('page', pageId)?.interactions
    if (!prev) continue
    const next = dropNodes(prev, nodeIds)
    if (next !== prev) out.push(mod('page', pageId, { interactions: next }))
  }
  return out.length ? out : null
}

export const interactionsAspect: Aspect = { key: 'interactions', onDeleted }
