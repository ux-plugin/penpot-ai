import { afterEach, describe, expect, it } from 'vitest'
import type { Change } from 'penpot-exporter/types'
import type { IndexedPage } from '../../../src/lib/worker/types'
import {
  collectAspectEffects,
  collectDeleted,
  registerAspect,
  resetAspects,
  type Aspect,
} from '../../../src/lib/changes/aspects'

const ROOT = '00000000-0000-0000-0000-000000000000'

function page(): IndexedPage {
  const node = (id: string, shapes: string[] = [], parentId = ROOT) =>
    ({ id, type: 'frame', name: id, x: 0, y: 0, width: 10, height: 10, shapes, parentId }) as never
  return {
    id: 'p1',
    objects: {
      [ROOT]: node(ROOT, ['a', 'z']),
      a: node('a', ['b']),
      b: node('b', ['c'], 'a'),
      c: node('c', [], 'b'),
      z: node('z'),
    },
  } as unknown as IndexedPage
}

const del = (id: string, pageId?: string): Change => ({ type: 'del-obj', id, pageId }) as Change
const getPage = (id: string) => (id === 'p1' ? page() : undefined)

describe('aspects', () => {
  afterEach(() => resetAspects())

  it('collectDeleted includes descendants and groups by page', () => {
    const out = collectDeleted([del('a'), del('z', 'p1'), del('q', 'p2')], 'p1', getPage)
    expect(out).toHaveLength(1)
    expect(out[0].pageId).toBe('p1')
    expect([...out[0].ids].sort()).toEqual(['a', 'b', 'c', 'z'])
  })

  it('collectDeleted ignores non-delete changes', () => {
    const mod = { type: 'mod-obj', id: 'a', operations: [] } as unknown as Change
    expect(collectDeleted([mod], 'p1', getPage)).toEqual([])
  })

  it('no aspects → no effects', () => {
    const fx = collectAspectEffects({ changes: [del('a')], fallbackPageId: 'p1', getPage })
    expect(fx).toEqual({ redoChanges: [], undoChanges: [] })
  })

  it('runs hooks in registration order; redo appends, undo prepends', () => {
    const mk = (key: string): Aspect => ({
      key,
      onDeleted: ({ ids }) => ({
        redoChanges: [{ type: 'mod-obj', id: `${key}:${[...ids].sort().join('')}`, operations: [] } as unknown as Change],
        undoChanges: [{ type: 'mod-obj', id: `undo-${key}`, operations: [] } as unknown as Change],
      }),
    })
    registerAspect(mk('one'))
    registerAspect(mk('two'))
    const fx = collectAspectEffects({ changes: [del('a')], fallbackPageId: 'p1', getPage })
    expect(fx.redoChanges.map((c) => c.id)).toEqual(['one:abc', 'two:abc'])
    expect(fx.undoChanges.map((c) => c.id)).toEqual(['undo-two', 'undo-one'])
  })

  it('a hook returning null contributes nothing', () => {
    registerAspect({ key: 'quiet', onDeleted: () => null })
    const fx = collectAspectEffects({ changes: [del('a')], fallbackPageId: 'p1', getPage })
    expect(fx.redoChanges).toEqual([])
  })

  it('copies reach onCopied with the page', () => {
    let seen: Array<[string, string]> = []
    registerAspect({
      key: 'copy',
      onCopied: ({ ids, page: p }) => {
        seen = [...ids.entries()]
        expect(p.id).toBe('p1')
        return null
      },
    })
    collectAspectEffects({
      changes: [],
      fallbackPageId: 'p1',
      getPage,
      copies: [{ pageId: 'p1', ids: new Map([['a', 'a2']]) }],
    })
    expect(seen).toEqual([['a', 'a2']])
  })

  it('a disposer unregisters', () => {
    const dispose = registerAspect({ key: 'x', onDeleted: () => ({ redoChanges: [del('never')], undoChanges: [] }) })
    dispose()
    const fx = collectAspectEffects({ changes: [del('a')], fallbackPageId: 'p1', getPage })
    expect(fx.redoChanges).toEqual([])
  })
})
