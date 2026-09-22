/**
 * Expressions at the edge: text ⇄ id-based trees.
 *
 * The property under test is that identity never depends on a name. A stored
 * expression points at cells by uid; renaming a cell changes what prints, not
 * what the expression means. Text that resolves to nothing is kept as typed.
 */

import { describe, it, expect } from 'vitest'
import { buildScope } from '../../../../src/lib/renderer/interactions/addressing'
import {
  cellsIn,
  exprText,
  namesOf,
  parseExpr,
  parseExprLenient,
  parseRef,
  rawExpr,
  refName,
  resolveExpr,
  toTextIR,
  unresolvedNames,
} from '../../../../src/lib/renderer/interactions/expr'
import { parse, printExpr } from '../../../../src/lib/renderer/interactions/expression'
import { upgradePageInteractions } from '../../../../src/lib/renderer/interactions/upgrade'
import { formulaCell, listCell, pageCell, up, variantCell } from './todo-ir'

const page = () =>
  up({
    cells: [listCell('items'), pageCell('draft', 'string', ''), formulaCell('isEmpty', 'items.length == 0'), variantCell('card', ['a', 'b'])],
    refs: [{ node: 'row', props: { repeat: 'items' }, item: { as: 'todo' } }],
  })

describe('resolveExpr — names become identities', () => {
  it('a page cell, a loop item, a node cell, a lambda parameter, a builtin, a typo', () => {
    const ir = page()
    const scope = buildScope(ir, ['card'])
    const e = parseExpr('items.filter(x => x.done && card.state == "a").length + Math.max(1, todo.n) - nope', scope)
    expect(cellsIn(e)).toEqual(new Set(['items', 'card.state']))
    expect(unresolvedNames(e)).toEqual(new Set(['nope']))
    expect(exprText(e, ir)).toBe('items.filter(x => x.done && card.state == "a").length + Math.max(1, todo.n) - nope')
  })

  it('collapses `node.cell` into one cell reference', () => {
    const ir = page()
    const e = parseExpr('card.state', buildScope(ir))
    expect(e).toEqual({ type: 'ref', ref: { kind: 'cell', cell: 'card.state' } })
    expect(namesOf(e, ir)).toEqual({ type: 'member', object: { type: 'ref', name: 'card' }, property: 'state' })
  })

  it('a member of a page cell stays a member access on the cell', () => {
    const ir = page()
    const e = parseExpr('items.length', buildScope(ir))
    expect(e).toEqual({ type: 'member', object: { type: 'ref', ref: { kind: 'cell', cell: 'items' } }, property: 'length' })
  })

  it('a lambda parameter shadows a cell of the same name', () => {
    const ir = page()
    const e = resolveExpr(parse('items.map(items => items)'), buildScope(ir))
    const lambda = (e as { type: 'call'; args: Array<{ type: 'lambda'; body: unknown }> }).args[0]
    expect(lambda.body).toEqual({ type: 'ref', ref: { kind: 'name', name: 'items' } })
  })
})

describe('renaming', () => {
  it('a renamed cell prints under its new name; the stored tree is untouched', () => {
    const ir = page()
    const e = parseExpr('items.length == 0', buildScope(ir))
    const renamed = { ...ir, cells: ir.cells.map((c) => (c.id === 'items' ? { ...c, id: 'todos' } : c)) }
    expect(exprText(e, renamed)).toBe('todos.length == 0')
    expect(exprText(e, ir)).toBe('items.length == 0')
  })

  it('a deleted cell prints as missing, and validation can see it', () => {
    const ir = page()
    const e = parseExpr('draft', buildScope(ir))
    const without = { ...ir, cells: ir.cells.filter((c) => c.id !== 'draft') }
    expect(exprText(e, without)).toMatch(/missing/)
  })
})

describe('lenient parsing keeps what was typed', () => {
  it('a syntax error becomes an unresolved name that prints back verbatim', () => {
    const ir = page()
    const e = parseExprLenient('items.length ==', buildScope(ir))
    expect(e).toEqual(rawExpr('items.length =='))
    expect(exprText(e, ir)).toBe('items.length ==')
    expect(unresolvedNames(e)).toEqual(new Set(['items.length ==']))
  })
})

describe('parseRef — what an action target names', () => {
  it('a cell, a node cell, the root of a path, a node, nothing', () => {
    const ir = page()
    const scope = buildScope(ir, ['outlet'])
    expect(parseRef('items', scope)).toEqual({ kind: 'cell', cell: 'items' })
    expect(parseRef('card.state', scope)).toEqual({ kind: 'cell', cell: 'card.state' })
    expect(parseRef('items.first', scope)).toEqual({ kind: 'cell', cell: 'items' })
    expect(parseRef('outlet', scope)).toEqual({ kind: 'node', node: 'outlet' })
    expect(parseRef('1 + 2', scope)).toBeUndefined()
    expect(refName({ kind: 'cell', cell: 'card.state' }, ir)).toBe('card.state')
  })
})

describe('printExpr — the inverse of parse', () => {
  const cases = [
    'a + b * c',
    '(a + b) * c',
    'a - (b - c)',
    'a - b - c',
    '!a || b && c',
    'a == b ? c : d',
    '(a ? b : c) + 1',
    '-(a + b)',
    'items.filter(x => x.done).length',
    '{ label: "x", "a b": 1 }',
    '[1, 2, [3]]',
    'a[b + 1].c',
    'Math.max(1, a)',
  ]
  it.each(cases)('%s', (src) => {
    const ast = parse(src)
    expect(printExpr(ast)).toBe(src)
    expect(parse(printExpr(ast))).toEqual(ast)
  })
})

describe('the text projection', () => {
  it('toTextIR is the inverse of the upgrade', () => {
    const v2 = {
      version: 2 as const,
      cells: [listCell('items'), formulaCell('isEmpty', 'items.length == 0')],
      refs: [{ node: 'row', props: { repeat: 'items', text: 'item.label' }, item: { as: 'item', key: 'item.id' } }],
      interactions: [
        {
          id: 'i1',
          on: { node: 'addBtn', trigger: { type: 'press' } },
          if: 'items.length < 10',
          do: [{ type: 'collection.update', target: 'items', value: '{ done: true }', params: { where: 'item.id == 2' } }],
        },
      ],
      appRules: [],
    }
    const ir = upgradePageInteractions(v2).ir
    expect(toTextIR(ir)).toEqual(v2)
  })

  it('the upgrade is deterministic', () => {
    expect(page()).toEqual(page())
    expect(page().cells.map((c) => c.uid)).toEqual(['items', 'draft', 'isEmpty', 'card.state'])
  })

  it('a slot target upgrades to a node reference, not a name', () => {
    const ir = up({ interactions: [{ on: { node: 'btn', trigger: { type: 'press' } }, do: [{ type: 'show-in-slot', target: 'outlet-1', value: '"home"' }] }] })
    expect(ir.interactions[0].do[0].target).toEqual({ kind: 'node', node: 'outlet-1' })
  })
})
