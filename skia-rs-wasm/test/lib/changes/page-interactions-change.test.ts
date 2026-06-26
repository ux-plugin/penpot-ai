import { describe, it, expect } from 'vitest'
import {
  buildSetPageInteractions,
  isPageInteractionsChange,
} from '../../../src/lib/changes/page-interactions-change'
import { processChanges } from '../../../src/lib/worker/process-changes'
import { emptyPageInteractions } from '../../../src/lib/renderer/interactions/ir'
import type { IndexedPage } from '../../../src/lib/worker/types'
import type { PageInteractions } from '../../../src/lib/renderer/interactions/ir'

function pageWith(interactions: PageInteractions | undefined): IndexedPage {
  return { id: 'p1', name: 'Page', objects: {}, interactions } as unknown as IndexedPage
}

describe('set-page-interactions change', () => {
  it('guard recognizes the kind and rejects shape changes', () => {
    const { redo } = buildSetPageInteractions('p1', undefined, emptyPageInteractions())
    expect(isPageInteractionsChange(redo)).toBe(true)
    expect(isPageInteractionsChange({ type: 'mod-obj', id: 'x', operations: [] })).toBe(false)
    expect(isPageInteractionsChange(null)).toBe(false)
  })

  it('redo applies next; undo restores the previous IR', () => {
    const prev = emptyPageInteractions()
    const next = emptyPageInteractions()
    const { redo, undo } = buildSetPageInteractions('p1', prev, next)

    const afterRedo = processChanges(pageWith(prev), [redo])
    expect(afterRedo.interactions).toBe(next)

    const afterUndo = processChanges(afterRedo, [undo])
    expect(afterUndo.interactions).toBe(prev)
  })

  it('handles a first-ever edit (prev undefined) — undo clears it', () => {
    const next = emptyPageInteractions()
    const { redo, undo } = buildSetPageInteractions('p1', undefined, next)

    const afterRedo = processChanges(pageWith(undefined), [redo])
    expect(afterRedo.interactions).toBe(next)

    const afterUndo = processChanges(afterRedo, [undo])
    expect(afterUndo.interactions).toBeUndefined()
  })

  it('leaves page objects untouched', () => {
    const page = pageWith(undefined)
    const { redo } = buildSetPageInteractions('p1', undefined, emptyPageInteractions())
    const after = processChanges(page, [redo])
    expect(after.objects).toEqual(page.objects)
  })
})
