/**
 * Addressing — the one namespace every condition, binding, and action references.
 *
 *   ref ::= variable            // items, cart.total          (scoped value)
 *         | derived             // isEmpty                    (computed value)
 *         | port                // initialItems, onSave       (business-logic seam)
 *         | node '.' prop       // addBtn.disabled, row.x     (bindable prop)
 *         | node '.' state      // card.state                 (variant signal)
 *         | loopItem '.' field  // item.label                 (inside a repeater)
 *
 * Two jobs:
 *   1. `buildScope` — a symbol table from the page IR + the node ids present on
 *      the page (the keys of `IndexedPage.objects`).
 *   2. `validatePageInteractions` — walk every expression/target and report refs
 *      that resolve to nothing, action targets of the wrong kind, unknown
 *      trigger/action types, etc.
 *
 * Reference paths are parsed by reusing the expression parser (a ref is just a
 * root identifier followed by member/index access), and expression refs come
 * from `freeRefs`, so the addressing rules and the expression language can never
 * drift apart.
 */

import type { PageInteractions, NodeId, ValueType, Action } from './ir'
import { parse, freeRefs, type ExprNode } from './expression'
import { getTrigger, getAction } from './catalog'

export type SymbolKind = 'variable' | 'derived' | 'port-in' | 'port-out' | 'node' | 'loop-item'

export interface Sym {
  name: string
  kind: SymbolKind
  valueType?: ValueType
}

/** A flat symbol table. Precedence on collision: data/loop-item shadow nodes. */
export type Scope = Map<string, Sym>

export function buildScope(ir: PageInteractions, nodeIds: Set<NodeId>): Scope {
  const scope: Scope = new Map()
  // nodes first (lowest precedence)
  for (const id of nodeIds) scope.set(id, { name: id, kind: 'node' })
  // data values shadow nodes
  for (const v of ir.variables) scope.set(v.id, { name: v.id, kind: 'variable', valueType: v.type })
  for (const d of ir.derived) scope.set(d.id, { name: d.id, kind: 'derived' })
  for (const p of ir.ports) scope.set(p.id, { name: p.id, kind: p.dir === 'in' ? 'port-in' : 'port-out', valueType: p.type })
  // loop items (highest precedence). TODO Phase 1: scope these to the repeater
  // subtree via the node hierarchy instead of registering them page-wide.
  for (const r of ir.repeaters) {
    const name = r.as ?? 'item'
    scope.set(name, { name, kind: 'loop-item' })
  }
  return scope
}

export function resolveRoot(scope: Scope, name: string): Sym | undefined {
  return scope.get(name)
}

export class AddressingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AddressingError'
  }
}

export type RefSegment = { kind: 'member'; name: string } | { kind: 'index'; index: ExprNode }

export interface RefPath {
  root: string
  segments: RefSegment[]
}

/** Parse a reference string (`card.state`, `items`, `row.x`) into root + path. */
export function parseRefPath(src: string): RefPath {
  let node: ExprNode
  try {
    node = parse(src)
  } catch (e) {
    throw new AddressingError(`invalid reference '${src}': ${(e as Error).message}`)
  }
  const segments: RefSegment[] = []
  let cur = node
  while (cur.type === 'member' || cur.type === 'index') {
    if (cur.type === 'member') {
      segments.push({ kind: 'member', name: cur.property })
      cur = cur.object
    } else {
      segments.push({ kind: 'index', index: cur.index })
      cur = cur.object
    }
  }
  segments.reverse()
  if (cur.type !== 'ref') throw new AddressingError(`not a reference path: '${src}'`)
  return { root: cur.name, segments }
}

const isCollection = (vt: ValueType | undefined): boolean =>
  typeof vt === 'object' && vt !== null && 'collection' in vt

// ---- validation ----

export interface AddressingIssue {
  where: string
  message: string
}

export function validatePageInteractions(ir: PageInteractions, nodeIds: Set<NodeId>): AddressingIssue[] {
  const scope = buildScope(ir, nodeIds)
  const issues: AddressingIssue[] = []
  const add = (where: string, message: string) => issues.push({ where, message })

  const checkExpr = (src: string | undefined, where: string): void => {
    if (src == null) return
    let node: ExprNode
    try {
      node = parse(src)
    } catch (e) {
      add(where, `invalid expression: ${(e as Error).message}`)
      return
    }
    for (const r of freeRefs(node)) if (!scope.get(r)) add(where, `unknown reference '${r}'`)
  }

  const validateAction = (a: Action, where: string): void => {
    const entry = getAction(a.type)
    if (!entry) {
      add(where, `unknown action '${a.type}'`)
      return
    }
    if (entry.expects.value && a.value == null) add(where, `action '${a.type}' requires a value`)
    checkExpr(a.value, `${where}.value`)

    const want = entry.expects.target
    if (!want || want === 'none') return
    // screen/overlay ids are opaque strings for Phase 0 (no screen registry yet).
    if (want === 'screen' || want === 'overlay') return

    if (a.target == null) {
      add(where, `action '${a.type}' requires a target`)
      return
    }
    let path: RefPath
    try {
      path = parseRefPath(a.target)
    } catch (e) {
      add(where, (e as Error).message)
      return
    }
    const sym = scope.get(path.root)
    if (!sym) {
      add(where, `target references unknown '${path.root}'`)
      return
    }
    if (want === 'node.state') {
      const ok =
        sym.kind === 'node' &&
        path.segments.length === 1 &&
        path.segments[0].kind === 'member' &&
        path.segments[0].name === 'state'
      if (!ok) add(where, `target '${a.target}' must be <node>.state`)
    } else if (want === 'collection') {
      if (sym.kind !== 'variable' || !isCollection(sym.valueType)) add(where, `target '${a.target}' must be a collection variable`)
    } else if (want === 'variable') {
      if (sym.kind !== 'variable') add(where, `target '${a.target}' must be a variable`)
    }
  }

  ir.derived.forEach((d, i) => checkExpr(d.expr, `derived[${i}](${d.id})`))

  ir.bindings.forEach((b, i) => {
    const where = `binding[${i}](${b.node}.${b.prop})`
    if (!nodeIds.has(b.node)) add(where, `binding on unknown node '${b.node}'`)
    checkExpr(b.from, where)
  })

  ir.interactions.forEach((it, i) => {
    const where = `interaction[${i}]`
    if (!nodeIds.has(it.on.node)) add(where, `interaction on unknown node '${it.on.node}'`)
    if (!getTrigger(it.on.trigger.type)) add(where, `unknown trigger '${it.on.trigger.type}'`)
    checkExpr(it.if, `${where}.if`)
    it.do.forEach((a, j) => validateAction(a, `${where}.do[${j}]`))
  })

  ir.appRules.forEach((ar, i) => {
    const where = `appRule[${i}]`
    const t = getTrigger(ar.on.type)
    if (!t) add(where, `unknown trigger '${ar.on.type}'`)
    else if (t.scope !== 'app') add(where, `trigger '${ar.on.type}' is node-scoped, not valid as an app rule`)
    checkExpr(ar.if, `${where}.if`)
    ar.do.forEach((a, j) => validateAction(a, `${where}.do[${j}]`))
  })

  ir.repeaters.forEach((r, i) => {
    const where = `repeater[${i}](${r.node})`
    if (!nodeIds.has(r.node)) add(where, `repeater on unknown node '${r.node}'`)
    const sym = scope.get(r.over)
    if (!sym) add(where, `repeats over unknown reference '${r.over}'`)
    else if (sym.kind !== 'variable' || !isCollection(sym.valueType)) add(where, `repeats over '${r.over}' which is not a collection variable`)
    if (r.key) checkExpr(r.key, `${where}.key`)
  })

  ir.states.forEach((s, i) => {
    const where = `state[${i}](${s.node})`
    if (!nodeIds.has(s.node)) add(where, `states on unknown node '${s.node}'`)
    if ('bind' in s.active) checkExpr(s.active.bind, `${where}.active`)
    else if (s.active.initial && !s.states.includes(s.active.initial)) add(where, `initial state '${s.active.initial}' is not one of [${s.states.join(', ')}]`)
  })

  return issues
}
