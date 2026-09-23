import { beforeEach, describe, expect, it } from 'vitest'
import type { PenpotNode } from 'penpot-exporter/types'
import { makeBaseDocument, PAGE_ID, RECT_ID, resetWorkspace, seedDocument, TEXT_ID } from '../fixtures'
import {
  addSubtree,
  children,
  commitChanges,
  count,
  dangling,
  del,
  getNode,
  mod,
  ofType,
  ownedBy,
  readersOf,
  refFields,
  refsOf,
  remap,
  rowsOf,
  countUnder,
  undo,
  addNode,
} from '../../../src/lib/doc'
import { computed, effect } from '@preact/signals-core'
import { resetEffects, resetSubscribers } from '../../../src/lib/doc/commit'

const frame = (id: string, kids: PenpotNode[] = []): PenpotNode =>
  ({ id, type: 'frame', name: id, x: 0, y: 0, width: 10, height: 10, children: kids }) as unknown as PenpotNode
const rect = (id: string, extra: Record<string, unknown> = {}): PenpotNode =>
  ({ id, type: 'rect', name: id, x: 0, y: 0, width: 1, height: 1, ...extra }) as unknown as PenpotNode
const slot = (id: string, views: string[], activeView?: string): PenpotNode =>
  ({ id, type: 'slot', name: id, x: 0, y: 0, width: 5, height: 5, views, activeView }) as unknown as PenpotNode

beforeEach(() => {
  resetWorkspace()
  resetSubscribers()
  resetEffects()
  seedDocument(makeBaseDocument())
})

describe('reference registry', () => {
  it('reads every node reference from the schema, lists included', () => {
    expect(refFields('node').map((f) => [f.field, f.kind, f.onDelete, f.many])).toEqual([
      ['page', 'page', 'cascade', false],
      ['parentId', 'node', 'cascade', false],
      ['frameId', 'node', 'keep', false],
      ['shapeRef', 'node', 'keep', false],
      ['views', 'node', 'keep', true],
      ['activeView', 'node', 'keep', false],
    ])
    expect(refFields('page')).toEqual([])
  })

  it('lists the references a record holds, one per list element', () => {
    const refs = refsOf('node', { id: 's', page: 'p', order: 'a0', type: 'slot', views: ['v1', 'v2'], activeView: 'v1' } as never)
    expect(refs.map((r) => `${r.field}:${r.id}`)).toEqual(['page:p', 'views:v1', 'views:v2', 'activeView:v1'])
  })

  it('remap rewrites references in the map and keeps the rest', () => {
    const map = new Map([['f', 'f2'], ['v1', 'v9']])
    const out = remap('node', { id: 'a', page: 'p', parentId: 'f', frameId: 'x', order: 'a0', type: 'slot', views: ['v1', 'v2'] } as never, map)
    expect(out).toMatchObject({ parentId: 'f2', frameId: 'x', views: ['v9', 'v2'], page: 'p' })
    const same = { id: 'b', page: 'p', order: 'a0', type: 'rect' } as never
    expect(remap('node', same, map)).toBe(same)
  })
})

describe('readersOf', () => {
  it('finds copies by shapeRef and follows edits, deletes and undo', async () => {
    await commitChanges({ changes: [addNode(rect('c1', { shapeRef: RECT_ID }), { page: PAGE_ID })] })
    expect(readersOf('node', 'shapeRef', RECT_ID)).toEqual(['c1'])
    await commitChanges({ changes: [addNode(rect('c2', { shapeRef: RECT_ID }), { page: PAGE_ID })] })
    expect([...readersOf('node', 'shapeRef', RECT_ID)].sort()).toEqual(['c1', 'c2'])
    await commitChanges({ changes: [mod('node', 'c1', { shapeRef: TEXT_ID })] })
    expect(readersOf('node', 'shapeRef', RECT_ID)).toEqual(['c2'])
    expect(readersOf('node', 'shapeRef', TEXT_ID)).toEqual(['c1'])
    await commitChanges({ changes: [del('node', 'c2')] })
    expect(readersOf('node', 'shapeRef', RECT_ID)).toEqual([])
    await undo()
    expect(readersOf('node', 'shapeRef', RECT_ID)).toEqual(['c2'])
  })

  it('indexes each element of a list reference', async () => {
    await commitChanges({ changes: [addNode(slot('s', ['v1', 'v2'], 'v1'), { page: PAGE_ID })] })
    expect(readersOf('node', 'views', 'v2')).toEqual(['s'])
    expect(readersOf('node', 'activeView', 'v1')).toEqual(['s'])
    await commitChanges({ changes: [mod('node', 's', { views: ['v2'] } as never)] })
    expect(readersOf('node', 'views', 'v1')).toEqual([])
  })

  it('is reactive', async () => {
    const seen: number[] = []
    const dispose = effect(() => {
      seen.push(readersOf('node', 'shapeRef', RECT_ID).length)
    })
    await commitChanges({ changes: [addNode(rect('c1', { shapeRef: RECT_ID }), { page: PAGE_ID })] })
    expect(seen).toEqual([0, 1])
    dispose()
  })
})

describe('cascade from the registry', () => {
  it('a node delete takes its subtree, deepest first; a keep reference dangles', async () => {
    await commitChanges({ changes: addSubtree(frame('f', [frame('g', [rect('b')])]), { page: PAGE_ID }) })
    await commitChanges({ changes: [addNode(rect('copy', { shapeRef: 'b' }), { page: PAGE_ID })] })
    expect(ownedBy('node', 'f').map((o) => o.id)).toEqual(['b', 'g'])
    await commitChanges({ changes: [del('node', 'f')] })
    expect(getNode('copy')?.shapeRef).toBe('b')
    expect(dangling()).toEqual([{ kind: 'node', id: 'copy', field: 'shapeRef', target: 'b' }])
    await undo()
    expect(dangling()).toEqual([])
  })

  it('a page delete takes every node on it', async () => {
    await commitChanges({ changes: addSubtree(frame('f', [rect('a')]), { page: PAGE_ID }) })
    expect(count('node')).toBe(4)
    await commitChanges({ changes: [del('page', PAGE_ID)] })
    expect(count('node')).toBe(0)
    expect(children(PAGE_ID)).toEqual([])
    await undo()
    expect(count('node')).toBe(4)
    expect(children('f')).toEqual(['a'])
  })
})

describe('ofType', () => {
  it('tracks nodes of a type per page', async () => {
    expect([...ofType(PAGE_ID, 'rect')]).toEqual([RECT_ID])
    await commitChanges({ changes: [addNode(slot('s', []), { page: PAGE_ID })] })
    expect([...ofType(PAGE_ID, 'slot')]).toEqual(['s'])
    await commitChanges({ changes: [addNode(rect('r2'), { page: PAGE_ID })] })
    expect([...ofType(PAGE_ID, 'rect')].sort()).toEqual(['r2', RECT_ID].sort())
    await commitChanges({ changes: [mod('node', 'r2', { type: 'circle' } as never)] })
    expect([...ofType(PAGE_ID, 'rect')]).toEqual([RECT_ID])
    await commitChanges({ changes: [del('node', 's')] })
    expect([...ofType(PAGE_ID, 'slot')]).toEqual([])
  })
})

describe('rowsOf', () => {
  it('walks structure only; a field edit does not rerun it; collapsed subtrees are skipped', async () => {
    await commitChanges({ changes: addSubtree(frame('f', [rect('a')]), { page: PAGE_ID }) })
    const collapsed = new Set<string>()
    let runs = 0
    const rows = computed(() => {
      runs++
      return rowsOf(PAGE_ID, (id) => collapsed.has(id))
    })
    expect(rows.value.map((r) => `${r.id}:${r.depth}:${r.hasChildren}`)).toEqual([
      `${RECT_ID}:0:false`,
      `${TEXT_ID}:0:false`,
      'f:0:true',
      'a:1:false',
    ])
    await commitChanges({ changes: [mod('node', 'a', { name: 'renamed' })] })
    void rows.value
    expect(runs).toBe(1)
    await commitChanges({ changes: [addNode(rect('b'), { page: PAGE_ID, parentId: 'f' })] })
    expect(rows.value.map((r) => r.id)).toEqual([RECT_ID, TEXT_ID, 'f', 'a', 'b'])
    collapsed.add('f')
    expect(rowsOf(PAGE_ID, (id) => collapsed.has(id)).map((r) => r.id)).toEqual([RECT_ID, TEXT_ID, 'f'])
    expect(countUnder(PAGE_ID)).toBe(5)
  })
})
