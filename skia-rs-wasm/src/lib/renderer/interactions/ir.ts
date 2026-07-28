/**
 * Interactions IR — the stored, declarative model for prototyping interactions.
 *
 * Two layers live here:
 *   1. The stored ECA-sugar (what the panel edits, what serializes) — Variable,
 *      Derived, Interaction, AppRule, Binding, NodeStates, Repeater, Port,
 *      gathered per page in `PageInteractions`.
 *   2. The normalized reactive graph (`GraphNode`) the sugar compiles into —
 *      Signals + Events + a fixed combinator set. A compile artifact, not stored.
 *
 * Design rules (see docs/interactions/PHASE_0_PLAN.md):
 *   - ECA is surface sugar; the Signal/Event graph is the foundation.
 *   - Trigger/Action types are OPEN string unions backed by a catalog registry
 *     (./catalog), so new interaction types are additive entries, never a change
 *     to these core types.
 *   - Expressions are stored as source text (a constrained JS subset) and parsed
 *     by ./expression at compile time. Storing the sugar keeps the IR diffable
 *     and round-trippable to the (future) text DSL.
 *   - IR is page-scoped and references shapes by id (the key in
 *     `IndexedPage.objects`); it never modifies the shape/render model.
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
 *   `items` | `addBtn.disabled` | `card.state` | `onSave`
 */
export type Ref = string

export type Scope = 'local' | 'page' | 'global'

export type Persistence = 'none' | 'local-storage'

/** Variable / port value type. */
export type ValueType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | 'any'
  | { collection: ValueType }

/** A piece of app state. Lowers to a `source` producing a Signal. */
export interface Variable {
  id: string
  type: ValueType
  scope: Scope
  initial: Json
  /** `'port'` => generated as a typed prop/callback at the business-logic seam. */
  source: 'local' | 'port'
  persist?: Persistence
}

/** A computed, read-only value. Lowers to a `derive` node. */
export interface Derived {
  id: string
  expr: Expr
}

/** Typed boundary to frontend business logic. */
export interface Port {
  id: string
  dir: 'in' | 'out'
  type: ValueType
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
  /** Address the action writes to / navigates to (variable, node.state, screen). */
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

// ---- ECA sugar (node-scoped & app-scoped) ----

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
 * (Locked core decision: app-rule scope, PHASE_0_PLAN §G1.)
 */
export interface AppRule {
  id?: string
  on: Trigger
  if?: Expr
  do: Action[]
}

// ---- bindings, states, repeaters ----

/** Binds an expression to a node prop. Lowers to a `sink`. */
export interface Binding {
  node: NodeId
  /** e.g. 'disabled' | 'x' | 'opacity' | 'text' | 'visible' | 'state'. */
  prop: string
  from: Expr
}

/**
 * Addressable variant states for a node. The design/AI styles each named state;
 * which one is active is a Signal — driven either by the node's own state machine
 * (`'self'`) or bound to a derived expression.
 */
export interface NodeStates {
  node: NodeId
  states: string[]
  active: { from: 'self'; initial?: string } | { bind: Expr }
}

/**
 * A node that EDITS a state cell — the two-way sugar.
 *
 * Read: `node.prop ← target`. Write: the node's change event folds into
 * `target`. It is stored as sugar rather than as the expanded graph on purpose:
 * some targets have a NATIVE two-way primitive (SwiftUI `$x`, Vue `v-model`,
 * Svelte `bind:`) and can only emit it if the emitter can still see that the
 * author said "this edits that". Recovering that from an expanded
 * sink+source+fold would mean pattern-matching the graph.
 *
 * `normalize` expands it into exactly those three existing primitives, so the
 * reactive graph stays acyclic and one-directional — there is no bidirectional
 * edge anywhere. The read is a Signal, the write is Event-driven; that split is
 * why this is not a feedback loop, and is the same reason a React controlled
 * input terminates.
 */
export interface Editable {
  node: NodeId
  /** Semantic property the node edits through — `value` for a text field. */
  prop: string
  /** The cell being edited. Writability is a property of the cell — see `editableError`. */
  target: Ref
}

/**
 * Marks a node as a template repeated over a collection. The node id is a
 * TEMPLATE anchor; runtime instances carry data-node-id + data-instance-key.
 */
export interface Repeater {
  node: NodeId
  /** Collection variable reference, e.g. 'items'. */
  over: Ref
  /** Loop item name in expressions (default 'item'). */
  as?: string
  /** Item key expression (default 'item.id'). */
  key?: Expr
}

// ---- the page-scoped block (locked storage decision: PHASE_0_PLAN §6.1) ----

export interface PageInteractions {
  version: 1
  variables: Variable[]
  derived: Derived[]
  ports: Port[]
  interactions: Interaction[]
  appRules: AppRule[]
  bindings: Binding[]
  editable: Editable[]
  states: NodeStates[]
  repeaters: Repeater[]
}

/**
 * Why a cell cannot be edited, or null if it can. Writability is a property of
 * the TARGET, not of the node doing the editing:
 *   - a `derived` value is a function of other state — writing to it is a
 *     category error, not a missing feature;
 *   - a port-sourced variable is owned by business logic, and generated
 *     components do not take props yet (see `emitReactComponent`), so there is
 *     nowhere for the write to go.
 */
export function editableError(ir: PageInteractions, target: Ref): string | null {
  if (!target.trim()) return 'Pick a value to edit'
  if (ir.derived.some((d) => d.id === target)) return `${target} is a formula — computed, not editable`
  const variable = ir.variables.find((v) => v.id === target)
  if (!variable) return `${target} is not a variable on this page`
  if (variable.source === 'port') return `${target} comes from business logic — not editable yet`
  return null
}

export function emptyPageInteractions(): PageInteractions {
  return {
    version: 1,
    variables: [],
    derived: [],
    ports: [],
    interactions: [],
    appRules: [],
    bindings: [],
    editable: [],
    states: [],
    repeaters: [],
  }
}

// ---- regenerate / merge contract (locked core decision: PHASE_0_PLAN §G3) ----

export interface MergeReport {
  /** Behavior whose owning node no longer exists in the regenerated presentation. */
  dangling: { kind: 'interaction' | 'binding' | 'editable' | 'state' | 'repeater'; node: NodeId }[]
  ok: boolean
}

/** Collect every NodeId the IR references. */
export function referencedNodeIds(ir: PageInteractions): Set<NodeId> {
  const ids = new Set<NodeId>()
  for (const it of ir.interactions) ids.add(it.on.node)
  for (const b of ir.bindings) ids.add(b.node)
  for (const e of ir.editable) ids.add(e.node)
  for (const s of ir.states) ids.add(s.node)
  for (const r of ir.repeaters) ids.add(r.node)
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
  for (const b of ir.bindings) if (!presentNodeIds.has(b.node)) dangling.push({ kind: 'binding', node: b.node })
  for (const e of ir.editable) if (!presentNodeIds.has(e.node)) dangling.push({ kind: 'editable', node: e.node })
  for (const s of ir.states) if (!presentNodeIds.has(s.node)) dangling.push({ kind: 'state', node: s.node })
  for (const r of ir.repeaters) if (!presentNodeIds.has(r.node)) dangling.push({ kind: 'repeater', node: r.node })
  return { dangling, ok: dangling.length === 0 }
}

// ---- normalized reactive graph (compile artifact; built by ./compile/normalize) ----
//
// The semantic target the ECA-sugar compiles into. Shape may be refined when
// ./compile/normalize lands (Task #4); kept here as the foundation contract.

export type GraphValueKind = 'signal' | 'event'

export type SourceOf =
  | { source: 'event'; node?: NodeId; trigger: TriggerType }
  | { source: 'state'; variable: string }
  | { source: 'derived'; derived: string }
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
