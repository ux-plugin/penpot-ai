/**
 * Expressions at the edge — between the text people type and the id-based
 * trees the IR stores.
 *
 *   text ──parse──► names AST ──resolveExpr(scope)──► Expr (ids)     stored
 *   Expr ──namesOf(ir)──► names AST ──printExpr──► text               shown
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
import type { Expr, PageInteractions, Ref, V2PageInteractions } from './ir'
import { cellByUid, cellRef, isExpr, nodeRef, REF } from './ir'

const BUILTINS = new Set(['Math'])

// ---- names → ids ----

function resolveName(name: string, scope: Scope, bound: ReadonlySet<string>): Ref {
  if (bound.has(name) || BUILTINS.has(name)) return { kind: 'name', name }
  const sym = scope.get(name)
  if (!sym) return { kind: 'name', name }
  if (sym.kind === 'cell' && sym.cell) return { kind: 'cell', cell: sym.cell.uid }
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
          if (cell) return REF({ kind: 'cell', cell: cell.uid })
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
export function refName(ref: Ref, ir: PageInteractions): string {
  switch (ref.kind) {
    case 'cell': {
      const c = cellByUid(ir, ref.cell)
      return c ? cellRef(c) : `⟨missing ${ref.cell}⟩`
    }
    case 'item':
    case 'name':
      return ref.name
    case 'node':
      return nodeRef(ref.node)
  }
}

function nameNode(ref: Ref, ir: PageInteractions): ExprNode {
  if (ref.kind === 'cell') {
    const c = cellByUid(ir, ref.cell)
    if (c?.owner.kind === 'node') return { type: 'member', object: { type: 'ref', name: nodeRef(c.owner.node) }, property: c.id }
  }
  return { type: 'ref', name: refName(ref, ir) }
}

/** The name-based AST `evaluate`, `toJs` and `printExpr` read. */
export function namesOf(expr: Expr, ir: PageInteractions): ExprNode {
  const go = (n: Expr): ExprNode => namesOf(n, ir)
  switch (expr.type) {
    case 'lit':
      return expr
    case 'ref':
      return nameNode(expr.ref, ir)
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
export function exprText(expr: Expr | undefined, ir: PageInteractions): string {
  if (!expr) return ''
  // An unparsable text kept by `rawExpr` prints back exactly as typed.
  if (expr.type === 'ref' && expr.ref.kind === 'name') return expr.ref.name
  return printExpr(namesOf(expr, ir))
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

/** The cells an expression reads, by uid. */
export function cellsIn(expr: Expr): Set<string> {
  const out = new Set<string>()
  walkRefs(expr, (r) => {
    if (r.kind === 'cell') out.add(r.cell)
  })
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

// ---- the text projection of a whole block (the AI wire format; DSL.md) ----

/** A version-2 view of the block: same structure, expressions and targets as text. */
export function toTextIR(ir: PageInteractions): V2PageInteractions {
  const text = (e: Expr | undefined) => (e === undefined ? undefined : exprText(e, ir))
  const params = (p: Record<string, unknown> | undefined) => {
    if (!p) return undefined
    const out: Record<string, never> = {}
    for (const [k, v] of Object.entries(p)) (out as Record<string, unknown>)[k] = isExpr(v) ? exprText(v, ir) : v
    return out
  }
  const strip = <T extends object>(o: T): T => JSON.parse(JSON.stringify(o)) as T
  return strip({
    version: 2,
    cells: ir.cells.map(({ uid: _uid, formula, ...rest }) => ({ ...rest, formula: text(formula) })),
    refs: ir.refs.map((r) => ({
      node: r.node,
      props: Object.fromEntries(Object.entries(r.props).map(([k, v]) => [k, exprText(v, ir)])),
      item: r.item ? { as: r.item.as, key: text(r.item.key) } : undefined,
    })),
    interactions: ir.interactions.map((it) => ({
      id: it.id,
      on: it.on,
      if: text(it.if),
      do: it.do.map((a) => ({ type: a.type, target: a.target ? refName(a.target, ir) : undefined, value: text(a.value), params: params(a.params) })),
    })),
    appRules: ir.appRules.map((ar) => ({
      id: ar.id,
      on: ar.on,
      if: text(ar.if),
      do: ar.do.map((a) => ({ type: a.type, target: a.target ? refName(a.target, ir) : undefined, value: text(a.value), params: params(a.params) })),
    })),
  })
}
