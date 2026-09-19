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
 * stored as source text (a constrained JS subset, ./expression) and parsed at
 * compile time, which keeps the IR diffable.
 *
 * Stores are DOCUMENT-wide (a data source is the same on every page); they live
 * on the document (`DocumentMeta.stores`), and a cell names its store by id.
 */

/** A shape id — the key in `IndexedPage.objects`. */
export type NodeId = string

/** JSON-serializable value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/**
 * Expression source text in the constrained JS subset (see ./expression).
 * Pure, total, no side effects. Parsed to an AST at compile time.
 */
export type Expr = string

/**
 * A reference in the addressing grammar (see ./addressing), stored as source:
 *   `items` | `card.state` | `onSave`
 */
export type Ref = string

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
export function cellRef(c: Cell): Ref {
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
 * Read an expression param off an action (`where`, `at`, …), normalizing absent,
 * non-string, and blank to `undefined` so callers get one "not supplied" case.
 * Which keys an action reads is declared by its catalog entry's `expects.params`.
 */
export function actionParam(a: Action, key: string): Expr | undefined {
  const v = a.params?.[key]
  return typeof v === 'string' && v.trim() ? v : undefined
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
  version: 2
  cells: Cell[]
  refs: NodeRefs[]
  interactions: Interaction[]
  appRules: AppRule[]
}

export function emptyPageInteractions(): PageInteractions {
  return { version: 2, cells: [], refs: [], interactions: [], appRules: [] }
}

/** The cell `ref` names, if any: `items`, or `card.state` for a node's cell. */
export function findCell(ir: PageInteractions, ref: Ref): Cell | undefined {
  return ir.cells.find((c) => cellRef(c) === ref)
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
  if (!expr) return undefined
  const cell = findCell(ir, expr.trim())
  return cell && !isFormula(cell) ? cell : undefined
}

/**
 * Why a cell cannot be edited, or null if it can. Only ONE thing is genuinely
 * unwritable: a formula, which is a function of other cells, so writing to it is
 * a category error rather than a missing feature. A store cell is editable — what
 * a write has to do to reach the real source is derived plumbing.
 */
export function editableError(ir: PageInteractions, target: Ref): string | null {
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

// ---- version 1 → 2 ----
//
// Version 1 stored six things a version-2 document says with two: variables and
// derived values (cells), node variant states (a node's enum cell, named `state`
// so `card.state` keeps meaning what it meant), bindings and editables and
// repeaters (property references). Stores were page-scoped; `upgrade` hands them
// back for the caller to hoist onto the document.

interface V1Variable {
  id: string
  type: ValueType
  scope: 'local' | 'page' | 'global'
  initial: Json
  store?: string
  description?: string
  persist?: Persistence
}

interface V1PageInteractions {
  version: 1
  stores: Store[]
  variables: V1Variable[]
  derived: { id: string; expr: Expr }[]
  interactions: Interaction[]
  appRules: AppRule[]
  bindings: { node: NodeId; prop: string; from: Expr }[]
  editable: { node: NodeId; prop: string; target: Ref }[]
  states: { node: NodeId; states: string[]; active: { from: 'self'; initial?: string } | { bind: Expr } }[]
  repeaters: { node: NodeId; over: Ref; as?: string; key?: Expr }[]
}

/** The node's variant cell is named `state`, as `<node>.state` was in version 1. */
export const STATE_CELL = 'state'

export type AnyPageInteractions = PageInteractions | V1PageInteractions

/** Whether a stored block still has the version-1 shape. */
export function isV1(ir: AnyPageInteractions): ir is V1PageInteractions {
  return (ir as { version?: number }).version === 1
}

/**
 * Upgrade a version-1 block. Returns the version-2 block and the stores it
 * carried, for the document to adopt. Pure; a version-2 block passes through
 * with no stores.
 */
export function upgradePageInteractions(ir: AnyPageInteractions): { ir: PageInteractions; stores: Store[] } {
  if (!isV1(ir)) return { ir, stores: [] }
  const cells: Cell[] = []
  for (const v of ir.variables ?? []) {
    const owner: Owner = v.scope === 'global' ? { kind: 'document' } : { kind: 'page' }
    const cell: Cell = { id: v.id, owner, type: v.type, initial: v.initial }
    if (v.store) cell.store = v.store
    if (v.description) cell.description = v.description
    if (v.persist) cell.persist = v.persist
    cells.push(cell)
  }
  for (const d of ir.derived ?? []) cells.push({ id: d.id, owner: { kind: 'page' }, type: 'any', initial: null, formula: d.expr })
  for (const s of ir.states ?? []) {
    const cell: Cell = { id: STATE_CELL, owner: { kind: 'node', node: s.node }, type: { enum: s.states }, initial: null }
    if ('bind' in s.active) cell.formula = s.active.bind
    else cell.initial = s.active.initial ?? s.states[0] ?? null
    cells.push(cell)
  }

  const refs = new Map<NodeId, NodeRefs>()
  const at = (node: NodeId): NodeRefs => {
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
    const item: NonNullable<NodeRefs['item']> = {}
    if (rep.as) item.as = rep.as
    if (rep.key) item.key = rep.key
    if (Object.keys(item).length) r.item = item
  }

  // `node.setState` on `<node>.state` is `set-variable` on the node's cell.
  const action = (a: Action): Action => (a.type === 'node.setState' ? { ...a, type: 'set-variable' } : a)
  const interactions = (ir.interactions ?? []).map((it) => ({ ...it, do: it.do.map(action) }))
  const appRules = (ir.appRules ?? []).map((ar) => ({ ...ar, do: ar.do.map(action) }))

  return {
    ir: { version: 2, cells, refs: [...refs.values()], interactions, appRules },
    stores: ir.stores ?? [],
  }
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
  | { source: 'state'; cell: Ref }
  | { source: 'port'; port: string }

export type GraphNode =
  | { kind: 'source'; id: string; produces: GraphValueKind; of: SourceOf }
  | { kind: 'filter'; id: string; in: string; cond: Expr } // event -> event
  | { kind: 'derive'; id: string; inputs: string[]; expr: Expr } // signals -> signal
  | { kind: 'fold'; id: string; on: string; state: string; reducer: Expr } // event × signal -> signal
  | { kind: 'sample'; id: string; on: string; read: string } // event × signal -> event
  | { kind: 'switch'; id: string; on: string; cases: Record<string, string> }
  | { kind: 'effect'; id: string; on: string; call: string; ok?: string; err?: string }
  | { kind: 'sink'; id: string; from: string; node: NodeId; prop: string }
  | { kind: 'port'; id: string; dir: 'in' | 'out' }

export interface ReactiveGraph {
  nodes: GraphNode[]
  /** dataflow edges: producer node id -> consumer node id. */
  edges: { from: string; to: string }[]
}
