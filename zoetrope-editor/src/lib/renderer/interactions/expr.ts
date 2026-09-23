/**
 * Expressions at the edge — between the text people type and the id-based
 * trees the IR stores.
 *
 *   text ──parse──► names AST ──resolveExpr(scope)──► Expr (ids)     stored
 *   Expr ──namesOf(b)───► names AST ──printExpr──► text               shown
 *                                   └─evaluate / toJs                 run / emitted
 *
 * Resolution is where `card.state` (a member access on a node) becomes one
 * `cell` reference, and where a bare name becomes a cell, a loop item, a node,
 * or stays a `name` (a lambda parameter, `Math`, or a typo). Nothing here
 * throws on unknown names: they are kept as `name` refs so the document always
 * loads and validation can point at them.
 */

import type { ExprNode } from './expression'
import { ExprError, parse, printExpr } from './expression'
import type { Scope } from './addressing'
import type { Action, Behaviour, Binding, Cell, Expr, Json, NodeId, Persistence, Ref, Rule, Trigger, ValueType } from './ir'
import { cellById, cellRef, EMPTY_BEHAVIOUR, isExpr, newId, nodeRef, ownerKind, REF, REPEAT_PROP } from './ir'
import { buildScope } from './addressing'
import { getAction } from './catalog'
import { initialOrders } from '../../doc/order'

const BUILTINS = new Set(['Math'])

// ---- names → ids ----

function resolveName(name: string, scope: Scope, bound: ReadonlySet<string>): Ref {
  if (bound.has(name) || BUILTINS.has(name)) return { kind: 'name', name }
  const sym = scope.get(name)
  if (!sym) return { kind: 'name', name }
  if (sym.kind === 'cell' && sym.cell) return { kind: 'cell', cell: sym.cell.id }
  if (sym.kind === 'loop-item') return { kind: 'item', name }
  return { kind: 'node', node: sym.name }
}

/** Resolve every name in a parsed expression against `scope`. Total. */
export function resolveExpr(node: ExprNode, scope: Scope, bound: ReadonlySet<string> = new Set()): Expr {
  const go = (n: ExprNode): Expr => resolveExpr(n, scope, bound)
  switch (node.type) {
    case 'lit':
      return node
    case 'ref':
      return REF(resolveName(node.name, scope, bound))
    case 'member': {
      // `card.state`: a node's own cell is ONE reference, not a member access.
      if (node.object.type === 'ref' && !bound.has(node.object.name)) {
        const sym = scope.get(node.object.name)
        if (sym?.kind === 'node') {
          const cell = sym.cells?.get(node.property)
          if (cell) return REF({ kind: 'cell', cell: cell.id })
        }
      }
      return { type: 'member', object: go(node.object), property: node.property }
    }
    case 'index':
      return { type: 'index', object: go(node.object), index: go(node.index) }
    case 'array':
      return { type: 'array', items: node.items.map(go) }
    case 'object':
      return { type: 'object', props: node.props.map((p) => ({ key: p.key, value: go(p.value) })) }
    case 'unary':
      return { type: 'unary', op: node.op, operand: go(node.operand) }
    case 'binary':
      return { type: 'binary', op: node.op, left: go(node.left), right: go(node.right) }
    case 'logical':
      return { type: 'logical', op: node.op, left: go(node.left), right: go(node.right) }
    case 'conditional':
      return { type: 'conditional', test: go(node.test), consequent: go(node.consequent), alternate: go(node.alternate) }
    case 'call':
      return { type: 'call', callee: go(node.callee), args: node.args.map(go) }
    case 'lambda': {
      const inner = new Set(bound)
      for (const p of node.params) inner.add(p)
      return { type: 'lambda', params: node.params, body: resolveExpr(node.body, scope, inner) }
    }
  }
}

/** Parse text and resolve it. Throws `ExprError` on a syntax error. */
export function parseExpr(text: string, scope: Scope): Expr {
  return resolveExpr(parse(text), scope)
}

/**
 * Text that does not parse is kept, verbatim, as an unresolved name — so an
 * inspector field never loses what was typed and validation shows it back.
 */
export function rawExpr(text: string): Expr {
  return REF({ kind: 'name', name: text })
}

/** `parseExpr`, but a syntax error yields `rawExpr(text)` instead of throwing. */
export function parseExprLenient(text: string, scope: Scope): Expr {
  try {
    return parseExpr(text, scope)
  } catch (e) {
    if (e instanceof ExprError) return rawExpr(text)
    throw e
  }
}

/**
 * The reference a target text names: `items`, `card.state`, a slot id — or the
 * ROOT of a path (`cart.items` targets `cart`: a write lands on the cell).
 * Undefined when the text is not a reference at all.
 */
export function parseRef(text: string, scope: Scope): Ref | undefined {
  let expr: Expr
  try {
    expr = parseExpr(text, scope)
  } catch {
    return undefined
  }
  let cur = expr
  while (cur.type === 'member' || cur.type === 'index') cur = cur.object
  return cur.type === 'ref' ? cur.ref : undefined
}

// ---- ids → names ----

/** How a reference reads as text. A cell that no longer exists reads as its id, marked. */
export function refName(ref: Ref, b: Behaviour): string {
  switch (ref.kind) {
    case 'cell': {
      const c = cellById(b, ref.cell)
      return c ? cellRef(c) : `⟨missing ${ref.cell}⟩`
    }
    case 'item':
    case 'name':
      return ref.name
    case 'node':
      return nodeRef(ref.node)
  }
}

function nameNode(ref: Ref, b: Behaviour): ExprNode {
  if (ref.kind === 'cell') {
    const c = cellById(b, ref.cell)
    if (c?.node != null) return { type: 'member', object: { type: 'ref', name: nodeRef(c.node) }, property: c.name }
  }
  return { type: 'ref', name: refName(ref, b) }
}

/** The name-based AST `evaluate`, `toJs` and `printExpr` read. */
export function namesOf(expr: Expr, b: Behaviour): ExprNode {
  const go = (n: Expr): ExprNode => namesOf(n, b)
  switch (expr.type) {
    case 'lit':
      return expr
    case 'ref':
      return nameNode(expr.ref, b)
    case 'member':
      return { type: 'member', object: go(expr.object), property: expr.property }
    case 'index':
      return { type: 'index', object: go(expr.object), index: go(expr.index) }
    case 'array':
      return { type: 'array', items: expr.items.map(go) }
    case 'object':
      return { type: 'object', props: expr.props.map((p) => ({ key: p.key, value: go(p.value) })) }
    case 'unary':
      return { type: 'unary', op: expr.op, operand: go(expr.operand) }
    case 'binary':
      return { type: 'binary', op: expr.op, left: go(expr.left), right: go(expr.right) }
    case 'logical':
      return { type: 'logical', op: expr.op, left: go(expr.left), right: go(expr.right) }
    case 'conditional':
      return { type: 'conditional', test: go(expr.test), consequent: go(expr.consequent), alternate: go(expr.alternate) }
    case 'call':
      return { type: 'call', callee: go(expr.callee), args: expr.args.map(go) }
    case 'lambda':
      return { type: 'lambda', params: expr.params, body: go(expr.body) }
  }
}

/** Source text for a stored expression; empty for none. */
export function exprText(expr: Expr | undefined, b: Behaviour): string {
  if (!expr) return ''
  // An unparsable text kept by `rawExpr` prints back exactly as typed.
  if (expr.type === 'ref' && expr.ref.kind === 'name') return expr.ref.name
  return printExpr(namesOf(expr, b))
}

// ---- walking ----

/** Visit every reference, with the lambda parameters bound at that point. */
export function walkRefs(expr: Expr, visit: (ref: Ref, bound: ReadonlySet<string>) => void, bound: ReadonlySet<string> = new Set()): void {
  const go = (n: Expr) => walkRefs(n, visit, bound)
  switch (expr.type) {
    case 'lit':
      return
    case 'ref':
      visit(expr.ref, bound)
      return
    case 'member':
      go(expr.object)
      return
    case 'index':
      go(expr.object)
      go(expr.index)
      return
    case 'array':
      expr.items.forEach(go)
      return
    case 'object':
      expr.props.forEach((p) => go(p.value))
      return
    case 'unary':
      go(expr.operand)
      return
    case 'binary':
    case 'logical':
      go(expr.left)
      go(expr.right)
      return
    case 'conditional':
      go(expr.test)
      go(expr.consequent)
      go(expr.alternate)
      return
    case 'call':
      go(expr.callee)
      expr.args.forEach(go)
      return
    case 'lambda': {
      const inner = new Set(bound)
      for (const p of expr.params) inner.add(p)
      walkRefs(expr.body, visit, inner)
      return
    }
  }
}

/** The cells an expression reads, by id. */
export function cellsIn(expr: Expr): Set<string> {
  const out = new Set<string>()
  walkRefs(expr, (r) => {
    if (r.kind === 'cell') out.add(r.cell)
  })
  return out
}

/** The formula cells of `b`, each after the formulas it reads. A cycle keeps the rest in list order. */
export function formulasInOrder(b: Behaviour): Cell[] {
  const formulas = b.cells.filter((c) => c.formula != null)
  const byId = new Map(formulas.map((c) => [c.id, c]))
  const out: Cell[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (c: Cell): void => {
    if (state.has(c.id)) return
    state.set(c.id, 'visiting')
    for (const dep of cellsIn(c.formula!)) {
      const d = byId.get(dep)
      if (d) visit(d)
    }
    state.set(c.id, 'done')
    out.push(c)
  }
  formulas.forEach(visit)
  return out
}

/** Names that resolved to nothing (not a lambda parameter, not a builtin). */
export function unresolvedNames(expr: Expr): Set<string> {
  const out = new Set<string>()
  walkRefs(expr, (r, bound) => {
    if (r.kind === 'name' && !bound.has(r.name) && !BUILTINS.has(r.name)) out.add(r.name)
  })
  return out
}

// ---- behaviour as text (the AI wire format; DSL.md) ----

/** A cell as text. A node's cell has `node`; a document cell says `scope: 'document'`. */
export interface TextCell {
  name: string
  node?: NodeId
  scope?: 'page' | 'document'
  type: ValueType
  initial: Json
  formula?: string
  store?: string
  description?: string
  persist?: Persistence
}

export interface TextBinding {
  node: NodeId
  prop: string
  expr: string
  item?: { as?: string; key?: string }
}

export interface TextAction {
  type: string
  /** A reference in the name grammar: `items`, `card.state`, `cart.items`, or a slot id. */
  target?: string
  value?: string
  params?: Record<string, Json>
}

export interface TextRule {
  id?: string
  /** The node the trigger fires on; absent for a page rule (load, timer, key). */
  node?: NodeId
  on: Trigger
  if?: string
  do: TextAction[]
}

/** A page's behaviour with every expression and target as text. */
export interface TextBehaviour {
  cells: TextCell[]
  bindings: TextBinding[]
  rules: TextRule[]
}

const EXPR_PARAMS = ['where', 'at']

function strip<T>(o: T): T {
  return JSON.parse(JSON.stringify(o)) as T
}

/** `b` as text: names instead of ids, source instead of trees. */
export function toText(b: Behaviour): TextBehaviour {
  const text = (e: Expr | undefined) => (e === undefined ? undefined : exprText(e, b))
  const params = (p: Record<string, unknown> | undefined) => {
    if (!p) return undefined
    const out: Record<string, Json> = {}
    for (const [k, v] of Object.entries(p)) out[k] = (isExpr(v) ? exprText(v, b) : v) as Json
    return out
  }
  const action = (a: Action): TextAction => ({
    type: a.type,
    target: a.target ? refName(a.target, b) : undefined,
    value: text(a.value),
    params: params(a.params),
  })
  return strip({
    cells: b.cells.map((c) => ({
      name: c.name,
      node: c.node,
      scope: ownerKind(c) === 'document' ? 'document' : undefined,
      type: c.type,
      initial: c.initial,
      formula: text(c.formula),
      store: c.store,
      description: c.description,
      persist: c.persist,
    })),
    bindings: b.bindings.map((x) => ({
      node: x.node,
      prop: x.prop,
      expr: exprText(x.expr, b),
      item: x.item ? { as: x.item.as, key: text(x.item.key) } : undefined,
    })),
    rules: b.rules.map((r) => ({ id: r.id, node: r.node, on: r.on, if: text(r.if), do: r.do.map(action) })),
  })
}

/** How `fromText` names new records. Tests pass a deterministic one. */
export type IdMaker = (kind: 'cell' | 'binding' | 'rule', name: string) => string

const freshId: IdMaker = (kind) => newId(kind[0])

/**
 * Text behaviour as records of `page`. Ids are kept where `prev` already has
 * the same thing (a cell by its reference, a binding by node and property, a
 * rule by id), so replacing a page's behaviour with an edited text diffs to
 * the records that changed. Text that does not parse is kept verbatim as an
 * unresolved name.
 */
export function fromText(t: TextBehaviour, page: string, prev: Behaviour = EMPTY_BEHAVIOUR, idOf: IdMaker = freshId): Behaviour {
  const cells: Cell[] = t.cells.map((c) => {
    const node = c.node
    const ref = cellRef({ name: c.name, node })
    const same = prev.cells.find((p) => cellRef(p) === ref)
    const cell: Cell = { id: same?.id ?? idOf('cell', ref), name: c.name, type: c.type, initial: c.initial ?? null }
    if (node != null) {
      cell.node = node
      cell.page = page
    } else if (c.scope !== 'document') cell.page = page
    if (c.store) cell.store = c.store
    if (c.description) cell.description = c.description
    if (c.persist) cell.persist = c.persist
    return cell
  })
  const skeleton: Behaviour = { cells, bindings: [], rules: [] }
  const nodes = new Set<string>()
  for (const x of t.bindings) nodes.add(x.node)
  for (const r of t.rules) if (r.node) nodes.add(r.node)
  const items = t.bindings.filter((x) => x.prop === REPEAT_PROP).map((x) => x.item?.as ?? 'item')
  const scope = buildScope(skeleton, nodes, items)

  const expr = (text: string | undefined) => (text === undefined ? undefined : parseExprLenient(text, scope))
  const target = (a: TextAction): Ref | undefined => {
    if (a.target === undefined) return undefined
    if (getAction(a.type)?.expects.target === 'slot') return { kind: 'node', node: a.target }
    return parseRef(a.target, scope) ?? { kind: 'name', name: a.target }
  }
  const action = (a: TextAction): Action => {
    const next: Action = { type: a.type }
    const tg = target(a)
    if (tg) next.target = tg
    const v = expr(a.value)
    if (v) next.value = v
    if (a.params) {
      const params: Record<string, Json> = {}
      for (const [k, val] of Object.entries(a.params)) {
        params[k] = (EXPR_PARAMS.includes(k) && typeof val === 'string' ? parseExprLenient(val, scope) : val) as Json
      }
      next.params = params
    }
    return next
  }

  t.cells.forEach((c, i) => {
    if (c.formula !== undefined) cells[i].formula = expr(c.formula)
  })
  const bindings: Binding[] = t.bindings.map((x) => {
    const same = prev.bindings.find((p) => p.node === x.node && p.prop === x.prop)
    const next: Binding = { id: same?.id ?? idOf('binding', `${x.node}.${x.prop}`), page, node: x.node, prop: x.prop, expr: expr(x.expr) ?? rawExpr('') }
    if (x.item) {
      const item: NonNullable<Binding['item']> = {}
      if (x.item.as) item.as = x.item.as
      const key = expr(x.item.key)
      if (key) item.key = key
      next.item = item
    }
    return next
  })
  const orders = initialOrders(t.rules.length)
  const rules: Rule[] = t.rules.map((r, i) => {
    const same = r.id ? prev.rules.find((p) => p.id === r.id) : undefined
    const next: Rule = { id: same?.id ?? r.id ?? idOf('rule', `${r.node ?? page}.${r.on.type}.${i}`), page, order: orders[i], on: r.on, do: r.do.map(action) }
    if (r.node) next.node = r.node
    const guard = expr(r.if)
    if (guard) next.if = guard
    return next
  })
  return { cells, bindings, rules }
}
