import { describe, it, expect, beforeAll } from 'vitest'
import {
  buildScope,
  resolveRoot,
  parseRefPath,
  validatePageInteractions,
  AddressingError,
} from '../../../../src/lib/renderer/interactions/addressing'
import { emptyPageInteractions, type PageInteractions } from '../../../../src/lib/renderer/interactions/ir'
import { initDefaultCatalog } from '../../../../src/lib/renderer/interactions/catalog'
import { listCell, formulaCell, variantCell } from './todo-ir'

const NODE_IDS = new Set(['addBtn', 'list', 'card'])

/** A valid "todo" page: add to list, disable-when-empty, a repeat, a variant set. */
function todoIR(): PageInteractions {
  const ir = emptyPageInteractions()
  ir.cells.push(listCell('items'))
  // A cell the real app supplies is a cell like any other — same kind in the
  // scope, so nothing reading an expression has to know where a value came from.
  ir.cells.push(listCell('initialItems', [], { store: 'app' }))
  ir.cells.push(formulaCell('isEmpty', 'items.length == 0'))
  ir.cells.push(variantCell('card', ['collapsed', 'expanded'], { initial: 'collapsed' }))
  ir.interactions.push({
    on: { node: 'addBtn', trigger: { type: 'press' } },
    do: [{ type: 'collection.append', target: 'items', value: '{ label: "" }' }],
  })
  ir.refs.push({ node: 'addBtn', props: { disabled: 'isEmpty' } })
  ir.refs.push({ node: 'list', props: { repeat: 'items' }, item: { as: 'item' } })
  return ir
}

beforeAll(() => initDefaultCatalog())

describe('buildScope / resolveRoot', () => {
  const scope = buildScope(todoIR(), NODE_IDS)
  it('classifies every kind of symbol', () => {
    expect(resolveRoot(scope, 'items')?.kind).toBe('cell')
    expect(resolveRoot(scope, 'isEmpty')?.kind).toBe('cell')
    expect(resolveRoot(scope, 'initialItems')?.kind).toBe('cell')
    expect(resolveRoot(scope, 'addBtn')?.kind).toBe('node')
    expect(resolveRoot(scope, 'card')?.cells?.get('state')?.type).toEqual({ enum: ['collapsed', 'expanded'] })
    expect(resolveRoot(scope, 'item')?.kind).toBe('loop-item')
    expect(resolveRoot(scope, 'nope')).toBeUndefined()
  })
})

describe('parseRefPath', () => {
  it('splits root and access path', () => {
    expect(parseRefPath('card.state')).toEqual({ root: 'card', segments: [{ kind: 'member', name: 'state' }] })
    expect(parseRefPath('items')).toEqual({ root: 'items', segments: [] })
    expect(parseRefPath('row.x').root).toBe('row')
  })
  it('rejects non-reference expressions', () => {
    expect(() => parseRefPath('1 + 2')).toThrow(AddressingError)
    expect(() => parseRefPath('a.b()')).toThrow()
  })
})

describe('validatePageInteractions', () => {
  it('accepts a well-formed page with no issues', () => {
    expect(validatePageInteractions(todoIR(), NODE_IDS)).toEqual([])
  })

  it('flags an unknown reference in a guard', () => {
    const ir = todoIR()
    ir.interactions[0].if = 'missing > 0'
    const issues = validatePageInteractions(ir, NODE_IDS)
    expect(issues.some((x) => /unknown reference 'missing'/.test(x.message))).toBe(true)
  })

  it('flags a reference on a node that does not exist', () => {
    const ir = todoIR()
    ir.refs.push({ node: 'ghost', props: { disabled: 'isEmpty' } })
    const issues = validatePageInteractions(ir, NODE_IDS)
    expect(issues.some((x) => /unknown node 'ghost'/.test(x.message))).toBe(true)
  })

  it('flags an action target of the wrong kind', () => {
    const ir = todoIR()
    // append must target a list; card.state is a value, but not a list
    ir.interactions[0].do = [{ type: 'collection.append', target: 'card.state', value: '1' }]
    const issues = validatePageInteractions(ir, NODE_IDS)
    expect(issues.some((x) => /must be a list/.test(x.message))).toBe(true)
  })

  it('flags unknown action and trigger types', () => {
    const ir = todoIR()
    ir.interactions[0].on.trigger.type = 'hover'
    ir.interactions[0].do = [{ type: 'frobnicate' }]
    const issues = validatePageInteractions(ir, NODE_IDS)
    expect(issues.some((x) => /unknown trigger 'hover'/.test(x.message))).toBe(true)
    expect(issues.some((x) => /unknown action 'frobnicate'/.test(x.message))).toBe(true)
  })

  it("writes a node's cell as <node>.<cell>, and refuses a cell the node does not have", () => {
    const ir = todoIR()
    ir.interactions[0].do = [{ type: 'set-variable', target: 'card.state', value: '"expanded"' }]
    expect(validatePageInteractions(ir, NODE_IDS)).toEqual([])
    ir.interactions[0].do = [{ type: 'set-variable', target: 'card.nope', value: '"expanded"' }]
    expect(validatePageInteractions(ir, NODE_IDS).some((x) => /not a value/.test(x.message))).toBe(true)
  })

  it('refuses to write a formula', () => {
    const ir = todoIR()
    ir.interactions[0].do = [{ type: 'set-variable', target: 'isEmpty', value: 'true' }]
    expect(validatePageInteractions(ir, NODE_IDS).some((x) => /formula/.test(x.message))).toBe(true)
  })
})
