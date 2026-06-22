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

const NODE_IDS = new Set(['addBtn', 'list', 'card'])

/** A valid "todo" page: add to list, disable-when-empty, a repeater, a variant. */
function todoIR(): PageInteractions {
  const ir = emptyPageInteractions()
  ir.variables.push({ id: 'items', type: { collection: 'object' }, scope: 'page', initial: [], source: 'local' })
  ir.ports.push({ id: 'initialItems', dir: 'in', type: { collection: 'object' } })
  ir.ports.push({ id: 'onSave', dir: 'out', type: 'object' })
  ir.derived.push({ id: 'isEmpty', expr: 'items.length == 0' })
  ir.interactions.push({
    on: { node: 'addBtn', trigger: { type: 'press' } },
    do: [{ type: 'collection.append', target: 'items', value: '{ label: "" }' }],
  })
  ir.bindings.push({ node: 'addBtn', prop: 'disabled', from: 'isEmpty' })
  ir.repeaters.push({ node: 'list', over: 'items', as: 'item' })
  ir.states.push({ node: 'card', states: ['collapsed', 'expanded'], active: { from: 'self', initial: 'collapsed' } })
  return ir
}

beforeAll(() => initDefaultCatalog())

describe('buildScope / resolveRoot', () => {
  const scope = buildScope(todoIR(), NODE_IDS)
  it('classifies every kind of symbol', () => {
    expect(resolveRoot(scope, 'items')?.kind).toBe('variable')
    expect(resolveRoot(scope, 'isEmpty')?.kind).toBe('derived')
    expect(resolveRoot(scope, 'initialItems')?.kind).toBe('port-in')
    expect(resolveRoot(scope, 'onSave')?.kind).toBe('port-out')
    expect(resolveRoot(scope, 'addBtn')?.kind).toBe('node')
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

  it('flags a binding on a node that does not exist', () => {
    const ir = todoIR()
    ir.bindings.push({ node: 'ghost', prop: 'disabled', from: 'isEmpty' })
    const issues = validatePageInteractions(ir, NODE_IDS)
    expect(issues.some((x) => /unknown node 'ghost'/.test(x.message))).toBe(true)
  })

  it('flags an action target of the wrong kind', () => {
    const ir = todoIR()
    // append must target a collection; isEmpty is a derived value
    ir.interactions[0].do = [{ type: 'collection.append', target: 'isEmpty', value: '1' }]
    const issues = validatePageInteractions(ir, NODE_IDS)
    expect(issues.some((x) => /must be a collection variable/.test(x.message))).toBe(true)
  })

  it('flags unknown action and trigger types', () => {
    const ir = todoIR()
    ir.interactions[0].on.trigger.type = 'hover'
    ir.interactions[0].do = [{ type: 'frobnicate' }]
    const issues = validatePageInteractions(ir, NODE_IDS)
    expect(issues.some((x) => /unknown trigger 'hover'/.test(x.message))).toBe(true)
    expect(issues.some((x) => /unknown action 'frobnicate'/.test(x.message))).toBe(true)
  })

  it('requires node.setState targets to be <node>.state', () => {
    const ir = todoIR()
    ir.interactions[0].do = [{ type: 'node.setState', target: 'items', value: '"expanded"' }]
    const issues = validatePageInteractions(ir, NODE_IDS)
    expect(issues.some((x) => /must be <node>\.state/.test(x.message))).toBe(true)
  })
})
