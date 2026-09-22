/**
 * Fixtures for the interactions suites.
 *
 * Pages are written in the TEXT form (version 2: expressions and targets as
 * strings) and upgraded, which is exactly how a stored document reads — so
 * every fixture also exercises the upgrade. `ex`/`rf`/`act`/`refs` resolve
 * text against an existing page for tests that grow a page step by step;
 * `txt` prints a stored expression back for assertions.
 */

import type {
  Action,
  Cell,
  Expr,
  Json,
  NodeRefs,
  PageInteractions,
  Ref,
  V2Action,
  V2Cell,
  V2PageInteractions,
  ValueType,
} from '../../../../src/lib/renderer/interactions/ir'
import { upgradePageInteractions } from '../../../../src/lib/renderer/interactions/upgrade'
import { buildScope } from '../../../../src/lib/renderer/interactions/addressing'
import { exprText, parseExpr, parseRef, toTextIR } from '../../../../src/lib/renderer/interactions/expr'

/** A page from its text form. Deterministic: a cell's uid is its text-form reference. */
export function up(v2: Partial<Omit<V2PageInteractions, 'version'>>): PageInteractions {
  return upgradePageInteractions({ version: 2, cells: [], refs: [], interactions: [], appRules: [], ...v2 }).ir
}

/** The text form of a page, for assertions on what was authored. */
export const text = (ir: PageInteractions) => toTextIR(ir)

/** Resolve expression text against a page. Throws on a syntax error. */
export const ex = (ir: PageInteractions, src: string, items: string[] = []): Expr => parseExpr(src, buildScope(ir, [], items))

/** Resolve a target text against a page (`items`, `card.state`). */
export const rf = (ir: PageInteractions, src: string): Ref => parseRef(src, buildScope(ir)) ?? { kind: 'name', name: src }

/** Print a stored expression. */
export const txt = (ir: PageInteractions, expr: Expr | undefined): string => exprText(expr, ir)

/** An action from its text form, resolved against `ir`. */
export function act(ir: PageInteractions, a: V2Action & { node?: string }): Action {
  const scope = buildScope(ir)
  const out: Action = { type: a.type }
  if (a.target !== undefined) out.target = a.node ? { kind: 'node', node: a.target } : (parseRef(a.target, scope) ?? { kind: 'name', name: a.target })
  if (a.value !== undefined) out.value = parseExpr(a.value, scope)
  if (a.params) {
    out.params = {}
    for (const [k, v] of Object.entries(a.params)) (out.params as Record<string, unknown>)[k] = typeof v === 'string' ? parseExpr(v, scope) : v
  }
  return out
}

/** A node's property references from their text form. */
export function refs(ir: PageInteractions, node: string, props: Record<string, string>, item?: { as?: string; key?: string }): NodeRefs {
  const as = item?.as ?? 'item'
  const scope = buildScope(ir, [], [as])
  const out: NodeRefs = { node, props: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, parseExpr(v, scope)])) }
  if (item) {
    out.item = {}
    if (item.as) out.item.as = item.as
    if (item.key) out.item.key = parseExpr(item.key, scope)
  }
  return out
}

// ---- text-form cells ----

export const pageCell = (id: string, type: ValueType, initial: Json, extra: Partial<V2Cell> = {}): V2Cell => ({
  id,
  owner: { kind: 'page' },
  type,
  initial,
  ...extra,
})

export const listCell = (id: string, initial: Json[] = [], extra: Partial<V2Cell> = {}): V2Cell =>
  pageCell(id, { collection: 'object' }, initial, extra)

export const formulaCell = (id: string, formula: string): V2Cell => pageCell(id, 'any', null, { formula })

/** A node's variant set: an enum cell it owns. */
export const variantCell = (node: string, values: string[], extra: Partial<V2Cell> = {}): V2Cell => ({
  id: 'state',
  owner: { kind: 'node', node },
  type: { enum: values },
  initial: null,
  ...extra,
})

/** A stored (version-3) cell for tests that build pages without the upgrade. */
export const cell = (id: string, type: ValueType, initial: Json, extra: Partial<Cell> = {}): Cell => ({
  uid: id,
  id,
  owner: { kind: 'page' },
  type,
  initial,
  ...extra,
})

export function todoIR(): PageInteractions {
  return up({
    cells: [listCell('items'), formulaCell('isEmpty', 'items.length == 0')],
    interactions: [
      {
        on: { node: 'addBtn', trigger: { type: 'press' } },
        do: [{ type: 'collection.append', target: 'items', value: '{ label: "" }' }],
      },
    ],
    refs: [
      { node: 'addBtn', props: { disabled: 'isEmpty' } },
      { node: 'row', props: { repeat: 'items', text: 'item.label' }, item: { as: 'item' } },
    ],
  })
}
