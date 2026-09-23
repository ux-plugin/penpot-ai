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
 * Two layers live here: the stored sugar above (what the inspector edits, what
 * serializes, page-scoped and referencing shapes by id) and the normalized
 * reactive graph (`GraphNode`) it compiles into — a compile artifact, never
 * stored. Trigger/action types are OPEN string unions backed by the catalog
 * (./catalog), so new interaction types are additive entries. Expressions are
 * stored as TREES whose references are ids (`Expr`/`Ref`), so a rename never
 * breaks a wire; text is a projection (./expr).
 *
 * Stores are DOCUMENT-wide (a data source is the same on every page); they live
 * on the document (`DocumentMeta.stores`), and a cell names its store by id.
 */

import type { ExprNode } from './expression'

/** A shape id — a `Node` id. */
export type NodeId = string

/** JSON-serializable value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/**
 * A resolved reference — WHAT an expression or action target points at, by id.
 * Names are for people (`draft`, `card.state`); identity never depends on them,
 * so renaming a cell touches nothing else.
 *   - `cell`  a cell, by `Cell.uid`
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

/**
 * Who a cell belongs to — and so where the inspector shows it: the document's
 * cells and the page's on the page (nothing selected), a node's on that node.
 */
export type Owner = { kind: 'document' } | { kind: 'page' } | { kind: 'node'; node: NodeId }

/**
 * A named container the designer CREATES — a store, table, or "app state". It is
 * the seam to real data: the thing a real database or API binds to at handover.
 * Its cells are supplied from outside rather than decided by the design, which
 * is why membership (`Cell.store`) is the whole "comes from outside" statement.
 * `description` says what real data the store maps to, for whoever binds it.
 */
export interface Store {
  id: string
  description?: string
}

/**
 * The one kind of state.
 *
 * A cell either holds a value (`initial` is what the preview starts from — the
 * sample, if it lives in a store) or is a FORMULA (`formula` present): computed
 * from other cells and therefore read-only. A variant set is a cell of `{ enum }`
 * type owned by its node. Nothing a designer wires to is anything but one of
 * these, so "wire this button to that value" never depends on which sort of
 * value it is.
 */
export interface Cell {
  /** Stable identity, never shown. What every `Ref` points at. */
  uid: string
  /** The name people see and expressions print: `draft`, or `state` in `card.state`. */
  id: string
  owner: Owner
  type: ValueType
  /** The starting value — the sample, for a store cell. Ignored by a formula. */
  initial: Json
  /** Present ⇒ computed, read-only. */
  formula?: Expr
  /** The store this cell lives in. Present ⇔ the value is supplied from outside. */
  store?: string
  /** Prose for a store cell: what real value this is, in the designer's words. */
  description?: string
  persist?: Persistence
}

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

/**
 * How a cell is named in expressions and action targets: a page or document
 * cell by its id, a node's cell as `<node>.<id>` (see `nodeRef`). Also the key
 * the preview runtime stores its value under.
 */
export function cellRef(c: Cell): string {
  return c.owner.kind === 'node' ? `${nodeRef(c.owner.node)}.${c.id}` : c.id
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

/** A node-attached interaction: trigger -> guard -> actions. */
export interface Interaction {
  id?: string
  on: { node: NodeId; trigger: Trigger }
  /** Guard expression -> a `filter`. */
  if?: Expr
  do: Action[]
}

/**
 * An app/page-scoped rule with no owning node — on-load, timer, key, scroll-end,
 * resize, data-change, hardware back. Same shape, page-level source.
 */
export interface AppRule {
  id?: string
  on: Trigger
  if?: Expr
  do: Action[]
}

// ---- property references ----

/**
 * A node's properties that reference cells instead of holding a literal. Each
 * entry lowers to a `sink`. Two property names are reserved:
 *   - `value` on a node, when the expression is a bare writable cell, makes the
 *     node EDIT that cell (two-way): the read is the sink, the write folds the
 *     node's change event back into the cell. The node's role becomes a field.
 *   - `repeat` marks the node as a template repeated over the list the
 *     expression names; runtime instances carry `data-instance-key`. `item`
 *     names the loop variable (default `item`) and keys the instances.
 */
export interface NodeRefs {
  node: NodeId
  props: Record<string, Expr>
  /** Loop settings, meaningful only with `props.repeat`. */
  item?: { as?: string; key?: Expr }
}

export const REPEAT_PROP = 'repeat'
export const VALUE_PROP = 'value'

// ---- the page-scoped block ----

export interface PageInteractions {
  version: 3
  cells: Cell[]
  refs: NodeRefs[]
  interactions: Interaction[]
  appRules: AppRule[]
}

export function emptyPageInteractions(): PageInteractions {
  return { version: 3, cells: [], refs: [], interactions: [], appRules: [] }
}

/** The cell `ref` names, if any: `items`, or `card.state` for a node's cell. */
export function findCell(ir: PageInteractions, ref: string): Cell | undefined {
  return ir.cells.find((c) => cellRef(c) === ref)
}

/** The cell with this identity, if any. */
export function cellByUid(ir: PageInteractions, uid: string): Cell | undefined {
  return ir.cells.find((c) => c.uid === uid)
}

/** The cell a reference points at, if it points at one. */
export function cellOf(ir: PageInteractions, ref: Ref | undefined): Cell | undefined {
  return ref?.kind === 'cell' ? cellByUid(ir, ref.cell) : undefined
}

/** A fresh cell identity. Opaque; only ever compared for equality. */
export function newCellUid(): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14)
  return `c_${rnd}`
}

/** A node's property references, or none. */
export function refsOf(ir: PageInteractions, node: NodeId): NodeRefs | undefined {
  return ir.refs.find((r) => r.node === node)
}

/** The expression a node's property references, if it references one. */
export function propRef(ir: PageInteractions, node: NodeId, prop: string): Expr | undefined {
  return refsOf(ir, node)?.props[prop]
}

/**
 * Whether a node EDITS a cell through `value`: the property references a bare
 * cell that can be written. Read-only because it is a formula, or an expression
 * over cells rather than a cell, is a plain one-way reference.
 */
export function editedCell(ir: PageInteractions, node: NodeId): Cell | undefined {
  const expr = propRef(ir, node, VALUE_PROP)
  if (!expr || expr.type !== 'ref') return undefined
  const cell = cellOf(ir, expr.ref)
  return cell && !isFormula(cell) ? cell : undefined
}

/**
 * Why a cell cannot be edited, or null if it can. Only ONE thing is genuinely
 * unwritable: a formula, which is a function of other cells, so writing to it is
 * a category error rather than a missing feature. A store cell is editable — what
 * a write has to do to reach the real source is derived plumbing.
 */
export function editableError(ir: PageInteractions, target: string): string | null {
  if (!target.trim()) return 'Pick a value to edit'
  const cell = findCell(ir, target)
  if (!cell) return `${target} is not a value on this page`
  if (isFormula(cell)) return `${target} is a formula — computed, not editable`
  return null
}

// ---- regenerate / merge contract ----

export interface MergeReport {
  /** Behavior whose owning node no longer exists in the regenerated presentation. */
  dangling: { kind: 'interaction' | 'refs' | 'cell'; node: NodeId }[]
  ok: boolean
}

/**
 * The IR without anything owned by `ids`: their interactions, their refs,
 * their own cells. Expressions elsewhere that mention those cells are left as
 * they are — `validatePageInteractions` reports them. Returns the same object
 * when nothing changes. Pure.
 */
export function dropNodes(ir: PageInteractions, ids: ReadonlySet<NodeId>): PageInteractions {
  const interactions = ir.interactions.filter((it) => !ids.has(it.on.node))
  const refs = ir.refs.filter((r) => !ids.has(r.node))
  const cells = ir.cells.filter((c) => !(c.owner.kind === 'node' && ids.has(c.owner.node)))
  if (interactions.length === ir.interactions.length && refs.length === ir.refs.length && cells.length === ir.cells.length) return ir
  return { ...ir, interactions, refs, cells }
}

/** Collect every NodeId the IR references. */
export function referencedNodeIds(ir: PageInteractions): Set<NodeId> {
  const ids = new Set<NodeId>()
  for (const it of ir.interactions) ids.add(it.on.node)
  for (const r of ir.refs) ids.add(r.node)
  for (const c of ir.cells) if (c.owner.kind === 'node') ids.add(c.owner.node)
  return ids
}

/**
 * The behavior IR is the source of truth. Given the node ids present in a freshly
 * (re)generated presentation, report behavior that lost its node. New nodes with
 * no behavior are expected (not an error), so they are not reported. Pure.
 */
export function reconcile(ir: PageInteractions, presentNodeIds: Set<NodeId>): MergeReport {
  const dangling: MergeReport['dangling'] = []
  for (const it of ir.interactions) if (!presentNodeIds.has(it.on.node)) dangling.push({ kind: 'interaction', node: it.on.node })
  for (const r of ir.refs) if (!presentNodeIds.has(r.node)) dangling.push({ kind: 'refs', node: r.node })
  for (const c of ir.cells) if (c.owner.kind === 'node' && !presentNodeIds.has(c.owner.node)) dangling.push({ kind: 'cell', node: c.owner.node })
  return { dangling, ok: dangling.length === 0 }
}

// ---- earlier stored shapes (upgraded on read by ./upgrade) ----
//
// Version 2 stored expressions as source text and addressed cells by name.
// Version 1 stored six things version 2 says with two. Both are read-only
// shapes kept here so a stored document of any version loads.

export interface V2Cell {
  id: string
  owner: Owner
  type: ValueType
  initial: Json
  formula?: string
  store?: string
  description?: string
  persist?: Persistence
}

export interface V2Action {
  type: ActionType
  /** A reference in the name grammar: `items`, `card.state`, `cart.items`, or a slot id. */
  target?: string
  value?: string
  params?: Record<string, Json>
}

export interface V2Interaction {
  id?: string
  on: { node: NodeId; trigger: Trigger }
  if?: string
  do: V2Action[]
}

export interface V2AppRule {
  id?: string
  on: Trigger
  if?: string
  do: V2Action[]
}

export interface V2NodeRefs {
  node: NodeId
  props: Record<string, string>
  item?: { as?: string; key?: string }
}

export interface V2PageInteractions {
  version: 2
  cells: V2Cell[]
  refs: V2NodeRefs[]
  interactions: V2Interaction[]
  appRules: V2AppRule[]
}

export interface V1Variable {
  id: string
  type: ValueType
  scope: 'local' | 'page' | 'global'
  initial: Json
  store?: string
  description?: string
  persist?: Persistence
}

export interface V1PageInteractions {
  version: 1
  stores: Store[]
  variables: V1Variable[]
  derived: { id: string; expr: string }[]
  interactions: V2Interaction[]
  appRules: V2AppRule[]
  bindings: { node: NodeId; prop: string; from: string }[]
  editable: { node: NodeId; prop: string; target: string }[]
  states: { node: NodeId; states: string[]; active: { from: 'self'; initial?: string } | { bind: string } }[]
  repeaters: { node: NodeId; over: string; as?: string; key?: string }[]
}

/** The node's variant cell is named `state`, as `<node>.state` was in version 1. */
export const STATE_CELL = 'state'

export type AnyPageInteractions = PageInteractions | V2PageInteractions | V1PageInteractions

export function isV1(ir: AnyPageInteractions): ir is V1PageInteractions {
  return (ir as { version?: number }).version === 1
}

export function isV2(ir: AnyPageInteractions): ir is V2PageInteractions {
  return (ir as { version?: number }).version === 2
}

// ---- normalized reactive graph (compile artifact; built by ./compile/normalize) ----
//
// The semantic target the sugar compiles into. NOTE the asymmetry with the stored
// sugar: `port` survives HERE and only here. The designer authors one kind of
// cell and never says "port"; the graph, where plumbing lives, still expresses
// "this value crosses the boundary". A store cell lowers to a port node; a write
// to it grows an edge out of one. Both are derived.

export type GraphValueKind = 'signal' | 'event'

export type SourceOf =
  | { source: 'event'; node?: NodeId; trigger: TriggerType }
  | { source: 'state'; cell: string }
  | { source: 'port'; port: string }

export type GraphNode =
  | { kind: 'source'; id: string; produces: GraphValueKind; of: SourceOf }
  | { kind: 'filter'; id: string; in: string; cond: Expr } // event -> event
  | { kind: 'derive'; id: string; inputs: string[]; expr: Expr } // signals -> signal
  | { kind: 'fold'; id: string; on: string; state: string; reducer: Expr } // event × signal -> signal
  | { kind: 'sample'; id: string; on: string; read: string } // event × signal -> event
  | { kind: 'switch'; id: string; on: string; cases: Record<string, string> }
  | { kind: 'effect'; id: string; on: string; call: string; ok?: string; err?: string }
  | { kind: 'sink'; id: string; from: Expr; node: NodeId; prop: string }
  | { kind: 'port'; id: string; dir: 'in' | 'out' }

export interface ReactiveGraph {
  nodes: GraphNode[]
  /** dataflow edges: producer node id -> consumer node id. */
  edges: { from: string; to: string }[]
}
