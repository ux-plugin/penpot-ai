import { describe, it, expect, beforeAll } from 'vitest'
import {
  buildScope,
  resolveRoot,
  parseRefPath,
  validateBehaviour,
  AddressingError,
} from '../../../../src/lib/renderer/interactions/addressing'
import type { Behaviour } from '../../../../src/lib/renderer/interactions/ir'
import type { TextBehaviour } from '../../../../src/lib/renderer/interactions/expr'
import { initDefaultCatalog } from '../../../../src/lib/renderer/interactions/catalog'
import { act, beh, ex, listCell, formulaCell, variantCell } from './behaviour-fixtures'

const NODE_IDS = new Set(['addBtn', 'list', 'card'])

/**
 * A valid "todo" page: add to list, disable-when-empty, a repeat, a variant
 * set, and a list the real app supplies (a store cell is a cell like any other,
 * so nothing reading an expression has to know where a value came from).
 */
function todoText(): TextBehaviour {
  return {
    cells: [
      listCell('items'),
      listCell('initialItems', [], { store: 'app' }),
      formulaCell('isEmpty', 'items.length == 0'),
      variantCell('card', ['collapsed', 'expanded'], { initial: 'collapsed' }),
    ],
    rules: [{ node: 'addBtn', on: { type: 'press' }, do: [{ type: 'collection.append', target: 'items', value: '{ label: "" }' }] }],
    bindings: [
      { node: 'addBtn', prop: 'disabled', expr: 'isEmpty' },
      { node: 'list', prop: 'repeat', expr: 'items', item: { as: 'item' } },
    ],
  }
}

const todoB = (): Behaviour => beh(todoText())

beforeAll(() => initDefaultCatalog())

describe('buildScope / resolveRoot', () => {
  const scope = buildScope(todoB(), NODE_IDS)
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

describe('validateBehaviour', () => {
  it('accepts a well-formed page with no issues', () => {
    expect(validateBehaviour(todoB(), NODE_IDS)).toEqual([])
  })

  it('flags an unknown reference in a guard', () => {
    const b = todoB()
    b.rules[0].if = ex(b, 'missing > 0')
    const issues = validateBehaviour(b, NODE_IDS)
    expect(issues).toContainEqual({ where: 'rule[0].if', message: "unknown reference 'missing'" })
  })

  it('flags a binding on a node that does not exist', () => {
    const t = todoText()
    const b = beh({ ...t, bindings: [...t.bindings, { node: 'ghost', prop: 'disabled', expr: 'isEmpty' }] })
    const issues = validateBehaviour(b, NODE_IDS)
    expect(issues.some((x) => x.where === 'bindings[2](ghost.disabled)' && /unknown node 'ghost'/.test(x.message))).toBe(true)
  })

  it('flags an action target of the wrong kind', () => {
    const b = todoB()
    b.rules[0].do = [act(b, { type: 'collection.append', target: 'card.state', value: '1' })]
    const issues = validateBehaviour(b, NODE_IDS)
    expect(issues.some((x) => /must be a list/.test(x.message))).toBe(true)
  })

  it('flags unknown action and trigger types', () => {
    const b = todoB()
    b.rules[0].on.type = 'hover'
    b.rules[0].do = [{ type: 'frobnicate' }]
    const issues = validateBehaviour(b, NODE_IDS)
    expect(issues.some((x) => /unknown trigger 'hover'/.test(x.message))).toBe(true)
    expect(issues.some((x) => /unknown action 'frobnicate'/.test(x.message))).toBe(true)
  })

  it("writes a node's cell as <node>.<cell>, and refuses a cell the node does not have", () => {
    const b = todoB()
    b.rules[0].do = [act(b, { type: 'set-variable', target: 'card.state', value: '"expanded"' })]
    expect(validateBehaviour(b, NODE_IDS)).toEqual([])
    b.rules[0].do = [act(b, { type: 'set-variable', target: 'card.nope', value: '"expanded"' })]
    expect(validateBehaviour(b, NODE_IDS).some((x) => /not a value/.test(x.message))).toBe(true)
  })

  it('refuses to write a formula', () => {
    const b = todoB()
    b.rules[0].do = [act(b, { type: 'set-variable', target: 'isEmpty', value: 'true' })]
    expect(validateBehaviour(b, NODE_IDS).some((x) => /formula/.test(x.message))).toBe(true)
  })
})
