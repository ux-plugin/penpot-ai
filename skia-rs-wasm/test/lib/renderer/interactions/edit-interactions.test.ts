import { describe, it, expect } from 'vitest'
import { emptyPageInteractions } from '../../../../src/lib/renderer/interactions/ir'
import {
  addInteraction,
  removeInteraction,
  setTrigger,
  setCondition,
  addAction,
  removeAction,
  setActionType,
  setActionTarget,
  setActionValue,
  addVariable,
  removeVariable,
  makeCollectionVariable,
  makeScalarVariable,
  defaultInitial,
  setVariableValue,
  setVariableType,
  toVariableId,
  setRepeater,
  clearRepeater,
  moveRepeater,
  addBinding,
  setBindingProp,
  setBindingFrom,
  removeBinding,
  addDerived,
  setDerivedExpr,
  removeDerived,
} from '../../../../src/lib/renderer/interactions/document/edit-interactions'
import { initRuntime, buildEnv, runInteraction } from '../../../../src/lib/renderer/interactions/preview/runtime'
import { parse, evaluate } from '../../../../src/lib/renderer/interactions/expression'

/** Author the canonical "Add → append a numbered row" interaction via reducers. */
function authorAppend() {
  let ir = addVariable(emptyPageInteractions(), makeCollectionVariable('items'))
  ir = addInteraction(ir, 'addBtn', 'i1')
  ir = addAction(ir, 'i1', 'collection.append')
  ir = setActionTarget(ir, 'i1', 0, 'items')
  ir = setActionValue(ir, 'i1', 0, '{ label: "Item " + (items.length + 1) }')
  return ir
}

describe('edit-interactions reducers', () => {
  it('addInteraction appends a press interaction without mutating input', () => {
    const ir = emptyPageInteractions()
    const next = addInteraction(ir, 'btn', 'i1')
    expect(ir.interactions).toHaveLength(0) // input untouched
    expect(next.interactions).toHaveLength(1)
    expect(next.interactions[0]).toMatchObject({ id: 'i1', on: { node: 'btn', trigger: { type: 'press' } }, do: [] })
  })

  it('setTrigger changes the trigger type', () => {
    let ir = addInteraction(emptyPageInteractions(), 'btn', 'i1')
    ir = setTrigger(ir, 'i1', 'mouse-enter')
    expect(ir.interactions[0].on.trigger.type).toBe('mouse-enter')
  })

  it('setCondition sets and clears the guard', () => {
    let ir = addInteraction(emptyPageInteractions(), 'btn', 'i1')
    ir = setCondition(ir, 'i1', 'items.length < 10')
    expect(ir.interactions[0].if).toBe('items.length < 10')
    ir = setCondition(ir, 'i1', '   ')
    expect(ir.interactions[0].if).toBeUndefined()
  })

  it('action add/type/target/value/remove edit do[] correctly', () => {
    let ir = addInteraction(emptyPageInteractions(), 'btn', 'i1')
    ir = addAction(ir, 'i1')
    expect(ir.interactions[0].do[0].type).toBe('set-variable')
    ir = setActionType(ir, 'i1', 0, 'collection.append')
    expect(ir.interactions[0].do[0]).toEqual({ type: 'collection.append' }) // type change clears target/value
    ir = setActionTarget(ir, 'i1', 0, 'items')
    ir = setActionValue(ir, 'i1', 0, '42')
    expect(ir.interactions[0].do[0]).toEqual({ type: 'collection.append', target: 'items', value: '42' })
    ir = removeAction(ir, 'i1', 0)
    expect(ir.interactions[0].do).toHaveLength(0)
  })

  it('removeInteraction reverses an add (in-panel undo)', () => {
    let ir = addInteraction(emptyPageInteractions(), 'btn', 'i1')
    ir = removeInteraction(ir, 'i1')
    expect(ir.interactions).toHaveLength(0)
  })

  it('addVariable is id-idempotent; removeVariable drops it', () => {
    let ir = addVariable(emptyPageInteractions(), makeCollectionVariable('items'))
    ir = addVariable(ir, makeScalarVariable('items')) // same id ignored
    expect(ir.variables).toHaveLength(1)
    expect(ir.variables[0].type).toEqual({ collection: 'object' })
    ir = removeVariable(ir, 'items')
    expect(ir.variables).toHaveLength(0)
  })

  it('toVariableId sanitizes user text', () => {
    expect(toVariableId('  my list ')).toBe('my_list')
    expect(toVariableId('1st')).toBe('_1st')
    expect(toVariableId('!!!')).toBe('___')
  })
})

describe('authored IR actually runs in the runtime', () => {
  it('press → append yields numbered rows on repeated fire', () => {
    const ir = authorAppend()
    const it = ir.interactions.find((x) => x.id === 'i1')!
    let rt = initRuntime(ir)
    expect(rt.store.items).toEqual([])
    rt = runInteraction(ir, rt, it, buildEnv(ir, rt))
    expect(rt.store.items).toEqual([{ label: 'Item 1' }])
    rt = runInteraction(ir, rt, it, buildEnv(ir, rt))
    expect(rt.store.items).toEqual([{ label: 'Item 1' }, { label: 'Item 2' }])
  })

  it('a guard condition gates the action', () => {
    let ir = authorAppend()
    ir = setCondition(ir, 'i1', 'items.length < 1') // only allow the first append
    const it = ir.interactions.find((x) => x.id === 'i1')!
    let rt = initRuntime(ir)
    rt = runInteraction(ir, rt, it, buildEnv(ir, rt))
    rt = runInteraction(ir, rt, it, buildEnv(ir, rt)) // blocked: length already 1
    expect(rt.store.items).toEqual([{ label: 'Item 1' }])
  })
})

describe('editable state — value + type reducers', () => {
  it('setVariableValue sets the initial seed', () => {
    let ir = addVariable(emptyPageInteractions(), makeScalarVariable('name', 'string', ''))
    ir = setVariableValue(ir, 'name', 'Ada')
    expect(ir.variables[0].initial).toBe('Ada')
  })

  it('setVariableType coerces the initial to that type’s default', () => {
    let ir = addVariable(emptyPageInteractions(), makeScalarVariable('x', 'string', 'hi'))
    ir = setVariableType(ir, 'x', 'number')
    expect(ir.variables[0]).toMatchObject({ type: 'number', initial: 0 })
    ir = setVariableType(ir, 'x', 'boolean')
    expect(ir.variables[0]).toMatchObject({ type: 'boolean', initial: false })
    ir = setVariableType(ir, 'x', { collection: 'object' })
    expect(ir.variables[0]).toMatchObject({ type: { collection: 'object' }, initial: [] })
  })

  it('defaultInitial gives a sensible empty per type', () => {
    expect(defaultInitial('number')).toBe(0)
    expect(defaultInitial('boolean')).toBe(false)
    expect(defaultInitial('string')).toBe('')
    expect(defaultInitial({ collection: 'object' })).toEqual([])
  })
})

describe('derived reducers', () => {
  it('add / setExpr / remove a formula; ids stay unique vs vars and other derived', () => {
    let ir = addVariable(emptyPageInteractions(), makeCollectionVariable('items'))
    ir = addDerived(ir, 'count', 'items.length')
    expect(ir.derived).toEqual([{ id: 'count', expr: 'items.length' }])
    ir = addDerived(ir, 'count', 'x') // duplicate derived id ignored
    ir = addDerived(ir, 'items', 'x') // collides with a variable id, ignored
    expect(ir.derived).toHaveLength(1)
    ir = setDerivedExpr(ir, 'count', 'items.length + 1')
    expect(ir.derived[0].expr).toBe('items.length + 1')
    ir = removeDerived(ir, 'count')
    expect(ir.derived).toHaveLength(0)
  })
})

describe('editable state + derived run in the runtime', () => {
  it('seeds the store from edited initials and computes derived formulas', () => {
    let ir = addVariable(emptyPageInteractions(), makeScalarVariable('greeting', 'string', ''))
    ir = setVariableValue(ir, 'greeting', 'hi')
    ir = addVariable(ir, makeCollectionVariable('items'))
    ir = setVariableValue(ir, 'items', [{ label: 'a' }, { label: 'b' }])
    ir = addDerived(ir, 'count', 'items.length')
    ir = addDerived(ir, 'isEmpty', 'items.length == 0')
    const rt = initRuntime(ir)
    expect(rt.store.greeting).toBe('hi')
    const env = buildEnv(ir, rt)
    expect(env.count).toBe(2)
    expect(env.isEmpty).toBe(false)
  })
})

describe('repeater reducers', () => {
  it('setRepeater upserts one repeater per node, merging patches', () => {
    let ir = setRepeater(emptyPageInteractions(), 'row', { over: 'items' })
    expect(ir.repeaters).toEqual([{ node: 'row', over: 'items' }])
    ir = setRepeater(ir, 'row', { as: 'todo' }) // merge keeps `over`
    expect(ir.repeaters).toEqual([{ node: 'row', over: 'items', as: 'todo' }])
    ir = setRepeater(ir, 'row', { over: 'tasks' }) // still one, replaces `over`
    expect(ir.repeaters).toHaveLength(1)
    expect(ir.repeaters[0]).toMatchObject({ node: 'row', over: 'tasks', as: 'todo' })
  })

  it('setRepeater clears an optional field with an empty string', () => {
    let ir = setRepeater(emptyPageInteractions(), 'row', { over: 'items', as: 'item', key: 'item.id' })
    expect(ir.repeaters[0]).toEqual({ node: 'row', over: 'items', as: 'item', key: 'item.id' })
    ir = setRepeater(ir, 'row', { key: '' })
    expect(ir.repeaters[0]).toEqual({ node: 'row', over: 'items', as: 'item' })
  })

  it('clearRepeater removes only the targeted node’s repeater', () => {
    let ir = setRepeater(emptyPageInteractions(), 'row', { over: 'items' })
    ir = setRepeater(ir, 'card', { over: 'cards' })
    ir = clearRepeater(ir, 'row')
    expect(ir.repeaters).toEqual([{ node: 'card', over: 'cards' }])
  })

  it('moveRepeater retargets the template node, preserving over/as/key', () => {
    let ir = setRepeater(emptyPageInteractions(), 'rowA', { over: 'items', as: 'todo', key: 'todo.id' })
    ir = moveRepeater(ir, 'rowA', 'rowB') // container picks a different template child
    expect(ir.repeaters).toEqual([{ node: 'rowB', over: 'items', as: 'todo', key: 'todo.id' }])
    expect(moveRepeater(ir, 'rowB', 'rowB')).toBe(ir) // no-op when same
    expect(moveRepeater(ir, 'ghost', 'rowC')).toBe(ir) // no-op when source has no repeater
  })
})

describe('binding reducers', () => {
  it('add / edit / remove bindings addressed by (node, occurrence)', () => {
    let ir = addBinding(emptyPageInteractions(), 'row', 'text', 'item.label')
    ir = addBinding(ir, 'row', 'visible', 'item.done')
    expect(ir.bindings).toHaveLength(2)
    ir = setBindingProp(ir, 'row', 1, 'disabled')
    ir = setBindingFrom(ir, 'row', 0, 'item.title')
    expect(ir.bindings).toEqual([
      { node: 'row', prop: 'text', from: 'item.title' },
      { node: 'row', prop: 'disabled', from: 'item.done' },
    ])
    ir = removeBinding(ir, 'row', 0)
    expect(ir.bindings).toEqual([{ node: 'row', prop: 'disabled', from: 'item.done' }])
  })

  it('occurrence is per-node, not the global binding index', () => {
    let ir = addBinding(emptyPageInteractions(), 'a', 'text', 'x')
    ir = addBinding(ir, 'b', 'text', 'y') // interleaved node
    ir = addBinding(ir, 'a', 'visible', 'z')
    ir = setBindingFrom(ir, 'a', 1, 'zz') // occurrence 1 of node 'a' = the visible binding
    expect(ir.bindings.find((b) => b.node === 'a' && b.prop === 'visible')!.from).toBe('zz')
    expect(ir.bindings.find((b) => b.node === 'b')!.from).toBe('y') // untouched
  })
})

/**
 * Scaffold parity — author the exact IR the devtools console block builds (a list
 * variable + a repeater + a text binding + an append interaction) using only the
 * inspector reducers, then drive the repeater/binding the same way the runtime
 * does and assert the rendered rows. This is the proof the console scaffold is
 * no longer needed.
 */
describe('scaffold parity — repeater + binding authored via reducers', () => {
  function authorTodoList() {
    let ir = addVariable(emptyPageInteractions(), makeCollectionVariable('items'))
    ir = setRepeater(ir, 'row', { over: 'items', as: 'item' })
    ir = addBinding(ir, 'row', 'text', 'item.label')
    ir = addInteraction(ir, 'addBtn', 'i1')
    ir = addAction(ir, 'i1', 'collection.append')
    ir = setActionTarget(ir, 'i1', 0, 'items')
    ir = setActionValue(ir, 'i1', 0, '{ label: "Item " + (items.length + 1) }')
    return ir
  }

  it('produces the same IR shape as the hand-written scaffold', () => {
    const ir = authorTodoList()
    expect(ir.repeaters).toEqual([{ node: 'row', over: 'items', as: 'item' }])
    expect(ir.bindings).toEqual([{ node: 'row', prop: 'text', from: 'item.label' }])
    expect(ir.variables[0]).toMatchObject({ id: 'items', type: { collection: 'object' } })
  })

  it('renders one bound row per appended item (runtime data path)', () => {
    const ir = authorTodoList()
    const append = ir.interactions.find((x) => x.id === 'i1')!
    let rt = initRuntime(ir)
    rt = runInteraction(ir, rt, append, buildEnv(ir, rt))
    rt = runInteraction(ir, rt, append, buildEnv(ir, rt))

    // Mirror InteractionRuntime.renderNode: evaluate the repeater's collection,
    // then the binding expression in each item's scope.
    const env = buildEnv(ir, rt)
    const rep = ir.repeaters[0]
    const binding = ir.bindings.find((b) => b.node === rep.node && b.prop === 'text')!
    const coll = evaluate(parse(rep.over), env) as unknown[]
    const rows = coll.map((item) => evaluate(parse(binding.from), { ...env, [rep.as ?? 'item']: item }))

    expect(rows).toEqual(['Item 1', 'Item 2'])
  })
})
