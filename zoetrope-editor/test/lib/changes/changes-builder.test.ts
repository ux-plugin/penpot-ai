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
      redo: { type: 'set-active-themes', activeThemes: [] },
      undo: { type: 'set-active-themes', activeThemes: ['A'] },
    })
    let b = emptyChangesBuilder()
    b = appendDocMetaPair(b, {
      redo: { type: 'set-active-themes', activeThemes: ['B'] },
      undo: { type: 'set-active-themes', activeThemes: [] },
    })
    const m = mergeBundle(a, b)
    expect(m.docMeta?.map((c) => (c.type === 'set-active-themes' ? c.activeThemes.length : -1))).toEqual([0, 1])
    expect(m.docMetaUndo?.map((c) => (c.type === 'set-active-themes' ? c.activeThemes.length : -1))).toEqual([0, 1])
  })
})
