/**
 * Expressions at the edge: text ⇄ id-based trees.
 *
 * The property under test is that identity never depends on a name. A stored
 * expression points at cells by id; renaming a cell changes what prints, not
 * what the expression means. Text that resolves to nothing is kept as typed.
 */

import { describe, it, expect } from 'vitest'
import { buildScope } from '../../../../src/lib/renderer/interactions/addressing'
import {
  cellsIn,
  exprText,
  fromText,
  namesOf,
  parseExpr,
  parseExprLenient,
  parseRef,
  rawExpr,
  refName,
  resolveExpr,
  toText,
  type TextBehaviour,
  unresolvedNames,
} from '../../../../src/lib/renderer/interactions/expr'
import { parse, printExpr } from '../../../../src/lib/renderer/interactions/expression'
import { beh, formulaCell, listCell, PAGE, pageCell, testIds, variantCell } from './behaviour-fixtures'

const page = () =>
  beh({
    cells: [listCell('items'), pageCell('draft', 'string', ''), formulaCell('isEmpty', 'items.length == 0'), variantCell('card', ['a', 'b'])],
    bindings: [{ node: 'row', prop: 'repeat', expr: 'items', item: { as: 'todo' } }],
  })

describe('resolveExpr — names become identities', () => {
  it('a page cell, a loop item, a node cell, a lambda parameter, a builtin, a typo', () => {
    const b = page()
    const scope = buildScope(b, ['card'])
    const e = parseExpr('items.filter(x => x.done && card.state == "a").length + Math.max(1, todo.n) - nope', scope)
    expect(cellsIn(e)).toEqual(new Set(['items', 'card.state']))
    expect(unresolvedNames(e)).toEqual(new Set(['nope']))
    expect(exprText(e, b)).toBe('items.filter(x => x.done && card.state == "a").length + Math.max(1, todo.n) - nope')
  })

  it('collapses `node.cell` into one cell reference', () => {
    const b = page()
    const e = parseExpr('card.state', buildScope(b))
    expect(e).toEqual({ type: 'ref', ref: { kind: 'cell', cell: 'card.state' } })
    expect(namesOf(e, b)).toEqual({ type: 'member', object: { type: 'ref', name: 'card' }, property: 'state' })
  })

  it('a member of a page cell stays a member access on the cell', () => {
    const b = page()
    const e = parseExpr('items.length', buildScope(b))
    expect(e).toEqual({ type: 'member', object: { type: 'ref', ref: { kind: 'cell', cell: 'items' } }, property: 'length' })
  })

  it('a lambda parameter shadows a cell of the same name', () => {
    const b = page()
    const e = resolveExpr(parse('items.map(items => items)'), buildScope(b))
    const lambda = (e as { type: 'call'; args: Array<{ type: 'lambda'; body: unknown }> }).args[0]
    expect(lambda.body).toEqual({ type: 'ref', ref: { kind: 'name', name: 'items' } })
  })
})

describe('renaming', () => {
  it('a renamed cell prints under its new name; the stored tree is untouched', () => {
    const b = page()
    const e = parseExpr('items.length == 0', buildScope(b))
    const renamed = { ...b, cells: b.cells.map((c) => (c.id === 'items' ? { ...c, name: 'todos' } : c)) }
    expect(exprText(e, renamed)).toBe('todos.length == 0')
    expect(exprText(e, b)).toBe('items.length == 0')
  })

  it('a deleted cell prints as missing, and validation can see it', () => {
    const b = page()
    const e = parseExpr('draft', buildScope(b))
    const without = { ...b, cells: b.cells.filter((c) => c.id !== 'draft') }
    expect(exprText(e, without)).toMatch(/missing/)
  })
})

describe('lenient parsing keeps what was typed', () => {
  it('a syntax error becomes an unresolved name that prints back verbatim', () => {
    const b = page()
    const e = parseExprLenient('items.length ==', buildScope(b))
    expect(e).toEqual(rawExpr('items.length =='))
    expect(exprText(e, b)).toBe('items.length ==')
    expect(unresolvedNames(e)).toEqual(new Set(['items.length ==']))
  })
})

describe('parseRef — what an action target names', () => {
  it('a cell, a node cell, the root of a path, a node, nothing', () => {
    const b = page()
    const scope = buildScope(b, ['outlet'])
    expect(parseRef('items', scope)).toEqual({ kind: 'cell', cell: 'items' })
    expect(parseRef('card.state', scope)).toEqual({ kind: 'cell', cell: 'card.state' })
    expect(parseRef('items.first', scope)).toEqual({ kind: 'cell', cell: 'items' })
    expect(parseRef('outlet', scope)).toEqual({ kind: 'node', node: 'outlet' })
    expect(parseRef('1 + 2', scope)).toBeUndefined()
    expect(refName({ kind: 'cell', cell: 'card.state' }, b)).toBe('card.state')
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
  const authored: TextBehaviour = {
    cells: [listCell('items'), formulaCell('isEmpty', 'items.length == 0')],
    bindings: [
      { node: 'row', prop: 'repeat', expr: 'items', item: { as: 'item', key: 'item.id' } },
      { node: 'row', prop: 'text', expr: 'item.label' },
    ],
    rules: [
      {
        id: 'i1',
        node: 'addBtn',
        on: { type: 'press' },
        if: 'items.length < 10',
        do: [{ type: 'collection.update', target: 'items', value: '{ done: true }', params: { where: 'item.id == 2' } }],
      },
    ],
  }

  it('toText is the inverse of fromText', () => {
    expect(toText(beh(authored))).toEqual(authored)
  })

  it('fromText is deterministic', () => {
    expect(page()).toEqual(page())
    expect(page().cells.map((c) => c.id)).toEqual(['items', 'draft', 'isEmpty', 'card.state'])
  })

  it('re-reading edited text keeps the ids of what is still there', () => {
    const prev = fromText(authored, PAGE)
    const edited = { ...authored, bindings: [...authored.bindings, { node: 'addBtn', prop: 'disabled', expr: 'items.length >= 10' }] }
    const next = fromText(edited, PAGE, prev, testIds)
    expect(next.cells.map((c) => c.id)).toEqual(prev.cells.map((c) => c.id))
    expect(next.bindings.slice(0, 2).map((x) => x.id)).toEqual(prev.bindings.map((x) => x.id))
    expect(next.bindings[2].id).toBe('addBtn.disabled')
    expect(next.rules[0].id).toBe('i1')
  })

  it('a slot target resolves to a node reference, not a name', () => {
    const b = beh({ rules: [{ node: 'btn', on: { type: 'press' }, do: [{ type: 'show-in-slot', target: 'outlet-1', value: '"home"' }] }] })
    expect(b.rules[0].do[0].target).toEqual({ kind: 'node', node: 'outlet-1' })
  })
})
