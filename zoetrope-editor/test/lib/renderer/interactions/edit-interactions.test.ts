import { describe, it, expect } from 'vitest'
import { emptyPageInteractions, REPEAT_PROP } from '../../../../src/lib/renderer/interactions/ir'
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
  setActionParam,
  addCell,
  removeCell,
  makeListCell,
  makeCell,
  makeFormula,
  makeVariantCell,
  defaultInitial,
  setCellValue,
  setCellType,
  setCellFormula,
  setVariantValues,
  toCellId,
  setRepeat,
  clearRepeat,
  moveRepeat,
  setRef,
  getRef,
  clearRef,
  moveRef,
} from '../../../../src/lib/renderer/interactions/document/edit-interactions'
import { initRuntime, buildEnv, runInteraction, repeatOf } from '../../../../src/lib/renderer/interactions/preview/runtime'
import { evaluate } from '../../../../src/lib/renderer/interactions/expression'
import { namesOf } from '../../../../src/lib/renderer/interactions/expr'
import { ex, text, txt } from './todo-ir'

/** Author the canonical "Add → append a numbered row" interaction via reducers. */
function authorAppend() {
  let ir = addCell(emptyPageInteractions(), makeListCell('items'))
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
    expect(txt(ir, ir.interactions[0].if)).toBe('items.length < 10')
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
    expect(text(ir).interactions[0].do[0]).toEqual({ type: 'collection.append', target: 'items', value: '42' })
    ir = removeAction(ir, 'i1', 0)
    expect(ir.interactions[0].do).toHaveLength(0)
  })

  it('removeInteraction reverses an add (in-panel undo)', () => {
    let ir = addInteraction(emptyPageInteractions(), 'btn', 'i1')
    ir = removeInteraction(ir, 'i1')
    expect(ir.interactions).toHaveLength(0)
  })

  it('addCell is reference-idempotent; removeCell drops it', () => {
    let ir = addCell(emptyPageInteractions(), makeListCell('items'))
    ir = addCell(ir, makeCell('items')) // same reference ignored
    expect(ir.cells).toHaveLength(1)
    expect(ir.cells[0].type).toEqual({ collection: 'object' })
    ir = removeCell(ir, 'items')
    expect(ir.cells).toHaveLength(0)
  })

  it("a node's cell shares an id with a page cell without colliding — its reference is <node>.<id>", () => {
    let ir = addCell(emptyPageInteractions(), makeCell('state', 'string', 'idle'))
    ir = addCell(ir, makeVariantCell('card', 'state', ['closed', 'open']))
    expect(ir.cells).toHaveLength(2)
    ir = removeCell(ir, 'card.state')
    expect(ir.cells.map((c) => c.id)).toEqual(['state'])
  })

  it('toCellId sanitizes user text', () => {
    expect(toCellId('  my list ')).toBe('my_list')
    expect(toCellId('1st')).toBe('_1st')
    expect(toCellId('!!!')).toBe('___')
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

describe('cell value + type reducers', () => {
  it('setCellValue sets the initial seed', () => {
    let ir = addCell(emptyPageInteractions(), makeCell('name', 'string', ''))
    ir = setCellValue(ir, 'name', 'Ada')
    expect(ir.cells[0].initial).toBe('Ada')
  })

  it('setCellType coerces the initial to that type’s default', () => {
    let ir = addCell(emptyPageInteractions(), makeCell('x', 'string', 'hi'))
    ir = setCellType(ir, 'x', 'number')
    expect(ir.cells[0]).toMatchObject({ type: 'number', initial: 0 })
    ir = setCellType(ir, 'x', 'boolean')
    expect(ir.cells[0]).toMatchObject({ type: 'boolean', initial: false })
    ir = setCellType(ir, 'x', { collection: 'object' })
    expect(ir.cells[0]).toMatchObject({ type: { collection: 'object' }, initial: [] })
  })

  it('defaultInitial gives a sensible empty per type', () => {
    expect(defaultInitial('number')).toBe(0)
    expect(defaultInitial('boolean')).toBe(false)
    expect(defaultInitial('string')).toBe('')
    expect(defaultInitial({ collection: 'object' })).toEqual([])
    expect(defaultInitial({ enum: ['a', 'b'] })).toBe('a')
  })

  it('setVariantValues keeps a still-valid initial and resets one that vanished', () => {
    let ir = addCell(emptyPageInteractions(), makeVariantCell('card', 'state', ['closed', 'open']))
    ir = setCellValue(ir, 'card.state', 'open')
    ir = setVariantValues(ir, 'card.state', ['open', 'closed', 'pinned'])
    expect(ir.cells[0]).toMatchObject({ type: { enum: ['open', 'closed', 'pinned'] }, initial: 'open' })
    ir = setVariantValues(ir, 'card.state', ['a', 'b'])
    expect(ir.cells[0].initial).toBe('a')
  })
})

describe('formula reducers', () => {
  it('add / setFormula / remove a formula; references stay unique across every cell', () => {
    let ir = addCell(emptyPageInteractions(), makeListCell('items'))
    ir = addCell(ir, makeFormula('count', ex(ir, 'items.length')))
    expect(ir.cells[1]).toMatchObject({ id: 'count' })
    expect(txt(ir, ir.cells[1].formula)).toBe('items.length')
    ir = addCell(ir, makeFormula('count')) // duplicate ignored
    ir = addCell(ir, makeFormula('items')) // collides with a value, ignored
    expect(ir.cells).toHaveLength(2)
    ir = setCellFormula(ir, 'count', 'items.length + 1')
    expect(txt(ir, ir.cells[1].formula)).toBe('items.length + 1')
    ir = setCellFormula(ir, 'count', '  ') // blank makes it a plain value again
    expect(ir.cells[1]).not.toHaveProperty('formula')
    ir = removeCell(ir, 'count')
    expect(ir.cells).toHaveLength(1)
  })
})

describe('cells and formulas run in the runtime', () => {
  it('seeds the store from edited initials and computes formulas', () => {
    let ir = addCell(emptyPageInteractions(), makeCell('greeting', 'string', ''))
    ir = setCellValue(ir, 'greeting', 'hi')
    ir = addCell(ir, makeListCell('items'))
    ir = setCellValue(ir, 'items', [{ label: 'a' }, { label: 'b' }])
    ir = addCell(ir, makeFormula('count', ex(ir, 'items.length')))
    ir = addCell(ir, makeFormula('isEmpty', ex(ir, 'items.length == 0')))
    const rt = initRuntime(ir)
    expect(rt.store.greeting).toBe('hi')
    const env = buildEnv(ir, rt)
    expect(env.count).toBe(2)
    expect(env.isEmpty).toBe(false)
  })
})

describe('repeat reducers', () => {
  it('setRepeat upserts one repeat reference per node, merging patches', () => {
    let ir = setRepeat(emptyPageInteractions(), 'row', { over: 'items' })
    expect(text(ir).refs).toEqual([{ node: 'row', props: { repeat: 'items' } }])
    ir = setRepeat(ir, 'row', { as: 'todo' }) // merge keeps `over`
    expect(text(ir).refs).toEqual([{ node: 'row', props: { repeat: 'items' }, item: { as: 'todo' } }])
    ir = setRepeat(ir, 'row', { over: 'tasks' }) // still one, replaces `over`
    expect(ir.refs).toHaveLength(1)
    expect(text(ir).refs[0]).toMatchObject({ node: 'row', props: { repeat: 'tasks' }, item: { as: 'todo' } })
  })

  it('setRepeat clears an optional field with an empty string', () => {
    let ir = setRepeat(emptyPageInteractions(), 'row', { over: 'items', as: 'item', key: 'item.id' })
    expect(text(ir).refs[0]).toEqual({ node: 'row', props: { repeat: 'items' }, item: { as: 'item', key: 'item.id' } })
    // the key resolved against the loop variable, not a page cell
    expect(ir.refs[0].item?.key).toMatchObject({ type: 'member', object: { type: 'ref', ref: { kind: 'item', name: 'item' } } })
    ir = setRepeat(ir, 'row', { key: '' })
    expect(text(ir).refs[0]).toEqual({ node: 'row', props: { repeat: 'items' }, item: { as: 'item' } })
  })

  it('clearRepeat removes only the targeted node’s repeat, and its loop settings with it', () => {
    let ir = setRepeat(emptyPageInteractions(), 'row', { over: 'items', as: 'todo' })
    ir = setRef(ir, 'row', 'text', 'todo.label')
    ir = setRepeat(ir, 'card', { over: 'cards' })
    ir = clearRepeat(ir, 'row')
    expect(text(ir).refs.find((r) => r.node === 'row')).toEqual({ node: 'row', props: { text: 'todo.label' } })
    expect(text(ir).refs.find((r) => r.node === 'card')).toEqual({ node: 'card', props: { repeat: 'cards' } })
  })

  it('moveRepeat retargets the template node, preserving over/as/key', () => {
    let ir = setRepeat(emptyPageInteractions(), 'rowA', { over: 'items', as: 'todo', key: 'todo.id' })
    ir = moveRepeat(ir, 'rowA', 'rowB') // container picks a different template child
    expect(text(ir).refs).toEqual([{ node: 'rowB', props: { repeat: 'items' }, item: { as: 'todo', key: 'todo.id' } }])
    expect(moveRepeat(ir, 'rowB', 'rowB')).toBe(ir) // no-op when same
    expect(moveRepeat(ir, 'ghost', 'rowC')).toBe(ir) // no-op when source has no repeat
  })
})

describe('property reference reducers', () => {
  it('set / read / move / clear the reference on (node, prop)', () => {
    let ir = setRef(emptyPageInteractions(), 'row', 'text', 'item.label')
    ir = setRef(ir, 'row', 'visible', 'item.done')
    expect(text(ir).refs[0].props).toEqual({ text: 'item.label', visible: 'item.done' })
    ir = moveRef(ir, 'row', 'visible', 'disabled')
    ir = setRef(ir, 'row', 'text', 'item.title')
    expect(text(ir).refs[0].props).toEqual({ text: 'item.title', disabled: 'item.done' })
    ir = clearRef(ir, 'row', 'text')
    expect(getRef(ir, 'row', 'text')).toBeUndefined()
    expect(text(ir).refs[0].props).toEqual({ disabled: 'item.done' })
  })

  it('keeps one block per node, and drops a block that empties out', () => {
    let ir = setRef(emptyPageInteractions(), 'a', 'text', 'x')
    ir = setRef(ir, 'b', 'text', 'y') // interleaved node
    ir = setRef(ir, 'a', 'visible', 'z')
    expect(ir.refs).toHaveLength(2)
    ir = clearRef(ir, 'a', 'text')
    ir = clearRef(ir, 'a', 'visible')
    expect(ir.refs.map((r) => r.node)).toEqual(['b'])
    expect(txt(ir, getRef(ir, 'b', 'text'))).toBe('y') // untouched
  })

  it('a reference on a repeated node coexists with its repeat', () => {
    let ir = setRepeat(emptyPageInteractions(), 'row', { over: 'items' })
    ir = setRef(ir, 'row', 'background', 'accent')
    expect(txt(ir, getRef(ir, 'row', REPEAT_PROP))).toBe('items')
    expect(txt(ir, getRef(ir, 'row', 'background'))).toBe('accent')
    ir = setRef(ir, 'row', 'background', 'theme.bg') // updates, no duplicate
    expect(ir.refs).toHaveLength(1)
    expect(txt(ir, getRef(ir, 'row', 'background'))).toBe('theme.bg')
  })
})

/**
 * Scaffold parity — author the exact IR the devtools console block builds (a list
 * cell + a repeat + a text reference + an append interaction) using only the
 * inspector reducers, then drive the repeat/reference the same way the runtime
 * does and assert the rendered rows. This is the proof the console scaffold is
 * no longer needed.
 */
describe('scaffold parity — repeat + reference authored via reducers', () => {
  function authorTodoList() {
    let ir = addCell(emptyPageInteractions(), makeListCell('items'))
    ir = setRepeat(ir, 'row', { over: 'items', as: 'item' })
    ir = setRef(ir, 'row', 'text', 'item.label')
    ir = addInteraction(ir, 'addBtn', 'i1')
    ir = addAction(ir, 'i1', 'collection.append')
    ir = setActionTarget(ir, 'i1', 0, 'items')
    ir = setActionValue(ir, 'i1', 0, '{ label: "Item " + (items.length + 1) }')
    return ir
  }

  it('produces the same IR shape as the hand-written scaffold', () => {
    const ir = authorTodoList()
    expect(text(ir).refs).toEqual([{ node: 'row', props: { repeat: 'items', text: 'item.label' }, item: { as: 'item' } }])
    expect(ir.cells[0]).toMatchObject({ id: 'items', type: { collection: 'object' } })
  })

  it('renders one referenced row per appended item (runtime data path)', () => {
    const ir = authorTodoList()
    const append = ir.interactions.find((x) => x.id === 'i1')!
    let rt = initRuntime(ir)
    rt = runInteraction(ir, rt, append, buildEnv(ir, rt))
    rt = runInteraction(ir, rt, append, buildEnv(ir, rt))

    // Mirror InteractionRuntime.renderNode: evaluate the repeated list, then the
    // referenced expression in each item's scope.
    const env = buildEnv(ir, rt)
    const rep = repeatOf(ir, 'row')!
    const textRef = getRef(ir, 'row', 'text')!
    const coll = evaluate(namesOf(rep.over, ir), env) as unknown[]
    const rows = coll.map((item) => evaluate(namesOf(textRef, ir), { ...env, [rep.as]: item }))

    expect(rows).toEqual(['Item 1', 'Item 2'])
  })
})

describe('setActionParam — extra expression params (where / at)', () => {
  /** An interaction with one `collection.update` action to hang params on. */
  function authorUpdate() {
    let ir = addCell(emptyPageInteractions(), makeListCell('items'))
    ir = addInteraction(ir, 'saveBtn', 'i1')
    ir = addAction(ir, 'i1', 'collection.update')
    ir = setActionTarget(ir, 'i1', 0, 'items')
    return ir
  }
  const actionOf = (ir: ReturnType<typeof authorUpdate>) => ir.interactions.find((x) => x.id === 'i1')!.do[0]

  it('sets a param', () => {
    const ir = setActionParam(authorUpdate(), 'i1', 0, 'where', 'item.id == 2')
    expect(text(ir).interactions[0].do[0].params).toEqual({ where: 'item.id == 2' })
  })

  it('keeps params independent of each other', () => {
    let ir = setActionParam(authorUpdate(), 'i1', 0, 'where', 'item.id == 2')
    ir = setActionParam(ir, 'i1', 0, 'at', '1')
    expect(text(ir).interactions[0].do[0].params).toEqual({ where: 'item.id == 2', at: '1' })
  })

  it('clearing the last param drops `params` entirely, keeping the IR minimal', () => {
    let ir = setActionParam(authorUpdate(), 'i1', 0, 'where', 'item.id == 2')
    ir = setActionParam(ir, 'i1', 0, 'where', '  ')
    expect(actionOf(ir).params).toBeUndefined()
  })

  it('does not mutate the input IR', () => {
    const before = authorUpdate()
    const after = setActionParam(before, 'i1', 0, 'where', 'item.id == 2')
    expect(actionOf(before).params).toBeUndefined()
    expect(after).not.toBe(before)
  })

  it('changing the action type clears params along with target and value', () => {
    let ir = setActionParam(authorUpdate(), 'i1', 0, 'where', 'item.id == 2')
    ir = setActionType(ir, 'i1', 0, 'collection.clear')
    expect(actionOf(ir)).toEqual({ type: 'collection.clear' })
  })
})
