/**
 * Addressing — the one namespace every expression, property reference and
 * action target uses.
 *
 *   ref ::= cell                // items, draft            (a page or document cell)
 *         | node '.' cell       // card.state              (a node's own cell)
 *         | loopItem '.' field  // item.label              (inside a repeated node)
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

import type { PageInteractions, NodeId, ValueType, Action, Cell } from './ir'
import { cellRef, nodeRef, isCollectionType, isEnumType, isFormula, REPEAT_PROP } from './ir'
import { parse, freeRefs, type ExprNode } from './expression'
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
  /** A node's own cells by id, for a `node` symbol. */
  cells?: Map<string, Cell>
}

/** A flat symbol table. Precedence on collision: cells and loop items shadow nodes. */
export type Scope = Map<string, Sym>

export function buildScope(ir: PageInteractions, nodeIds: Set<NodeId>): Scope {
  const scope: Scope = new Map()
  // nodes first (lowest precedence), under their id and, when that is not an
  // identifier, the mangled spelling expressions use
  for (const id of nodeIds) {
    const sym: Sym = { name: id, kind: 'node', cells: new Map() }
    scope.set(id, sym)
    scope.set(nodeRef(id), sym)
  }
  for (const c of ir.cells) {
    if (c.owner.kind === 'node') {
      const sym = scope.get(nodeRef(c.owner.node))
      if (sym?.kind === 'node') sym.cells?.set(c.id, c)
      continue
    }
    scope.set(c.id, { name: c.id, kind: 'cell', cell: c })
  }
  // loop items (highest precedence). TODO: scope these to the repeated subtree
  // via the node hierarchy instead of registering them page-wide.
  for (const r of ir.refs) {
    if (!r.props[REPEAT_PROP]) continue
    const name = r.item?.as ?? 'item'
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
 * The cell a reference addresses, or undefined: a page/document cell by its
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

/** The cell `ref` names in `ir`, resolved against the IR alone (no node table). */
export function cellFor(ir: PageInteractions, ref: string): Cell | undefined {
  const trimmed = ref.trim()
  const direct = ir.cells.find((c) => cellRef(c) === trimmed)
  if (direct) return direct
  // `cart.items` — a member of a page cell
  try {
    const { root } = parseRefPath(trimmed)
    return ir.cells.find((c) => c.owner.kind !== 'node' && c.id === root)
  } catch {
    return undefined
  }
}

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
    // screen/overlay ids are opaque strings for now (no screen registry yet).
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
    if (want === 'slot') {
      if (sym.kind !== 'node') add(where, `target '${a.target}' must be a slot node`)
      return
    }
    const cell = resolveCell(scope, a.target)
    if (!cell) {
      add(where, `target '${a.target}' is not a value`)
      return
    }
    if (isFormula(cell)) add(where, `target '${a.target}' is a formula — computed, not writable`)
    else if (want === 'collection' && !isCollectionType(cell.type)) add(where, `target '${a.target}' must be a list`)
  }

  ir.cells.forEach((c, i) => {
    const where = `cell[${i}](${cellRef(c)})`
    if (c.owner.kind === 'node' && !nodeIds.has(c.owner.node)) add(where, `cell on unknown node '${c.owner.node}'`)
    checkExpr(c.formula, `${where}.formula`)
    if (isEnumType(c.type) && !c.formula && typeof c.initial === 'string' && !c.type.enum.includes(c.initial)) {
      add(where, `initial '${c.initial}' is not one of [${c.type.enum.join(', ')}]`)
    }
  })

  ir.refs.forEach((r, i) => {
    if (!nodeIds.has(r.node)) add(`refs[${i}](${r.node})`, `references on unknown node '${r.node}'`)
    for (const [prop, expr] of Object.entries(r.props)) {
      const where = `refs[${i}](${r.node}.${prop})`
      checkExpr(expr, where)
      if (prop === REPEAT_PROP) {
        const cell = resolveCell(scope, expr)
        if (!cell) add(where, `repeats over unknown reference '${expr}'`)
        else if (!isCollectionType(cell.type)) add(where, `repeats over '${expr}' which is not a list`)
      }
    }
    if (r.item?.key) checkExpr(r.item.key, `refs[${i}](${r.node}).item.key`)
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

  return issues
}

/** Re-exported for callers that only need the type predicate. */
export type { ValueType }
