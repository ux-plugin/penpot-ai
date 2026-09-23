import { beforeEach, describe, expect, it } from 'vitest'
import type { PenpotDocument } from 'penpot-exporter/types'
import {
  add,
  commitChanges,
  count,
  del,
  exportDocument,
  get,
  importDocument,
  loadImported,
  refFields,
  undo,
} from '../../../src/lib/doc'
import { resetEffects, resetSubscribers } from '../../../src/lib/doc/commit'
import { behaviourOf } from '../../../src/lib/renderer/interactions/document/behaviour'
import { addRule, addStore, removeStore } from '../../../src/lib/renderer/interactions/document/edit-interactions'
import { REF, type Binding, type Cell, type Rule } from '../../../src/lib/renderer/interactions/ir'
import { motionShapes, setMotionShapes } from '../../../src/lib/renderer/motion/motion-store'
import { setKeyframe } from '../../../src/lib/renderer/motion/edit'
import { PAGE_ID, seedNodes } from '../fixtures'

const cell = (id: string, extra: Partial<Cell> = {}): Cell => ({ id, name: id, type: 'number', initial: 0, ...extra })
const binding = (id: string, node: string, page = PAGE_ID): Binding => ({
  id,
  page,
  node,
  prop: 'text',
  expr: REF({ kind: 'cell', cell: 'count' }),
})
const rule = (id: string, node: string | undefined, order: string, page = PAGE_ID): Rule => ({
  id,
  page,
  ...(node ? { node } : {}),
  order,
  on: { type: node ? 'press' : 'load' },
  do: [],
})

beforeEach(() => {
  resetSubscribers()
  resetEffects()
  seedNodes(['btn', 'label'])
})

describe('behaviour references', () => {
  it('declares ownership and the store reference in the schemas', () => {
    const view = (k: Parameters<typeof refFields>[0]) => refFields(k).map((f) => `${f.field}:${f.kind}:${f.onDelete}`)
    expect(view('cell')).toEqual(['page:page:cascade', 'node:node:cascade', 'store:store:keep'])
    expect(view('binding')).toEqual(['page:page:cascade', 'node:node:cascade'])
    expect(view('rule')).toEqual(['page:page:cascade', 'node:node:cascade'])
    expect(view('timeline')).toEqual(['node:node:cascade'])
  })
})

describe('cascade', () => {
  it('a node delete takes its rules, bindings, own cells and motion in one frame; undo brings them back', async () => {
    setMotionShapes(setKeyframe([], 'btn', 'x', 500, 10))
    await commitChanges({
      changes: [
        add('cell', cell('count', { page: PAGE_ID })),
        add('cell', cell('pressed', { page: PAGE_ID, node: 'btn' })),
        add('binding', binding('b1', 'btn')),
        add('binding', binding('b2', 'label')),
        add('rule', rule('r1', 'btn', 'a0')),
      ],
    })
    await commitChanges({ changes: [del('node', 'btn')] })
    expect([get('rule', 'r1'), get('binding', 'b1'), get('cell', 'pressed')]).toEqual([undefined, undefined, undefined])
    expect(motionShapes.value).toEqual([])
    expect(get('binding', 'b2')?.node).toBe('label')
    expect(get('cell', 'count')).toBeDefined()
    await undo()
    expect(get('rule', 'r1')?.node).toBe('btn')
    expect(get('binding', 'b1')).toBeDefined()
    expect(get('cell', 'pressed')?.node).toBe('btn')
    expect(motionShapes.value.map((m) => m.node)).toEqual(['btn'])
  })

  it('a page delete takes its behaviour; document cells stay', async () => {
    await commitChanges({
      changes: [
        add('cell', cell('count', { page: PAGE_ID })),
        add('cell', cell('user')),
        add('rule', rule('onLoad', undefined, 'a0')),
      ],
    })
    await commitChanges({ changes: [del('page', PAGE_ID)] })
    expect(count('node')).toBe(0)
    expect(count('rule')).toBe(0)
    expect(get('cell', 'count')).toBeUndefined()
    expect(get('cell', 'user')).toBeDefined()
  })
})

describe('behaviourOf', () => {
  it('groups the page records, rules in order, and follows edits', async () => {
    const seen = behaviourOf(PAGE_ID)
    expect(seen.value.rules).toEqual([])
    await commitChanges({ changes: [add('rule', rule('late', 'btn', 'a2')), add('rule', rule('early', 'btn', 'a1'))] })
    expect(seen.value.rules.map((r) => r.id)).toEqual(['early', 'late'])
    await commitChanges({ changes: addRule(seen.value, 'label', 'third') })
    expect(seen.value.rules.map((r) => r.id)).toEqual(['early', 'late', 'third'])
    expect(get('rule', 'third')?.page).toBe(PAGE_ID)
  })
})

describe('stores', () => {
  it('removing a store detaches its cells on every page; undo reattaches', async () => {
    await commitChanges({ changes: addStore([], 'cart') })
    await commitChanges({
      changes: [add('cell', cell('items', { store: 'cart' })), add('cell', cell('total', { page: PAGE_ID, store: 'cart' }))],
    })
    await commitChanges({ changes: removeStore('cart') })
    expect(get('store', 'cart')).toBeUndefined()
    expect([get('cell', 'items')?.store, get('cell', 'total')?.store]).toEqual([undefined, undefined])
    await undo()
    expect(get('store', 'cart')).toBeDefined()
    expect([get('cell', 'items')?.store, get('cell', 'total')?.store]).toEqual(['cart', 'cart'])
  })
})

describe('export and import', () => {
  it('carries every behaviour record through the exported document', async () => {
    setMotionShapes(setKeyframe([], 'btn', 'x', 500, 10))
    await commitChanges({
      changes: [
        add('store', { id: 'cart', description: 'the cart' }),
        add('cell', cell('count', { page: PAGE_ID })),
        add('binding', binding('b1', 'label')),
        add('rule', rule('r1', 'btn', 'a0')),
      ],
    })
    const doc = exportDocument() as PenpotDocument
    const before = {
      store: get('store', 'cart'),
      cell: get('cell', 'count'),
      binding: get('binding', 'b1'),
      rule: get('rule', 'r1'),
      timeline: motionShapes.value[0],
    }
    loadImported(importDocument(JSON.parse(JSON.stringify(doc)) as PenpotDocument))
    expect({
      store: get('store', 'cart'),
      cell: get('cell', 'count'),
      binding: get('binding', 'b1'),
      rule: get('rule', 'r1'),
      timeline: motionShapes.value[0],
    }).toEqual(before)
  })
})

describe('motion', () => {
  it('a keyframe edit is a commit: undo takes it back', async () => {
    setMotionShapes(setKeyframe([], 'btn', 'x', 500, 10))
    setMotionShapes(setKeyframe(motionShapes.value, 'btn', 'x', 800, 20))
    const keys = () => motionShapes.value[0]?.timeline.bindings[0].curve.keys.map((k) => k.at)
    expect(keys()).toEqual([500, 800])
    await undo()
    expect(keys()).toEqual([500])
    await undo()
    expect(motionShapes.value).toEqual([])
  })
})
