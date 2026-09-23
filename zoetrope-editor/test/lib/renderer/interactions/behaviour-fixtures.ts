/**
 * Fixtures for the interactions suites.
 *
 * Behaviour is written in the TEXT form (expressions and targets as strings)
 * and resolved by `fromText`, the way the AI's answers are read, with
 * deterministic ids: a cell's id is its reference (`items`, `card.state`), a
 * binding's is `node.prop`, a rule's is the id it is given. `ex`/`rf`/`act`
 * resolve text against a behaviour; `txt` prints a stored expression back.
 *
 * `seedPage` puts a page with plain nodes in the document, so edits can be
 * committed and read back with `live()`.
 */

import type { Action, Behaviour, Cell, Expr, Json, Ref, ValueType } from '../../../../src/lib/renderer/interactions/ir'
import { EMPTY_BEHAVIOUR } from '../../../../src/lib/renderer/interactions/ir'
import { buildScope } from '../../../../src/lib/renderer/interactions/addressing'
import {
  exprText,
  fromText,
  parseExpr,
  parseRef,
  toText,
  type IdMaker,
  type TextAction,
  type TextBehaviour,
  type TextCell,
} from '../../../../src/lib/renderer/interactions/expr'
import { commitBehaviour, currentBehaviour } from '../../../../src/lib/renderer/interactions/document/behaviour'
import { add, type LocalChange } from '../../../../src/lib/doc'
import { resetSubscribers } from '../../../../src/lib/doc/commit'
import { seedNodes } from '../../fixtures'

export const PAGE = 'page-1'

export const testIds: IdMaker = (_kind, name) => name

/** A behaviour from its text form, on `PAGE`, with deterministic ids. */
export function beh(t: Partial<TextBehaviour>, page = PAGE): Behaviour {
  return fromText({ cells: [], bindings: [], rules: [], ...t }, page, EMPTY_BEHAVIOUR, testIds)
}

/** The text form of a behaviour, for assertions on what was authored. */
export const text = (b: Behaviour) => toText(b)

/** Resolve expression text against a behaviour. Throws on a syntax error. */
export const ex = (b: Behaviour, src: string, items: string[] = []): Expr => parseExpr(src, buildScope(b, [], items))

/** Resolve a target text against a behaviour (`items`, `card.state`). */
export const rf = (b: Behaviour, src: string): Ref => parseRef(src, buildScope(b)) ?? { kind: 'name', name: src }

/** Print a stored expression. */
export const txt = (b: Behaviour, expr: Expr | undefined): string => exprText(expr, b)

/** An action from its text form, resolved against `b`. `node: true` makes the target a node (a slot). */
export function act(b: Behaviour, a: TextAction & { node?: boolean }): Action {
  const scope = buildScope(b)
  const out: Action = { type: a.type }
  if (a.target !== undefined) out.target = a.node ? { kind: 'node', node: a.target } : (parseRef(a.target, scope) ?? { kind: 'name', name: a.target })
  if (a.value !== undefined) out.value = parseExpr(a.value, scope)
  if (a.params) {
    out.params = {}
    for (const [k, v] of Object.entries(a.params)) (out.params as Record<string, unknown>)[k] = typeof v === 'string' ? parseExpr(v, scope) : v
  }
  return out
}

// ---- text-form cells ----

export const pageCell = (name: string, type: ValueType, initial: Json, extra: Partial<TextCell> = {}): TextCell => ({
  name,
  type,
  initial,
  ...extra,
})

export const listCell = (name: string, initial: Json[] = [], extra: Partial<TextCell> = {}): TextCell =>
  pageCell(name, { collection: 'object' }, initial, extra)

export const formulaCell = (name: string, formula: string): TextCell => pageCell(name, 'any', null, { formula })

/** A node's variant set: an enum cell it owns, named `state`. */
export const variantCell = (node: string, values: string[], extra: Partial<TextCell> = {}): TextCell => ({
  name: 'state',
  node,
  type: { enum: values },
  initial: null,
  ...extra,
})

/** A stored page cell, for tests that build behaviour without the text form. */
export const cell = (name: string, type: ValueType, initial: Json, extra: Partial<Cell> = {}): Cell => ({
  id: name,
  name,
  page: PAGE,
  type,
  initial,
  ...extra,
})

export function todo(): Behaviour {
  return beh({
    cells: [listCell('items'), formulaCell('isEmpty', 'items.length == 0')],
    rules: [{ id: 'r1', node: 'addBtn', on: { type: 'press' }, do: [{ type: 'collection.append', target: 'items', value: '{ label: "" }' }] }],
    bindings: [
      { node: 'addBtn', prop: 'disabled', expr: 'isEmpty' },
      { node: 'row', prop: 'repeat', expr: 'items', item: { as: 'item' } },
      { node: 'row', prop: 'text', expr: 'item.label' },
    ],
  })
}

// ---- the document ----

/** A fresh document with one page `PAGE` holding a plain node per id. */
export function seedPage(nodeIds: readonly string[] = []): void {
  resetSubscribers()
  seedNodes(nodeIds, PAGE)
}

/** The behaviour of `PAGE` as the document holds it now. */
export const live = (): Behaviour => currentBehaviour(PAGE)

/** Commit an edit's changes. */
export const commit = (changes: readonly LocalChange[]) => commitBehaviour(changes)

/** Put every record of `b` in the document. */
export async function load(b: Behaviour): Promise<void> {
  await commitBehaviour([
    ...b.cells.map((c) => add('cell', c)),
    ...b.bindings.map((x) => add('binding', x)),
    ...b.rules.map((r) => add('rule', r)),
  ])
}
