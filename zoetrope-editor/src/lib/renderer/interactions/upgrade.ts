/**
 * Stored-shape upgrades, applied on read. Pure.
 *
 *   version 1 → 2   six things become two (cells, property references); stores
 *                   were page-scoped and are handed back for the document.
 *   version 2 → 3   expressions stop being text: every string is parsed and
 *                   resolved to an id-based tree; every cell gets a `uid`.
 *
 * The 2 → 3 step is deterministic: a cell's uid is its version-2 reference
 * (`draft`, `card.state`), so the same document always upgrades to the same
 * bytes. Text that does not parse is kept verbatim as an unresolved name.
 */

import type {
  Action,
  AnyPageInteractions,
  AppRule,
  Cell,
  Interaction,
  NodeRefs,
  Owner,
  PageInteractions,
  Ref,
  Store,
  V1PageInteractions,
  V2Action,
  V2NodeRefs,
  V2PageInteractions,
} from './ir'
import { isV1, isV2, REPEAT_PROP, STATE_CELL, cellRef } from './ir'
import { buildScope, type Scope } from './addressing'
import { parseExprLenient, parseRef, rawExpr } from './expr'
import { getAction } from './catalog'

// ---- 1 → 2 ----

function upgradeV1(ir: V1PageInteractions): { ir: V2PageInteractions; stores: Store[] } {
  const cells: V2PageInteractions['cells'] = []
  for (const v of ir.variables ?? []) {
    const owner: Owner = v.scope === 'global' ? { kind: 'document' } : { kind: 'page' }
    const cell: V2PageInteractions['cells'][number] = { id: v.id, owner, type: v.type, initial: v.initial }
    if (v.store) cell.store = v.store
    if (v.description) cell.description = v.description
    if (v.persist) cell.persist = v.persist
    cells.push(cell)
  }
  for (const d of ir.derived ?? []) cells.push({ id: d.id, owner: { kind: 'page' }, type: 'any', initial: null, formula: d.expr })
  for (const s of ir.states ?? []) {
    const cell: V2PageInteractions['cells'][number] = {
      id: STATE_CELL,
      owner: { kind: 'node', node: s.node },
      type: { enum: s.states },
      initial: null,
    }
    if ('bind' in s.active) cell.formula = s.active.bind
    else cell.initial = s.active.initial ?? s.states[0] ?? null
    cells.push(cell)
  }

  const refs = new Map<string, V2NodeRefs>()
  const at = (node: string): V2NodeRefs => {
    let r = refs.get(node)
    if (!r) {
      r = { node, props: {} }
      refs.set(node, r)
    }
    return r
  }
  for (const b of ir.bindings ?? []) at(b.node).props[b.prop] = b.from
  for (const e of ir.editable ?? []) at(e.node).props[e.prop] = e.target
  for (const rep of ir.repeaters ?? []) {
    const r = at(rep.node)
    r.props[REPEAT_PROP] = rep.over
    const item: NonNullable<V2NodeRefs['item']> = {}
    if (rep.as) item.as = rep.as
    if (rep.key) item.key = rep.key
    if (Object.keys(item).length) r.item = item
  }

  // `node.setState` on `<node>.state` is `set-variable` on the node's cell.
  const action = (a: V2Action): V2Action => (a.type === 'node.setState' ? { ...a, type: 'set-variable' } : a)
  const interactions = (ir.interactions ?? []).map((it) => ({ ...it, do: it.do.map(action) }))
  const appRules = (ir.appRules ?? []).map((ar) => ({ ...ar, do: ar.do.map(action) }))

  return {
    ir: { version: 2, cells, refs: [...refs.values()], interactions, appRules },
    stores: ir.stores ?? [],
  }
}

// ---- 2 → 3 ----

function upgradeV2(v2: V2PageInteractions): PageInteractions {
  // Cells first, with their identity, so a scope can resolve the text.
  const cells: Cell[] = v2.cells.map(({ formula: _f, ...rest }) => ({ uid: cellRef(rest as Cell), ...rest }))
  const skeleton: PageInteractions = { version: 3, cells, refs: [], interactions: [], appRules: [] }
  const nodes = new Set<string>()
  for (const r of v2.refs) nodes.add(r.node)
  for (const it of v2.interactions) nodes.add(it.on.node)
  const items = v2.refs.filter((r) => r.props[REPEAT_PROP]).map((r) => r.item?.as ?? 'item')
  const scope: Scope = buildScope(skeleton, nodes, items)

  const expr = (text: string | undefined) => (text === undefined ? undefined : parseExprLenient(text, scope))
  const target = (a: V2Action): Ref | undefined => {
    if (a.target === undefined) return undefined
    // A slot target is a node id, which is not an expression.
    if (getAction(a.type)?.expects.target === 'slot') return { kind: 'node', node: a.target }
    return parseRef(a.target, scope) ?? { kind: 'name', name: a.target }
  }
  const action = (a: V2Action, entryParams: string[] = ['where', 'at']): Action => {
    const next: Action = { type: a.type }
    const t = target(a)
    if (t) next.target = t
    const v = expr(a.value)
    if (v) next.value = v
    if (a.params) {
      const params: Record<string, never> = {}
      for (const [k, val] of Object.entries(a.params)) {
        ;(params as Record<string, unknown>)[k] = entryParams.includes(k) && typeof val === 'string' ? parseExprLenient(val, scope) : val
      }
      next.params = params
    }
    return next
  }

  v2.cells.forEach((c, i) => {
    if (c.formula !== undefined) cells[i].formula = expr(c.formula)
  })
  const refs: NodeRefs[] = v2.refs.map((r) => {
    const next: NodeRefs = {
      node: r.node,
      props: Object.fromEntries(Object.entries(r.props).map(([k, v]) => [k, expr(v) ?? rawExpr('')])),
    }
    if (r.item) {
      next.item = {}
      if (r.item.as) next.item.as = r.item.as
      const key = expr(r.item.key)
      if (key) next.item.key = key
    }
    return next
  })
  const interactions: Interaction[] = v2.interactions.map((it) => {
    const next: Interaction = { on: it.on, do: it.do.map((a) => action(a)) }
    if (it.id) next.id = it.id
    const guard = expr(it.if)
    if (guard) next.if = guard
    return next
  })
  const appRules: AppRule[] = v2.appRules.map((ar) => {
    const next: AppRule = { on: ar.on, do: ar.do.map((a) => action(a)) }
    if (ar.id) next.id = ar.id
    const guard = expr(ar.if)
    if (guard) next.if = guard
    return next
  })
  return { version: 3, cells, refs, interactions, appRules }
}

/**
 * Upgrade a stored block of any version. Returns the current block and the
 * stores a version-1 block carried, for the document to adopt. A current block
 * passes through untouched with no stores.
 */
export function upgradePageInteractions(ir: AnyPageInteractions): { ir: PageInteractions; stores: Store[] } {
  if (isV1(ir)) {
    const v2 = upgradeV1(ir)
    return { ir: upgradeV2(v2.ir), stores: v2.stores }
  }
  if (isV2(ir)) return { ir: upgradeV2(ir), stores: [] }
  return { ir, stores: [] }
}
