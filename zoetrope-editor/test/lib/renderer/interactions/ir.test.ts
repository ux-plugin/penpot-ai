import { describe, it, expect, beforeEach } from 'vitest'
import { behaviourNodes, cellRef, nodeRef, ownerKind, type Behaviour } from '../../../../src/lib/renderer/interactions/ir'
import {
  getTrigger,
  getAction,
  isKnownTrigger,
  isKnownAction,
  resolveTriggerForPlatform,
  resetCatalog,
  initDefaultCatalog,
} from '../../../../src/lib/renderer/interactions/catalog'
import { beh, cell, listCell, formulaCell, pageCell, PAGE, txt, variantCell } from './behaviour-fixtures'

function sample(): Behaviour {
  return beh({
    cells: [listCell('items'), formulaCell('isEmpty', 'items.length == 0'), variantCell('card', ['collapsed', 'expanded'], { initial: 'collapsed' })],
    rules: [{ node: 'addBtn', on: { type: 'press' }, do: [{ type: 'collection.append', target: 'items', value: '{ label: "" }' }] }],
    bindings: [
      { node: 'addBtn', prop: 'disabled', expr: 'isEmpty' },
      { node: 'list', prop: 'repeat', expr: 'items' },
    ],
  })
}

describe('cell references', () => {
  it('address a page cell by name and a node cell as <node>.<cell>', () => {
    expect(cellRef(cell('items', { collection: 'object' }, []))).toBe('items')
    expect(cellRef(variantCell('card', ['a']))).toBe('card.state')
  })

  it('mangle a node id that is not an identifier, so a UUID node still has an address', () => {
    expect(nodeRef('card')).toBe('card')
    const uuid = '2f1c3a9e-0000-4000-8000-000000000001'
    expect(nodeRef(uuid)).toMatch(/^n_[A-Za-z0-9_]+$/)
    expect(cellRef(variantCell(uuid, ['a']))).toBe(`${nodeRef(uuid)}.state`)
  })
})

describe('behaviourNodes', () => {
  it('collects node ids across rules, bindings and node cells', () => {
    expect([...behaviourNodes(sample())].sort()).toEqual(['addBtn', 'card', 'list'])
  })
})

describe('fromText — text becomes records', () => {
  const b = beh({
    cells: [
      listCell('items'),
      pageCell('theme', 'string', 'light', { scope: 'document' }),
      pageCell('user', 'string', 'Ada', { store: 'app', description: 'who is signed in' }),
      formulaCell('isEmpty', 'items.length == 0'),
      variantCell('card', ['collapsed', 'expanded'], { initial: 'collapsed' }),
      variantCell('addBtn', ['enabled', 'disabled'], { formula: "isEmpty ? 'disabled' : 'enabled'" }),
    ],
    bindings: [
      { node: 'row', prop: 'repeat', expr: 'items', item: { as: 'todo', key: 'todo.id' } },
      { node: 'row', prop: 'text', expr: 'item.label' },
    ],
    rules: [{ node: 'card', on: { type: 'press' }, do: [{ type: 'set-variable', target: 'card.state', value: '"expanded"' }] }],
  })
  const byRef = (ref: string) => b.cells.find((c) => cellRef(c) === ref)

  it('gives every cell its owner: document, page or node', () => {
    expect(b.cells.map(cellRef).sort()).toEqual(['addBtn.state', 'card.state', 'isEmpty', 'items', 'theme', 'user'])
    expect(ownerKind(byRef('theme')!)).toBe('document')
    expect(byRef('theme')).not.toHaveProperty('page')
    expect(ownerKind(byRef('items')!)).toBe('page')
    expect(byRef('items')?.page).toBe(PAGE)
    expect(byRef('card.state')).toMatchObject({ name: 'state', node: 'card', page: PAGE })
    expect(ownerKind(byRef('card.state')!)).toBe('node')
    expect(txt(b, byRef('isEmpty')?.formula)).toBe('items.length == 0')
    expect(byRef('user')).toMatchObject({ store: 'app', description: 'who is signed in', initial: 'Ada' })
  })

  it('a variant set is an enum cell the node owns, formula-driven when it is bound', () => {
    expect(byRef('card.state')).toMatchObject({ type: { enum: ['collapsed', 'expanded'] }, initial: 'collapsed' })
    expect(byRef('card.state')).not.toHaveProperty('formula')
    expect(txt(b, byRef('addBtn.state')?.formula)).toBe('isEmpty ? "disabled" : "enabled"')
  })

  it('resolves names to identities: the loop variable is an item, the list a cell', () => {
    const repeat = b.bindings.find((x) => x.node === 'row' && x.prop === 'repeat')!
    const label = b.bindings.find((x) => x.node === 'row' && x.prop === 'text')!
    expect(repeat.item?.key).toEqual({ type: 'member', object: { type: 'ref', ref: { kind: 'item', name: 'todo' } }, property: 'id' })
    expect(repeat.expr).toEqual({ type: 'ref', ref: { kind: 'cell', cell: 'items' } })
    expect(label.expr).toEqual({ type: 'member', object: { type: 'ref', ref: { kind: 'name', name: 'item' } }, property: 'label' })
    expect(b.rules[0].do[0].target).toEqual({ kind: 'cell', cell: 'card.state' })
  })
})

describe('catalog', () => {
  beforeEach(() => {
    resetCatalog()
    initDefaultCatalog()
  })

  it('registers the Phase 0 defaults', () => {
    expect(isKnownTrigger('press')).toBe(true)
    expect(isKnownAction('collection.append')).toBe(true)
    expect(isKnownTrigger('does-not-exist')).toBe(false)
  })

  it('carries platform tags and lowering metadata', () => {
    expect(getTrigger('press')?.platforms).toEqual(['web', 'native'])
    expect(getAction('collection.append')?.lowers).toBe('fold')
    expect(getAction('navigate')?.lowers).toBe('switch')
  })

  it('resolves cross-platform with fallback rules', () => {
    expect(resolveTriggerForPlatform('press', 'native')?.key).toBe('press')
    expect(resolveTriggerForPlatform('mouse-enter', 'web')?.key).toBe('mouse-enter')
    expect(resolveTriggerForPlatform('mouse-enter', 'native')).toBeUndefined()
  })
})
