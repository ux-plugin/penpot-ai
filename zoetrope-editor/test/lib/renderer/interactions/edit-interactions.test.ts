/**
 * The inspector's behaviour edits, end to end: each edit builds changes against
 * the page's live behaviour, is committed to the document, and is read back
 * with `live()`. The authored records are then run through the preview runtime.
 */
import { beforeEach, describe, it, expect } from 'vitest'
import type { Behaviour, Rule } from '../../../../src/lib/renderer/interactions/ir'
import { findCell, REPEAT_PROP } from '../../../../src/lib/renderer/interactions/ir'
import {
  addRule,
  removeRule,
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
  pageHome,
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
import { initRuntime, buildEnv, runRule, repeatOf } from '../../../../src/lib/renderer/interactions/preview/runtime'
import { evaluate } from '../../../../src/lib/renderer/interactions/expression'
import { namesOf } from '../../../../src/lib/renderer/interactions/expr'
import type { LocalChange } from '../../../../src/lib/doc'
import { commit, ex, live, PAGE, seedPage, text, txt } from './behaviour-fixtures'

const NODES = ['btn', 'addBtn', 'saveBtn', 'row', 'rowA', 'rowB', 'card', 'a', 'b']

const HOME = pageHome(PAGE)

beforeEach(() => seedPage(NODES))

/** Build an edit against the live behaviour and commit it. */
async function edit(fn: (b: Behaviour) => readonly LocalChange[]): Promise<void> {
  await commit(fn(live()))
}

const ruleOf = (id: string): Rule => live().rules.find((r) => r.id === id)!
const cellOf = (ref: string) => findCell(live(), ref)!

/** Author the canonical "Add → append a numbered row" rule through the edits. */
async function authorAppend(): Promise<void> {
  await edit((b) => addCell(b, makeListCell('items', HOME, 'items')))
  await edit((b) => addRule(b, 'addBtn', 'i1'))
  await edit((b) => addAction(b, 'i1', 'collection.append'))
  await edit((b) => setActionTarget(b, 'i1', 0, 'items'))
  await edit((b) => setActionValue(b, 'i1', 0, '{ label: "Item " + (items.length + 1) }'))
}

describe('edit-interactions change builders', () => {
  it('addRule adds a press rule on the node, and only once committed', async () => {
    const changes = addRule(live(), 'btn', 'i1')
    expect(live().rules).toHaveLength(0)
    await commit(changes)
    expect(live().rules).toHaveLength(1)
    expect(live().rules[0]).toMatchObject({ id: 'i1', page: PAGE, node: 'btn', on: { type: 'press' }, do: [] })
  })

  it('setTrigger changes the trigger type', async () => {
    await edit((b) => addRule(b, 'btn', 'i1'))
    await edit((b) => setTrigger(b, 'i1', 'mouse-enter'))
    expect(ruleOf('i1').on.type).toBe('mouse-enter')
  })

  it('setCondition sets and clears the guard', async () => {
    await edit((b) => addRule(b, 'btn', 'i1'))
    await edit((b) => setCondition(b, 'i1', 'items.length < 10'))
    expect(txt(live(), ruleOf('i1').if)).toBe('items.length < 10')
    await edit((b) => setCondition(b, 'i1', '   '))
    expect(ruleOf('i1').if).toBeUndefined()
  })

  it('action add/type/target/value/remove edit do[] correctly', async () => {
    await edit((b) => addRule(b, 'btn', 'i1'))
    await edit((b) => addAction(b, 'i1'))
    expect(ruleOf('i1').do[0].type).toBe('set-variable')
    await edit((b) => setActionType(b, 'i1', 0, 'collection.append'))
    expect(ruleOf('i1').do[0]).toEqual({ type: 'collection.append' })
    await edit((b) => setActionTarget(b, 'i1', 0, 'items'))
    await edit((b) => setActionValue(b, 'i1', 0, '42'))
    expect(text(live()).rules[0].do[0]).toEqual({ type: 'collection.append', target: 'items', value: '42' })
    await edit((b) => removeAction(b, 'i1', 0))
    expect(ruleOf('i1').do).toHaveLength(0)
  })

  it('removeRule reverses an add', async () => {
    await edit((b) => addRule(b, 'btn', 'i1'))
    await commit(removeRule('i1'))
    expect(live().rules).toHaveLength(0)
  })

  it('addCell is reference-idempotent; removeCell drops it', async () => {
    await edit((b) => addCell(b, makeListCell('items', HOME, 'items')))
    expect(addCell(live(), makeCell('items'))).toEqual([])
    expect(live().cells).toHaveLength(1)
    expect(live().cells[0].type).toEqual({ collection: 'object' })
    await edit((b) => removeCell(b, 'items'))
    expect(live().cells).toHaveLength(0)
  })

  it("a node's cell shares a name with a page cell without colliding — its reference is <node>.<name>", async () => {
    await edit((b) => addCell(b, makeCell('state', 'string', 'idle', HOME, 'state')))
    await edit((b) => addCell(b, makeVariantCell(PAGE, 'card', 'state', ['closed', 'open'], 'card.state')))
    expect(live().cells).toHaveLength(2)
    await edit((b) => removeCell(b, 'card.state'))
    expect(live().cells.map((c) => c.id)).toEqual(['state'])
  })

  it('toCellId sanitizes user text', () => {
    expect(toCellId('  my list ')).toBe('my_list')
    expect(toCellId('1st')).toBe('_1st')
    expect(toCellId('!!!')).toBe('___')
  })
})

describe('authored behaviour actually runs in the runtime', () => {
  it('press → append yields numbered rows on repeated fire', async () => {
    await authorAppend()
    const b = live()
    const rule = ruleOf('i1')
    let rt = initRuntime(b)
    expect(rt.store.items).toEqual([])
    rt = runRule(b, rt, rule, buildEnv(b, rt))
    expect(rt.store.items).toEqual([{ label: 'Item 1' }])
    rt = runRule(b, rt, rule, buildEnv(b, rt))
    expect(rt.store.items).toEqual([{ label: 'Item 1' }, { label: 'Item 2' }])
  })

  it('a guard condition gates the action', async () => {
    await authorAppend()
    await edit((b) => setCondition(b, 'i1', 'items.length < 1'))
    const b = live()
    const rule = ruleOf('i1')
    let rt = initRuntime(b)
    rt = runRule(b, rt, rule, buildEnv(b, rt))
    rt = runRule(b, rt, rule, buildEnv(b, rt))
    expect(rt.store.items).toEqual([{ label: 'Item 1' }])
  })
})

describe('cell value + type edits', () => {
  it('setCellValue sets the initial seed', async () => {
    await edit((b) => addCell(b, makeCell('name', 'string', '', HOME, 'name')))
    await edit((b) => setCellValue(b, 'name', 'Ada'))
    expect(cellOf('name').initial).toBe('Ada')
  })

  it('setCellType coerces the initial to that type’s default', async () => {
    await edit((b) => addCell(b, makeCell('x', 'string', 'hi', HOME, 'x')))
    await edit((b) => setCellType(b, 'x', 'number'))
    expect(cellOf('x')).toMatchObject({ type: 'number', initial: 0 })
    await edit((b) => setCellType(b, 'x', 'boolean'))
    expect(cellOf('x')).toMatchObject({ type: 'boolean', initial: false })
    await edit((b) => setCellType(b, 'x', { collection: 'object' }))
    expect(cellOf('x')).toMatchObject({ type: { collection: 'object' }, initial: [] })
  })

  it('defaultInitial gives a sensible empty per type', () => {
    expect(defaultInitial('number')).toBe(0)
    expect(defaultInitial('boolean')).toBe(false)
    expect(defaultInitial('string')).toBe('')
    expect(defaultInitial({ collection: 'object' })).toEqual([])
    expect(defaultInitial({ enum: ['a', 'b'] })).toBe('a')
  })

  it('setVariantValues keeps a still-valid initial and resets one that vanished', async () => {
    await edit((b) => addCell(b, makeVariantCell(PAGE, 'card', 'state', ['closed', 'open'], 'card.state')))
    await edit((b) => setCellValue(b, 'card.state', 'open'))
    await edit((b) => setVariantValues(b, 'card.state', ['open', 'closed', 'pinned']))
    expect(cellOf('card.state')).toMatchObject({ type: { enum: ['open', 'closed', 'pinned'] }, initial: 'open' })
    await edit((b) => setVariantValues(b, 'card.state', ['a', 'b']))
    expect(cellOf('card.state').initial).toBe('a')
  })
})

describe('formula edits', () => {
  it('add / setFormula / remove a formula; references stay unique across every cell', async () => {
    await edit((b) => addCell(b, makeListCell('items', HOME, 'items')))
    await edit((b) => addCell(b, makeFormula('count', ex(b, 'items.length'), HOME, 'count')))
    expect(cellOf('count')).toMatchObject({ name: 'count' })
    expect(txt(live(), cellOf('count').formula)).toBe('items.length')
    expect(addCell(live(), makeFormula('count', undefined, HOME))).toEqual([])
    expect(addCell(live(), makeFormula('items', undefined, HOME))).toEqual([])
    expect(live().cells).toHaveLength(2)
    await edit((b) => setCellFormula(b, 'count', 'items.length + 1'))
    expect(txt(live(), cellOf('count').formula)).toBe('items.length + 1')
    await edit((b) => setCellFormula(b, 'count', '  '))
    expect(cellOf('count')).not.toHaveProperty('formula')
    await edit((b) => removeCell(b, 'count'))
    expect(live().cells).toHaveLength(1)
  })
})

describe('cells and formulas run in the runtime', () => {
  it('seeds the store from edited initials and computes formulas', async () => {
    await edit((b) => addCell(b, makeCell('greeting', 'string', '', HOME, 'greeting')))
    await edit((b) => setCellValue(b, 'greeting', 'hi'))
    await edit((b) => addCell(b, makeListCell('items', HOME, 'items')))
    await edit((b) => setCellValue(b, 'items', [{ label: 'a' }, { label: 'b' }]))
    await edit((b) => addCell(b, makeFormula('count', ex(b, 'items.length'), HOME, 'count')))
    await edit((b) => addCell(b, makeFormula('isEmpty', ex(b, 'items.length == 0'), HOME, 'isEmpty')))
    const b = live()
    const rt = initRuntime(b)
    expect(rt.store.greeting).toBe('hi')
    const env = buildEnv(b, rt)
    expect(env.count).toBe(2)
    expect(env.isEmpty).toBe(false)
  })
})

describe('repeat edits', () => {
  it('setRepeat upserts one repeat binding per node, merging patches', async () => {
    await edit((b) => setRepeat(b, 'row', { over: 'items' }))
    expect(text(live()).bindings).toEqual([{ node: 'row', prop: 'repeat', expr: 'items' }])
    await edit((b) => setRepeat(b, 'row', { as: 'todo' }))
    expect(text(live()).bindings).toEqual([{ node: 'row', prop: 'repeat', expr: 'items', item: { as: 'todo' } }])
    await edit((b) => setRepeat(b, 'row', { over: 'tasks' }))
    expect(live().bindings).toHaveLength(1)
    expect(text(live()).bindings[0]).toMatchObject({ node: 'row', prop: 'repeat', expr: 'tasks', item: { as: 'todo' } })
  })

  it('setRepeat clears an optional field with an empty string', async () => {
    await edit((b) => setRepeat(b, 'row', { over: 'items', as: 'item', key: 'item.id' }))
    expect(text(live()).bindings[0]).toEqual({ node: 'row', prop: 'repeat', expr: 'items', item: { as: 'item', key: 'item.id' } })
    expect(live().bindings[0].item?.key).toMatchObject({ type: 'member', object: { type: 'ref', ref: { kind: 'item', name: 'item' } } })
    await edit((b) => setRepeat(b, 'row', { key: '' }))
    expect(text(live()).bindings[0]).toEqual({ node: 'row', prop: 'repeat', expr: 'items', item: { as: 'item' } })
  })

  it('clearRepeat removes only the targeted node’s repeat, and its loop settings with it', async () => {
    await edit((b) => setRepeat(b, 'row', { over: 'items', as: 'todo' }))
    await edit((b) => setRef(b, 'row', 'text', 'todo.label'))
    await edit((b) => setRepeat(b, 'card', { over: 'cards' }))
    await edit((b) => clearRepeat(b, 'row'))
    expect(text(live()).bindings).toEqual([
      { node: 'card', prop: 'repeat', expr: 'cards' },
      { node: 'row', prop: 'text', expr: 'todo.label' },
    ])
  })

  it('moveRepeat retargets the template node, preserving over/as/key', async () => {
    await edit((b) => setRepeat(b, 'rowA', { over: 'items', as: 'todo', key: 'todo.id' }))
    await edit((b) => moveRepeat(b, 'rowA', 'rowB'))
    expect(text(live()).bindings).toEqual([{ node: 'rowB', prop: 'repeat', expr: 'items', item: { as: 'todo', key: 'todo.id' } }])
    expect(moveRepeat(live(), 'rowB', 'rowB')).toEqual([])
    expect(moveRepeat(live(), 'ghost', 'rowA')).toEqual([])
  })
})

describe('property binding edits', () => {
  const propsOf = (node: string) =>
    Object.fromEntries(text(live()).bindings.filter((x) => x.node === node).map((x) => [x.prop, x.expr]))

  it('set / read / move / clear the binding on (node, prop)', async () => {
    await edit((b) => setRef(b, 'row', 'text', 'item.label'))
    await edit((b) => setRef(b, 'row', 'visible', 'item.done'))
    expect(propsOf('row')).toEqual({ text: 'item.label', visible: 'item.done' })
    await edit((b) => moveRef(b, 'row', 'visible', 'disabled'))
    await edit((b) => setRef(b, 'row', 'text', 'item.title'))
    expect(propsOf('row')).toEqual({ text: 'item.title', disabled: 'item.done' })
    await edit((b) => clearRef(b, 'row', 'text'))
    expect(getRef(live(), 'row', 'text')).toBeUndefined()
    expect(propsOf('row')).toEqual({ disabled: 'item.done' })
  })

  it('keeps one binding per (node, prop), and clearing a node’s last one leaves it unbound', async () => {
    await edit((b) => setRef(b, 'a', 'text', 'x'))
    await edit((b) => setRef(b, 'b', 'text', 'y'))
    await edit((b) => setRef(b, 'a', 'visible', 'z'))
    expect(live().bindings).toHaveLength(3)
    await edit((b) => clearRef(b, 'a', 'text'))
    await edit((b) => clearRef(b, 'a', 'visible'))
    expect(live().bindings.map((x) => x.node)).toEqual(['b'])
    expect(txt(live(), getRef(live(), 'b', 'text'))).toBe('y')
  })

  it('a binding on a repeated node coexists with its repeat', async () => {
    await edit((b) => setRepeat(b, 'row', { over: 'items' }))
    await edit((b) => setRef(b, 'row', 'background', 'accent'))
    expect(txt(live(), getRef(live(), 'row', REPEAT_PROP))).toBe('items')
    expect(txt(live(), getRef(live(), 'row', 'background'))).toBe('accent')
    await edit((b) => setRef(b, 'row', 'background', 'theme.bg'))
    expect(live().bindings).toHaveLength(2)
    expect(txt(live(), getRef(live(), 'row', 'background'))).toBe('theme.bg')
  })
})

/**
 * Scaffold parity — author a list cell, a repeat, a text binding and an append
 * rule using only the inspector edits, then drive the repeat/binding the way
 * the runtime does and assert the rendered rows.
 */
describe('scaffold parity — repeat + binding authored via edits', () => {
  async function authorTodoList(): Promise<void> {
    await edit((b) => addCell(b, makeListCell('items', HOME, 'items')))
    await edit((b) => setRepeat(b, 'row', { over: 'items', as: 'item' }))
    await edit((b) => setRef(b, 'row', 'text', 'item.label'))
    await edit((b) => addRule(b, 'addBtn', 'i1'))
    await edit((b) => addAction(b, 'i1', 'collection.append'))
    await edit((b) => setActionTarget(b, 'i1', 0, 'items'))
    await edit((b) => setActionValue(b, 'i1', 0, '{ label: "Item " + (items.length + 1) }'))
  }

  it('produces the same records as the hand-written scaffold', async () => {
    await authorTodoList()
    expect(text(live()).bindings).toEqual([
      { node: 'row', prop: 'repeat', expr: 'items', item: { as: 'item' } },
      { node: 'row', prop: 'text', expr: 'item.label' },
    ])
    expect(live().cells[0]).toMatchObject({ name: 'items', type: { collection: 'object' } })
  })

  it('renders one bound row per appended item (runtime data path)', async () => {
    await authorTodoList()
    const b = live()
    const append = ruleOf('i1')
    let rt = initRuntime(b)
    rt = runRule(b, rt, append, buildEnv(b, rt))
    rt = runRule(b, rt, append, buildEnv(b, rt))

    const env = buildEnv(b, rt)
    const rep = repeatOf(b, 'row')!
    const textRef = getRef(b, 'row', 'text')!
    const coll = evaluate(namesOf(rep.over, b), env) as unknown[]
    const rows = coll.map((item) => evaluate(namesOf(textRef, b), { ...env, [rep.as]: item }))

    expect(rows).toEqual(['Item 1', 'Item 2'])
  })
})

describe('setActionParam — extra expression params (where / at)', () => {
  /** A rule with one `collection.update` action to hang params on. */
  async function authorUpdate(): Promise<void> {
    await edit((b) => addCell(b, makeListCell('items', HOME, 'items')))
    await edit((b) => addRule(b, 'saveBtn', 'i1'))
    await edit((b) => addAction(b, 'i1', 'collection.update'))
    await edit((b) => setActionTarget(b, 'i1', 0, 'items'))
  }
  const actionOf = () => ruleOf('i1').do[0]

  it('sets a param', async () => {
    await authorUpdate()
    await edit((b) => setActionParam(b, 'i1', 0, 'where', 'item.id == 2'))
    expect(text(live()).rules[0].do[0].params).toEqual({ where: 'item.id == 2' })
  })

  it('keeps params independent of each other', async () => {
    await authorUpdate()
    await edit((b) => setActionParam(b, 'i1', 0, 'where', 'item.id == 2'))
    await edit((b) => setActionParam(b, 'i1', 0, 'at', '1'))
    expect(text(live()).rules[0].do[0].params).toEqual({ where: 'item.id == 2', at: '1' })
  })

  it('clearing the last param drops `params` entirely, keeping the record minimal', async () => {
    await authorUpdate()
    await edit((b) => setActionParam(b, 'i1', 0, 'where', 'item.id == 2'))
    await edit((b) => setActionParam(b, 'i1', 0, 'where', '  '))
    expect(actionOf().params).toBeUndefined()
  })

  it('building the edit writes nothing until it is committed', async () => {
    await authorUpdate()
    const changes = setActionParam(live(), 'i1', 0, 'where', 'item.id == 2')
    expect(actionOf().params).toBeUndefined()
    await commit(changes)
    expect(text(live()).rules[0].do[0].params).toEqual({ where: 'item.id == 2' })
  })

  it('changing the action type clears params along with target and value', async () => {
    await authorUpdate()
    await edit((b) => setActionParam(b, 'i1', 0, 'where', 'item.id == 2'))
    await edit((b) => setActionType(b, 'i1', 0, 'collection.clear'))
    expect(actionOf()).toEqual({ type: 'collection.clear' })
  })
})
