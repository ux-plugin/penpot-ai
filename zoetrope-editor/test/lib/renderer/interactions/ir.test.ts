import { describe, it, expect, beforeEach } from 'vitest'
import {
  emptyPageInteractions,
  reconcile,
  referencedNodeIds,
  isV1,
  cellRef,
  nodeRef,
  STATE_CELL,
  type PageInteractions,
} from '../../../../src/lib/renderer/interactions/ir'
import { upgradePageInteractions } from '../../../../src/lib/renderer/interactions/upgrade'
import { toTextIR } from '../../../../src/lib/renderer/interactions/expr'
import {
  getTrigger,
  getAction,
  isKnownTrigger,
  isKnownAction,
  resolveTriggerForPlatform,
  resetCatalog,
  initDefaultCatalog,
} from '../../../../src/lib/renderer/interactions/catalog'
import { cell, listCell, formulaCell, txt, up, variantCell } from './todo-ir'

function sampleIR(): PageInteractions {
  return up({
    cells: [listCell('items'), formulaCell('isEmpty', 'items.length == 0'), variantCell('card', ['collapsed', 'expanded'], { initial: 'collapsed' })],
    interactions: [{ on: { node: 'addBtn', trigger: { type: 'press' } }, do: [{ type: 'collection.append', target: 'items', value: '{ label: "" }' }] }],
    refs: [
      { node: 'addBtn', props: { disabled: 'isEmpty' } },
      { node: 'list', props: { repeat: 'items' } },
    ],
  })
}

describe('cell references', () => {
  it('address a page cell by id and a node cell as <node>.<cell>', () => {
    expect(cellRef(cell('items', { collection: 'object' }, []))).toBe('items')
    expect(cellRef({ ...variantCell('card', ['a']), uid: 'x' })).toBe('card.state')
  })

  it('mangle a node id that is not an identifier, so a UUID node still has an address', () => {
    expect(nodeRef('card')).toBe('card')
    const uuid = '2f1c3a9e-0000-4000-8000-000000000001'
    expect(nodeRef(uuid)).toMatch(/^n_[A-Za-z0-9_]+$/)
    expect(cellRef({ ...variantCell(uuid, ['a']), uid: 'x' })).toBe(`${nodeRef(uuid)}.state`)
  })
})

describe('referencedNodeIds', () => {
  it('collects node ids across interactions, references and node cells', () => {
    const ids = referencedNodeIds(sampleIR())
    expect([...ids].sort()).toEqual(['addBtn', 'card', 'list'])
  })
})

describe('reconcile (regenerate/merge contract)', () => {
  it('reports nothing dangling when every referenced node is present', () => {
    const r = reconcile(sampleIR(), new Set(['addBtn', 'list', 'card']))
    expect(r.ok).toBe(true)
    expect(r.dangling).toHaveLength(0)
  })

  it('flags behavior whose node was removed', () => {
    const r = reconcile(sampleIR(), new Set(['addBtn']))
    expect(r.ok).toBe(false)
    const kinds = r.dangling.map((d) => `${d.kind}:${d.node}`).sort()
    expect(kinds).toEqual(['cell:card', 'refs:list'])
  })

  it('does not treat new behaviorless nodes as errors', () => {
    const r = reconcile(emptyPageInteractions(), new Set(['brandNewNode']))
    expect(r.ok).toBe(true)
    expect(r.dangling).toHaveLength(0)
  })
})

describe('upgrade — a version-1 block becomes cells and references', () => {
  /** The pre-cells shape: separate variables, derived, bindings, states, repeaters, editable. */
  const v1 = {
    version: 1 as const,
    stores: [{ id: 'app', description: 'the backend' }],
    variables: [
      { id: 'items', type: { collection: 'object' }, scope: 'page' as const, initial: [] },
      { id: 'theme', type: 'string', scope: 'global' as const, initial: 'light' },
      { id: 'user', type: 'string', scope: 'page' as const, initial: 'Ada', store: 'app', description: 'who is signed in' },
    ],
    derived: [{ id: 'isEmpty', expr: 'items.length == 0' }],
    interactions: [
      {
        id: 'i1',
        on: { node: 'card', trigger: { type: 'press' as const } },
        do: [{ type: 'node.setState', target: 'card.state', value: '"expanded"' }],
      },
    ],
    appRules: [],
    bindings: [{ node: 'row', prop: 'text', from: 'item.label' }],
    states: [
      { node: 'card', states: ['collapsed', 'expanded'], active: { from: 'self' as const, initial: 'collapsed' } },
      { node: 'addBtn', states: ['enabled', 'disabled'], active: { bind: "isEmpty ? 'disabled' : 'enabled'" } },
    ],
    repeaters: [{ node: 'row', over: 'items', as: 'todo', key: 'todo.id' }],
    editable: [{ node: 'field', prop: 'value', target: 'user' }],
  }

  it('recognizes the old shape and passes the new one through untouched', () => {
    expect(isV1(v1)).toBe(true)
    const fresh = emptyPageInteractions()
    expect(upgradePageInteractions(fresh)).toEqual({ ir: fresh, stores: [] })
  })

  it('turns variables, derived and states into cells with the right owners', () => {
    const { ir } = upgradePageInteractions(v1)
    expect(ir.version).toBe(3)
    expect(ir.cells.map(cellRef).sort()).toEqual(['addBtn.state', 'card.state', 'isEmpty', 'items', 'theme', 'user'])
    // identity is stable and never a display name
    expect(ir.cells.find((c) => c.id === 'isEmpty')?.uid).toBe('isEmpty')
    expect(ir.cells.find((c) => c.id === 'theme')?.owner).toEqual({ kind: 'document' }) // global → document
    expect(ir.cells.find((c) => c.id === 'items')?.owner).toEqual({ kind: 'page' })
    expect(txt(ir, ir.cells.find((c) => c.id === 'isEmpty')?.formula)).toBe('items.length == 0')
    expect(ir.cells.find((c) => c.id === 'user')).toMatchObject({ store: 'app', description: 'who is signed in', initial: 'Ada' })
  })

  it('turns a variant set into an enum cell the node owns, formula-driven when it was bound', () => {
    const { ir } = upgradePageInteractions(v1)
    const card = ir.cells.find((c) => cellRef(c) === 'card.state')
    expect(card).toMatchObject({ id: STATE_CELL, owner: { kind: 'node', node: 'card' }, type: { enum: ['collapsed', 'expanded'] }, initial: 'collapsed' })
    expect(card).not.toHaveProperty('formula')
    const addBtn = ir.cells.find((c) => cellRef(c) === 'addBtn.state')
    expect(txt(ir, addBtn?.formula)).toBe('isEmpty ? "disabled" : "enabled"')
  })

  it('resolves names to identities: the loop variable is an item, the list a cell', () => {
    const { ir } = upgradePageInteractions(v1)
    const row = ir.refs.find((r) => r.node === 'row')!
    expect(row.item?.key).toEqual({ type: 'member', object: { type: 'ref', ref: { kind: 'item', name: 'todo' } }, property: 'id' })
    expect(row.props.repeat).toEqual({ type: 'ref', ref: { kind: 'cell', cell: 'items' } })
    // the binding said `item.label` while the loop variable is `todo`: kept as the name it typed, for validation to flag
    expect(row.props.text).toEqual({ type: 'member', object: { type: 'ref', ref: { kind: 'name', name: 'item' } }, property: 'label' })
    expect(ir.interactions[0].do[0].target).toEqual({ kind: 'cell', cell: 'card.state' })
  })

  it('folds bindings, editable and repeaters into one references block per node', () => {
    const { ir } = upgradePageInteractions(v1)
    expect(toTextIR(ir).refs).toContainEqual({ node: 'row', props: { text: 'item.label', repeat: 'items' }, item: { as: 'todo', key: 'todo.id' } })
    expect(toTextIR(ir).refs).toContainEqual({ node: 'field', props: { value: 'user' } })
  })

  it('rewrites node.setState as a plain write to the node cell', () => {
    const { ir } = upgradePageInteractions(v1)
    expect(toTextIR(ir).interactions[0].do[0]).toEqual({ type: 'set-variable', target: 'card.state', value: '"expanded"' })
  })

  it('hands the stores to the document — they are not page state anymore', () => {
    const { ir, stores } = upgradePageInteractions(v1)
    expect(stores).toEqual([{ id: 'app', description: 'the backend' }])
    expect(ir).not.toHaveProperty('stores')
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
    // hover is web-only and has no fallback yet -> unsupported on native
    expect(resolveTriggerForPlatform('mouse-enter', 'web')?.key).toBe('mouse-enter')
    expect(resolveTriggerForPlatform('mouse-enter', 'native')).toBeUndefined()
  })
})
