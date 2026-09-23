/**
 * Addressing — the one namespace every expression, property reference and
 * action target uses when written as TEXT.
 *
 *   ref ::= cell                // items, draft            (a page or document cell)
 *         | node '.' cell       // card.state              (a node's own cell)
 *         | loopItem '.' field  // item.label              (inside a repeated node)
 *
 * Two jobs:
 *   1. `buildScope` — a symbol table from the page's behaviour + the node ids
 *      present on the page. Text becomes ids through it (./expr `resolveExpr`);
 *      ids never depend on it again.
 *   2. `validateBehaviour` — walk every stored expression/target and
 *      report references that point at nothing, action targets of the wrong
 *      kind, unknown trigger/action types, etc.
 */

import type { Behaviour, NodeId, ValueType, Action, Cell, Expr, Ref } from './ir'
import { behaviourNodes, cellRef, cellById, nodeRef, isCollectionType, isEnumType, isFormula, REPEAT_PROP } from './ir'
import { parse, type ExprNode } from './expression'
import { refName, unresolvedNames, walkRefs } from './expr'
import { getTrigger, getAction } from './catalog'

/**
 * There is no `port` kind: a value from outside is a cell like any other (it
 * just lives in a store), so nothing addressing an expression has to know where
 * the value came from.
 */
export type SymbolKind = 'cell' | 'node' | 'loop-item'

export interface Sym {
  name: string
  kind: SymbolKind
  /** The cell, for a `cell` symbol. */
  cell?: Cell
  /** A node's own cells by name, for a `node` symbol. */
  cells?: Map<string, Cell>
}

/** A flat symbol table. Precedence on collision: cells and loop items shadow nodes. */
export type Scope = Map<string, Sym>

/**
 * The symbol table text resolves through. `nodeIds` are the page's objects;
 * nodes the behaviour itself mentions are always included, so edits can
 * resolve without a node table.
 */
export function buildScope(b: Behaviour, nodeIds: Iterable<NodeId> = [], extraItems: Iterable<string> = []): Scope {
  const scope: Scope = new Map()
  // nodes first (lowest precedence), under their id and, when that is not an
  // identifier, the mangled spelling expressions use
  const nodes = new Set<NodeId>([...nodeIds, ...behaviourNodes(b)])
  for (const id of nodes) {
    const sym: Sym = { name: id, kind: 'node', cells: new Map() }
    scope.set(id, sym)
    scope.set(nodeRef(id), sym)
  }
  for (const c of b.cells) {
    if (c.node != null) {
      const sym = scope.get(nodeRef(c.node))
      if (sym?.kind === 'node') sym.cells?.set(c.name, c)
      continue
    }
    scope.set(c.name, { name: c.name, kind: 'cell', cell: c })
  }
  // loop items (highest precedence). TODO: scope these to the repeated subtree
  // via the node hierarchy instead of registering them page-wide.
  for (const x of b.bindings) {
    if (x.prop !== REPEAT_PROP) continue
    const name = x.item?.as ?? 'item'
    scope.set(name, { name, kind: 'loop-item' })
  }
  for (const name of extraItems) scope.set(name, { name, kind: 'loop-item' })
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

/** Parse a reference string (`card.state`, `items`, `cart.items`) into root + path. */
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

/**
 * The cell a reference TEXT addresses, or undefined: a page/document cell by its
 * root (`cart.items` addresses `cart` — a write lands on the cell), a node's
 * cell as `<node>.<cell>`.
 */
export function resolveCell(scope: Scope, ref: string): Cell | undefined {
  let path: RefPath
  try {
    path = parseRefPath(ref)
  } catch {
    return undefined
  }
  const sym = scope.get(path.root)
  if (!sym) return undefined
  if (sym.kind === 'cell') return sym.cell
  if (sym.kind === 'node') {
    const first = path.segments[0]
    if (first?.kind === 'member') return sym.cells?.get(first.name)
  }
  return undefined
}

/** The cell `ref` names in `b`, resolved against the behaviour alone (no node table). */
export function cellFor(b: Behaviour, ref: string): Cell | undefined {
  const trimmed = ref.trim()
  const direct = b.cells.find((c) => cellRef(c) === trimmed)
  if (direct) return direct
  // `cart.items` — a member of a page cell
  try {
    const { root } = parseRefPath(trimmed)
    return b.cells.find((c) => c.node == null && c.name === root)
  } catch {
    return undefined
  }
}

// ---- validation ----

export interface AddressingIssue {
  where: string
  message: string
}

export function validateBehaviour(b: Behaviour, nodeIds: Set<NodeId>): AddressingIssue[] {
  const issues: AddressingIssue[] = []
  const add = (where: string, message: string) => issues.push({ where, message })

  const checkExpr = (expr: Expr | undefined, where: string): void => {
    if (expr == null) return
    for (const name of unresolvedNames(expr)) add(where, `unknown reference '${name}'`)
    walkRefs(expr, (r) => {
      if (r.kind === 'cell' && !cellById(b, r.cell)) add(where, `reference to a cell that no longer exists`)
      if (r.kind === 'node' && !nodeIds.has(r.node)) add(where, `reference to unknown node '${r.node}'`)
    })
  }

  const targetCell = (t: Ref): Cell | undefined => (t.kind === 'cell' ? cellById(b, t.cell) : undefined)

  const validateAction = (a: Action, where: string): void => {
    const entry = getAction(a.type)
    if (!entry) {
      add(where, `unknown action '${a.type}'`)
      return
    }
    if (entry.expects.value && a.value == null) add(where, `action '${a.type}' requires a value`)
    checkExpr(a.value, `${where}.value`)
    for (const p of entry.expects.params ?? []) {
      const v = a.params?.[p.key]
      if (v !== undefined && typeof v === 'object') checkExpr(v as Expr, `${where}.${p.key}`)
    }

    const want = entry.expects.target
    if (!want || want === 'none') return
    // screen/overlay ids are opaque for now (no screen registry yet).
    if (want === 'screen' || want === 'overlay') return

    if (a.target == null) {
      add(where, `action '${a.type}' requires a target`)
      return
    }
    const shown = refName(a.target, b)
    if (want === 'slot') {
      if (a.target.kind !== 'node') add(where, `target '${shown}' must be a slot node`)
      else if (!nodeIds.has(a.target.node)) add(where, `target references unknown '${shown}'`)
      return
    }
    if (a.target.kind === 'name') {
      add(where, `target references unknown '${shown}'`)
      return
    }
    const cell = targetCell(a.target)
    if (!cell) {
      add(where, `target '${shown}' is not a value`)
      return
    }
    if (isFormula(cell)) add(where, `target '${shown}' is a formula — computed, not writable`)
    else if (want === 'collection' && !isCollectionType(cell.type)) add(where, `target '${shown}' must be a list`)
  }

  b.cells.forEach((c, i) => {
    const where = `cell[${i}](${cellRef(c)})`
    if (c.node != null && !nodeIds.has(c.node)) add(where, `cell on unknown node '${c.node}'`)
    checkExpr(c.formula, `${where}.formula`)
    if (isEnumType(c.type) && !c.formula && typeof c.initial === 'string' && !c.type.enum.includes(c.initial)) {
      add(where, `initial '${c.initial}' is not one of [${c.type.enum.join(', ')}]`)
    }
  })

  b.bindings.forEach((x, i) => {
    const where = `bindings[${i}](${x.node}.${x.prop})`
    if (!nodeIds.has(x.node)) add(where, `references on unknown node '${x.node}'`)
    checkExpr(x.expr, where)
    if (x.prop === REPEAT_PROP) {
      const cell = x.expr.type === 'ref' ? targetCell(x.expr.ref) : undefined
      const shown = x.expr.type === 'ref' ? refName(x.expr.ref, b) : '<expression>'
      if (!cell) add(where, `repeats over unknown reference '${shown}'`)
      else if (!isCollectionType(cell.type)) add(where, `repeats over '${shown}' which is not a list`)
    }
    if (x.item?.key) checkExpr(x.item.key, `${where}.item.key`)
  })

  b.rules.forEach((r, i) => {
    const where = `rule[${i}]`
    const t = getTrigger(r.on.type)
    if (r.node != null) {
      if (!nodeIds.has(r.node)) add(where, `interaction on unknown node '${r.node}'`)
      if (!t) add(where, `unknown trigger '${r.on.type}'`)
    } else if (!t) add(where, `unknown trigger '${r.on.type}'`)
    else if (t.scope !== 'app') add(where, `trigger '${r.on.type}' is node-scoped, not valid as an app rule`)
    checkExpr(r.if, `${where}.if`)
    r.do.forEach((a, j) => validateAction(a, `${where}.do[${j}]`))
  })

  return issues
}

/** Re-exported for callers that only need the type predicate. */
export type { ValueType }
