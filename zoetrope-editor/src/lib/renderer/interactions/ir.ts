/**
 * Interactions IR — the stored, declarative model for prototyping interactions.
 *
 * Three ideas, and nothing else:
 *   1. CELLS are the one kind of state. A cell belongs to an owner (the document,
 *      the page, or a node — a component's own state), has a type, and either
 *      holds a value or is a FORMULA over other cells. A node's variant set is a
 *      cell of enum type; a value the real app supplies is a cell that lives in a
 *      STORE.
 *   2. INTERACTIONS write cells. A trigger fires, a guard passes, actions run; an
 *      action targets a cell (or does one of the few non-state things: navigate,
 *      open a URL).
 *   3. NODE PROPERTIES REFERENCE CELLS. Instead of a literal, a property holds an
 *      expression over cells (`text: 'count'`, `disabled: 'draft == ""'`); the
 *      preview and the emitter resolve it. A field whose `value` references a
 *      writable cell edits that cell; a node whose `repeat` references a list is
 *      repeated over it.
 *
 * Each is a record kind of the document (`doc/schema/behaviour.ts`): `cell`,
 * `rule`, `binding`, plus `store`. This module holds the value vocabulary they
 * share and the lookups the engine runs over a page's `Behaviour`.
 * Trigger/action types are OPEN string unions backed by the catalog
 * (./catalog), so new interaction types are additive entries. Expressions are
 * stored as TREES whose references are ids (`Expr`/`Ref`), so a rename never
 * breaks a wire; text is a projection (./expr).
 *
 * Stores are DOCUMENT-wide (a data source is the same on every page); a cell
 * names its store by id.
 */

import type { ExprNode } from './expression'
import type { Binding, Cell, Rule } from '../../doc/schema'

/** A shape id — a `Node` id. */
export type NodeId = string

/** JSON-serializable value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/**
 * A resolved reference — WHAT an expression or action target points at, by id.
 * Names are for people (`draft`, `card.state`); identity never depends on them,
 * so renaming a cell touches nothing else.
 *   - `cell`  a cell, by `Cell.id`
 *   - `item`  the loop variable of a repeated node, by the name it was given
 *   - `node`  a node (a slot to show a view in; the root of `card.state` while resolving)
 *   - `name`  anything else: a lambda parameter, `Math`, or text that resolved
 *             to nothing — validation reports those, printing shows them as typed
 */
export type Ref =
  | { kind: 'cell'; cell: string }
  | { kind: 'item'; name: string }
  | { kind: 'node'; node: NodeId }
  | { kind: 'name'; name: string }

/**
 * A stored expression: the constrained-JS AST (see ./expression) with every
 * reference resolved to a `Ref`. Pure, total, no side effects. Authored as text
 * and parsed+resolved at the edge (./expr); never stored as text.
 */
export type Expr = ExprNode<{ ref: Ref }>

export const LIT = (value: string | number | boolean | null): Expr => ({ type: 'lit', value })
export const REF = (ref: Ref): Expr => ({ type: 'ref', ref })

export type Persistence = 'none' | 'local-storage'

/** Cell type. `{ enum }` is a variant set: the cell holds one of its values. */
export type ValueType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | 'any'
  | { collection: ValueType }
  | { enum: string[] }

export type { Cell, Binding, Rule, Store } from '../../doc/schema'

/**
 * A page's behaviour as the engine reads it: its cells (and the document's),
 * its bindings, its rules in order. Records, grouped; built by `behaviourOf`.
 */
export interface Behaviour {
  cells: readonly Cell[]
  bindings: readonly Binding[]
  rules: readonly Rule[]
}

export const EMPTY_BEHAVIOUR: Behaviour = Object.freeze({ cells: [], bindings: [], rules: [] })

/** Whether a cell is supplied from outside — i.e. lives in a store. */
export function isBacked(c: Cell): boolean {
  return c.store != null
}

export function isFormula(c: Cell): boolean {
  return c.formula != null
}

export function isEnumType(t: ValueType): t is { enum: string[] } {
  return typeof t === 'object' && t !== null && 'enum' in t
}

export function isCollectionType(t: ValueType | undefined): t is { collection: ValueType } {
  return typeof t === 'object' && t !== null && 'collection' in t
}

/** Who a cell belongs to, and so where the inspector shows it. */
export type OwnerKind = 'document' | 'page' | 'node'

export function ownerKind(c: Pick<Cell, 'page' | 'node'>): OwnerKind {
  return c.node != null ? 'node' : c.page != null ? 'page' : 'document'
}

/**
 * How a cell is named in expressions and action targets: a page or document
 * cell by its name, a node's cell as `<node>.<name>` (see `nodeRef`). Also the
 * key the preview runtime stores its value under.
 */
export function cellRef(c: Pick<Cell, 'name' | 'node'>): string {
  return c.node != null ? `${nodeRef(c.node)}.${c.name}` : c.name
}

/**
 * A node as an expression root. A shape id that is a valid identifier (test
 * fixtures name nodes `card`) is used as is; a real UUID is not an identifier, so
 * it is mangled to one. `buildScope` registers the same spelling.
 */
export function nodeRef(node: NodeId): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(node) ? node : `n_${node.replace(/[^A-Za-z0-9_]/g, '_')}`
}

// ---- triggers & actions (open unions; schemas live in ./catalog) ----

/** Open trigger type. Known values are registered in ./catalog. */
export type TriggerType = string

/** Open action type. Known values are registered in ./catalog. */
export type ActionType = string

export interface Trigger {
  type: TriggerType
  /** Catalog-entry-specific params (delay, key, threshold, …). */
  params?: Record<string, Json>
}

/**
 * A single action. Uniform open shape; the catalog entry for `type` defines what
 * `target`/`value` mean and which graph node-kind it lowers to.
 */
export interface Action {
  type: ActionType
  /** Address the action writes to / navigates to (a cell, a slot, a screen). */
  target?: Ref
  /** Value expression (item to append, value to set, url, …). */
  value?: Expr
  params?: Record<string, Json>
}

/**
 * Read an expression param off an action (`where`, `at`, …). Expression params
 * are stored as `Expr` trees inside `params`; anything else there is plain data.
 * Which keys an action reads is declared by its catalog entry's `expects.params`.
 */
export function actionParam(a: Action, key: string): Expr | undefined {
  const v = a.params?.[key]
  return isExpr(v) ? v : undefined
}

/** Whether a JSON value is a stored expression tree. */
export function isExpr(v: unknown): v is Expr {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { type?: unknown }).type === 'string'
}

// ---- property references ----

export const REPEAT_PROP = 'repeat'
export const VALUE_PROP = 'value'

// ---- lookups ----

/** The cell `ref` names, if any: `items`, or `card.state` for a node's cell. */
export function findCell(b: Behaviour, ref: string): Cell | undefined {
  return b.cells.find((c) => cellRef(c) === ref)
}

/** The cell with this identity, if any. */
export function cellById(b: Behaviour, id: string): Cell | undefined {
  return b.cells.find((c) => c.id === id)
}

/** The cell a reference points at, if it points at one. */
export function cellOf(b: Behaviour, ref: Ref | undefined): Cell | undefined {
  return ref?.kind === 'cell' ? cellById(b, ref.cell) : undefined
}

/** A fresh record id. Opaque; only ever compared for equality. */
export function newId(prefix = 'c'): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14)
  return `${prefix}_${rnd}`
}

/** A node's bindings. */
export function bindingsOn(b: Behaviour, node: NodeId): Binding[] {
  return b.bindings.filter((x) => x.node === node)
}

/** The binding on `node.prop`, if any. */
export function bindingOf(b: Behaviour, node: NodeId, prop: string): Binding | undefined {
  return b.bindings.find((x) => x.node === node && x.prop === prop)
}

/** The expression a node's property references, if it references one. */
export function propRef(b: Behaviour, node: NodeId, prop: string): Expr | undefined {
  return bindingOf(b, node, prop)?.expr
}

/** A node's rules, in order. */
export function rulesOn(b: Behaviour, node: NodeId): Rule[] {
  return b.rules.filter((r) => r.node === node)
}

/** The page's own rules (load, timer, key), in order. */
export function pageRules(b: Behaviour): Rule[] {
  return b.rules.filter((r) => r.node == null)
}

/** Every node that carries behaviour: a rule, a binding, or a cell of its own. */
export function behaviourNodes(b: Behaviour): Set<NodeId> {
  const ids = new Set<NodeId>()
  for (const r of b.rules) if (r.node != null) ids.add(r.node)
  for (const x of b.bindings) ids.add(x.node)
  for (const c of b.cells) if (c.node != null) ids.add(c.node)
  return ids
}

/**
 * Whether a node EDITS a cell through `value`: the property references a bare
 * cell that can be written. Read-only because it is a formula, or an expression
 * over cells rather than a cell, is a plain one-way reference.
 */
export function editedCell(b: Behaviour, node: NodeId): Cell | undefined {
  const expr = propRef(b, node, VALUE_PROP)
  if (!expr || expr.type !== 'ref') return undefined
  const cell = cellOf(b, expr.ref)
  return cell && !isFormula(cell) ? cell : undefined
}

/**
 * Why a cell cannot be edited, or null if it can. Only ONE thing is genuinely
 * unwritable: a formula, which is a function of other cells, so writing to it is
 * a category error rather than a missing feature. A store cell is editable — what
 * a write has to do to reach the real source is derived plumbing.
 */
export function editableError(b: Behaviour, target: string): string | null {
  if (!target.trim()) return 'Pick a value to edit'
  const cell = findCell(b, target)
  if (!cell) return `${target} is not a value on this page`
  if (isFormula(cell)) return `${target} is a formula — computed, not editable`
  return null
}
