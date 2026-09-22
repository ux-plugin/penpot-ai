/**
 * Preview runtime — a small LIVE interpreter for a PageInteractions IR.
 *
 * This is the "preview mode" counterpart to the React emitter: instead of
 * generating source, it runs the IR directly (cells + formulas + actions) so the
 * design tool can show an interactive prototype. It shares semantics with the
 * emitter by reusing the same expression evaluator, and it's a *pure* core
 * (no React) so the behavior is unit-testable in node — the React renderer
 * (InteractionRuntime.tsx) is a thin wrapper over these functions.
 */

import type { PageInteractions, Interaction, Action, NodeId, Cell, Expr, Ref } from '../ir'
import { actionParam, isBacked, isFormula, isEnumType, cellRef, cellOf, nodeRef, refsOf, LIT, REPEAT_PROP } from '../ir'
import { evaluate } from '../expression'
import { namesOf } from '../expr'

export interface RuntimeState {
  /**
   * cell -> value, keyed by `cellRef` (`draft`, `card.state`), seeded from each
   * cell's `initial` (its sample, if it lives in a store). Formulas are not
   * stored; `buildEnv` computes them.
   */
  store: Record<string, unknown>
  /**
   * slot id -> active view-frame id, set by `show-in-slot`. A runtime *override*:
   * empty until a swap fires, at which point the renderer prefers this over the
   * slot's own `activeView` design default. (Slot defaults live on the document
   * objects, not the IR, so they can't be seeded here.)
   */
  slotViews: Record<string, string>
}

const safeEval = (expr: Expr, env: Record<string, unknown>, ir: PageInteractions): unknown => {
  try {
    return evaluate(namesOf(expr, ir), env)
  } catch {
    return undefined
  }
}

/** A cell's current value in an environment (a node's cell sits under its node). */
export function cellValue(env: Record<string, unknown>, c: Cell): unknown {
  if (c.owner.kind !== 'node') return env[c.id]
  const root = env[nodeRef(c.owner.node)]
  return isRecord(root) ? root[c.id] : undefined
}
const asArray = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const asNumber = (x: unknown): number => {
  const n = Number(x)
  return Number.isFinite(n) ? n : 0
}
/**
 * Whether an expression is an object literal — the signal that a
 * `collection.update` value is a PATCH to merge rather than a replacement. The
 * emitter makes the same call on the same AST, so preview and generated code
 * agree without either inspecting runtime values.
 */
const isObjectLiteral = (expr: Expr): boolean => expr.type === 'object'
// JSON round-trip, not structuredClone: cell initials are always JSON, and the
// IR may arrive as a valtio tracking proxy (from useSnapshot) that
// structuredClone rejects with DataCloneError.
const clone = <T>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T))

/** A cell's starting value: its initial, or an enum's first value when unset. */
function startValue(c: Cell): unknown {
  if (isEnumType(c.type) && (c.initial === null || c.initial === undefined)) return c.type.enum[0]
  return clone(c.initial)
}

export function initRuntime(ir: PageInteractions): RuntimeState {
  // One loop for every cell, wherever its value comes from: a store cell's
  // `initial` IS its sample, which is what the preview runs on. A cell with no
  // sample stays undefined and renders as nothing — the honest display of "the
  // design doesn't know this value", not a rendering bug.
  const store: Record<string, unknown> = {}
  for (const c of ir.cells) if (!isFormula(c)) store[cellRef(c)] = startValue(c)
  return { store, slotViews: {} }
}

/**
 * Write a cell's value into an environment: a page or document cell under its
 * id, a node's cell under `env[node][cell]` so `card.state` evaluates.
 */
function place(env: Record<string, unknown>, c: Cell, value: unknown): void {
  if (c.owner.kind === 'node') {
    const root = nodeRef(c.owner.node)
    env[root] = { ...(isRecord(env[root]) ? env[root] : {}), [c.id]: value }
  } else env[c.id] = value
}

/** Build the evaluation environment: stored cells, then formulas in declaration order. */
export function buildEnv(ir: PageInteractions, rt: RuntimeState, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const env: Record<string, unknown> = { ...extra }
  for (const c of ir.cells) if (!isFormula(c)) place(env, c, rt.store[cellRef(c)])
  for (const c of ir.cells) if (isFormula(c)) place(env, c, safeEval(c.formula!, env, ir))
  return env
}

/** The store key an action target writes: the cell it addresses (`card.state`), or a node (a slot). */
function targetKey(ir: PageInteractions, target: Ref | undefined): string {
  if (!target) return ''
  switch (target.kind) {
    case 'cell': {
      const c = cellOf(ir, target)
      return c ? cellRef(c) : target.cell
    }
    case 'node':
      return target.node
    default:
      return target.name
  }
}

/** Apply one action. `ir` resolves the target to its cell (a node's cell is stored as `card.state`). */
export function applyAction(a: Action, env: Record<string, unknown>, rt: RuntimeState, ir: PageInteractions): RuntimeState {
  const key = targetKey(ir, a.target)
  const value = a.value != null ? safeEval(a.value, env, ir) : undefined
  const setVar = (v: unknown): RuntimeState => ({ ...rt, store: { ...rt.store, [key]: v } })
  switch (a.type) {
    case 'collection.append':
      return setVar([...asArray(rt.store[key]), value])
    case 'collection.insert': {
      // `at` clamps into range; absent means 0, so the plain form is a prepend.
      const prev = asArray(rt.store[key])
      const at = Math.max(0, Math.min(prev.length, Math.trunc(asNumber(safeEval(actionParam(a, 'at') ?? LIT(0), env, ir)))))
      return setVar([...prev.slice(0, at), value, ...prev.slice(at)])
    }
    case 'collection.remove':
      return setVar(asArray(rt.store[key]).filter((item) => !safeEval(a.value ?? LIT(false), { ...env, item }, ir)))
    case 'collection.update': {
      const where = actionParam(a, 'where')
      const patch = a.value ? isObjectLiteral(a.value) : false
      return setVar(
        asArray(rt.store[key]).map((item) => {
          const itemEnv = { ...env, item }
          // No `where` means every item — stated in the panel, never silent.
          if (where && !safeEval(where, itemEnv, ir)) return item
          if (!a.value) return item
          const next = safeEval(a.value, itemEnv, ir)
          return patch && isRecord(item) && isRecord(next) ? { ...item, ...next } : next
        }),
      )
    }
    case 'collection.clear':
      return setVar([])
    case 'set-variable':
      return setVar(value)
    case 'toggle-variable':
      return setVar(!rt.store[key])
    case 'increment':
      // Absent (or blank) value means +1, so the common stepper case needs no
      // expression. The emitter branches on the same truthiness.
      return setVar(asNumber(rt.store[key]) + (a.value ? asNumber(value) : 1))
    case 'show-in-slot':
      // target = the slot node; value = a *literal* view-frame id (a string
      // literal, not an expression — a raw UUID wouldn't evaluate). Default
      // in-place swap, no history — routing is a lowering concern.
      return { ...rt, slotViews: { ...rt.slotViews, [key]: typeof value === 'string' ? value : '' } }
    case 'open-url':
      if (typeof value === 'string' && typeof window !== 'undefined') window.open(value)
      return rt
    default:
      // navigate / overlay / unimplemented — preview no-op
      return rt
  }
}

/**
 * Which view a slot renders: a fired `show-in-slot` override (in `slotViews`)
 * wins over the slot's design-time default (`activeView`). Shared by the preview
 * runtime and any renderer so the precedence is defined in exactly one place.
 * Returns undefined for an empty slot (no override and no default).
 */
export function activeSlotView(
  slotViews: Record<string, string>,
  slotId: string,
  designDefault: string | undefined,
): string | undefined {
  return slotViews[slotId] ?? designDefault
}

export function runInteraction(ir: PageInteractions, rt: RuntimeState, it: Interaction, env: Record<string, unknown>): RuntimeState {
  if (it.if && !safeEval(it.if, env, ir)) return rt
  let next = rt
  for (const a of it.do) next = applyAction(a, env, next, ir)
  return next
}

// ---- observability -------------------------------------------------------
//
// An action's effect often lands somewhere you can't see — a cell read by a
// reference on another node, a variant swap on a node outside the current scope.
// Because `applyAction` is pure, the before/after states are fully diffable, so
// what changed can be COMPUTED rather than guessed. These functions back the
// Build stage's state panel and its "changes outside this view" chip.

/** One cell of runtime state that moved. */
export interface StateChange {
  kind: 'cell' | 'slot'
  /** The cell (`draft`, `card.state`) or slot id. */
  id: string
  before: unknown
  after: unknown
}

/** A node whose rendering is invalidated by a state change, and why. */
export interface AffectedNode {
  node: NodeId
  /** Referenced props that changed (`text`, `background`, …) plus synthetic markers. */
  props: string[]
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function diffRecord(
  kind: StateChange['kind'],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): StateChange[] {
  const out: StateChange[] = []
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!same(before[id], after[id])) out.push({ kind, id, before: before[id], after: after[id] })
  }
  return out
}

/** Every cell that differs between two runtime states. */
export function diffRuntime(before: RuntimeState, after: RuntimeState): StateChange[] {
  return [...diffRecord('cell', before.store, after.store), ...diffRecord('slot', before.slotViews, after.slotViews)]
}

/**
 * Whether a change also LEFT the design — i.e. it wrote a cell backed from
 * outside, so the real app has to hear about it.
 *
 * Derived, not recorded. There is no log of outward calls because there is no
 * authored outward call: the write is the event, and living in a store is what
 * makes it one. Same question `normalize` answers by growing an out port and
 * `emitReactComponent` answers by emitting a callback.
 */
export function leavesDesign(ir: PageInteractions, change: StateChange): boolean {
  return change.kind === 'cell' && ir.cells.some((c) => cellRef(c) === change.id && isBacked(c))
}

/**
 * Which nodes render differently across a state change. Property references
 * are the main signal — each one is re-evaluated in both environments — plus
 * nodes whose own cell changed, and slots that swapped.
 *
 * Known gap: a reference scoped to a repeated item (referencing `item`)
 * evaluates to undefined in both environments, so it never reports on its own.
 * The `repeat` reference covers that case at the template level instead.
 */
export function affectedNodes(ir: PageInteractions, before: RuntimeState, after: RuntimeState): AffectedNode[] {
  const envBefore = buildEnv(ir, before)
  const envAfter = buildEnv(ir, after)
  const byNode = new Map<NodeId, Set<string>>()
  const mark = (node: NodeId, prop: string) => {
    const set = byNode.get(node) ?? new Set<string>()
    set.add(prop)
    byNode.set(node, set)
  }

  for (const r of ir.refs) {
    for (const [prop, expr] of Object.entries(r.props)) {
      if (!same(safeEval(expr, envBefore, ir), safeEval(expr, envAfter, ir))) mark(r.node, prop === REPEAT_PROP ? 'list' : prop)
    }
  }
  for (const c of diffRecord('cell', before.store, after.store)) {
    const cell = ir.cells.find((x) => cellRef(x) === c.id)
    if (cell?.owner.kind === 'node') mark(cell.owner.node, cell.id)
  }
  for (const c of diffRecord('slot', before.slotViews, after.slotViews)) mark(c.id, 'view')

  return [...byNode].map(([node, props]) => ({ node, props: [...props] }))
}

/** One fired interaction and everything it moved — the state panel's feed. */
export interface ActivityEntry {
  node: NodeId
  trigger: string
  changes: StateChange[]
  affected: AffectedNode[]
}

/** A log line: an entry plus how many times it repeated back to back. */
export type LoggedActivity = ActivityEntry & { count: number }

const ACTIVITY_CAP = 20

/**
 * Prepend an entry to the activity log, newest first. Identical consecutive
 * entries collapse into a count instead of flooding the list (a timer or a
 * fast-repeated click would otherwise bury everything else), and the log is
 * capped so it can't grow without bound.
 */
export function pushActivity(log: LoggedActivity[], entry: ActivityEntry, cap = ACTIVITY_CAP): LoggedActivity[] {
  const head = log[0]
  if (head && head.node === entry.node && head.trigger === entry.trigger && same(head.changes, entry.changes)) {
    return [{ ...head, count: head.count + 1 }, ...log.slice(1)]
  }
  return [{ ...entry, count: 1 }, ...log].slice(0, cap)
}

/** The list a repeated node maps over, if the node is repeated. */
export function repeatOf(ir: PageInteractions, node: NodeId): { over: Expr; as: string; key?: Expr } | undefined {
  const refs = refsOf(ir, node)
  const over = refs?.props[REPEAT_PROP]
  if (!over) return undefined
  return { over, as: refs?.item?.as ?? 'item', key: refs?.item?.key }
}
