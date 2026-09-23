import { describe, expect, it } from 'vitest'
import { appendDocMetaPair, appendMod, emptyChangesBuilder, mergeBundle, toCommitBundle } from '../../../src/lib/changes/changes-builder'

describe('changes-builder', () => {
  it('collects mods in order and carries the origin as the label', () => {
    let b = emptyChangesBuilder({ origin: 'move' })
    b = appendMod(b, 'a', { x: 1 })
    b = appendMod(b, 'b', { x: 2 })
    const params = toCommitBundle(b)
    expect(params.changes?.map((c) => (c.op === 'mod' ? c.id : ''))).toEqual(['a', 'b'])
    expect(params.label).toBe('move')
  })

  it('mergeBundle keeps redo order and reverses doc-meta undo order', () => {
    let a = emptyChangesBuilder()
    a = appendDocMetaPair(a, {
      redo: { type: 'set-stores', stores: [] },
      undo: { type: 'set-stores', stores: [{ id: 'A', name: 'a' } as never] },
    })
    let b = emptyChangesBuilder()
    b = appendDocMetaPair(b, {
      redo: { type: 'set-stores', stores: [{ id: 'B', name: 'b' } as never] },
      undo: { type: 'set-stores', stores: [] },
    })
    const m = mergeBundle(a, b)
    expect(m.docMeta?.map((c) => (c.type === 'set-stores' ? c.stores.length : -1))).toEqual([0, 1])
    expect(m.docMetaUndo?.map((c) => (c.type === 'set-stores' ? c.stores.length : -1))).toEqual([0, 1])
  })
})
