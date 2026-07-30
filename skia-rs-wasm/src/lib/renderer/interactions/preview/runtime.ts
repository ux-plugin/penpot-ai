/**
 * Preview runtime — a small LIVE interpreter for a PageInteractions IR.
 *
 * This is the "preview mode" counterpart to the React emitter: instead of
 * generating source, it runs the IR directly (state + derived + actions) so the
 * design tool can show an interactive prototype. It shares semantics with the
 * emitter by reusing the same expression evaluator, and it's a *pure* core
 * (no React) so the behavior is unit-testable in node — the React renderer
 * (InteractionRuntime.tsx) is a thin wrapper over these functions.
 */

import type { PageInteractions, Interaction, Action, NodeId } from '../ir'
import { actionParam } from '../ir'
import { parse, evaluate } from '../expression'
import { parseRefPath } from '../addressing'

export interface RuntimeState {
  /** cell id -> value, seeded from each cell's `initial` (its sample, if outside) */
  store: Record<string, unknown>
  /** node id -> active self-managed variant state */
  nodeStates: Record<string, string>
  /**
   * slot id -> active view-frame id, set by `show-in-slot`. A runtime *override*:
   * empty until a swap fires, at which point the renderer prefers this over the
   * slot's own `activeView` design default. (Slot defaults live on the document
   * objects, not the IR, so they can't be seeded here.)
   */
  slotViews: Record<string, string>
}

const safeEval = (src: string, env: Record<string, unknown>): unknown => {
  try {
    return evaluate(parse(src), env)
  } catch {
    return undefined
  }
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
const isObjectLiteral = (src: string): boolean => {
  try {
    return parse(src).type === 'object'
  } catch {
    return false
  }
}
// JSON round-trip, not structuredClone: variable initials are always JSON, and
// the IR may arrive as a valtio tracking proxy (from useSnapshot) that
// structuredClone rejects with DataCloneError.
const clone = <T>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T))

export function initRuntime(ir: PageInteractions): RuntimeState {
  // One loop for every cell, wherever its value comes from: an outside cell's
  // `initial` IS its sample, which is what the preview runs on. A cell with no
  // sample stays undefined and renders as nothing — the honest display of "the
  // design doesn't know this value", not a rendering bug.
  const store: Record<string, unknown> = {}
  for (const v of ir.variables) store[v.id] = clone(v.initial)
  const nodeStates: Record<string, string> = {}
  for (const s of ir.states) if ('from' in s.active) nodeStates[s.node] = s.active.initial ?? s.states[0] ?? ''
  return { store, nodeStates, slotViews: {} }
}

/** Build the evaluation environment: variables + derived values + node states. */
export function buildEnv(ir: PageInteractions, rt: RuntimeState, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const env: Record<string, unknown> = { ...rt.store, ...extra }
  for (const d of ir.derived) env[d.id] = safeEval(d.expr, env)
  for (const s of ir.states) {
    env[s.node] = { ...(isRecord(env[s.node]) ? env[s.node] : {}), state: rt.nodeStates[s.node] }
  }
  return env
}

export function applyAction(a: Action, env: Record<string, unknown>, rt: RuntimeState): RuntimeState {
  const root = a.target ? parseRefPath(a.target).root : ''
  const value = a.value != null ? safeEval(a.value, env) : undefined
  const setVar = (v: unknown): RuntimeState => ({ ...rt, store: { ...rt.store, [root]: v } })
  switch (a.type) {
    case 'collection.append':
      return setVar([...asArray(rt.store[root]), value])
    case 'collection.insert': {
      // `at` clamps into range; absent means 0, so the plain form is a prepend.
      const prev = asArray(rt.store[root])
      const at = Math.max(0, Math.min(prev.length, Math.trunc(asNumber(safeEval(actionParam(a, 'at') ?? '0', env)))))
      return setVar([...prev.slice(0, at), value, ...prev.slice(at)])
    }
    case 'collection.remove':
      return setVar(asArray(rt.store[root]).filter((item) => !safeEval(a.value ?? 'false', { ...env, item })))
    case 'collection.update': {
      const where = actionParam(a, 'where')
      const patch = a.value ? isObjectLiteral(a.value) : false
      return setVar(
        asArray(rt.store[root]).map((item) => {
          const itemEnv = { ...env, item }
          // No `where` means every item — stated in the panel, never silent.
          if (where && !safeEval(where, itemEnv)) return item
          if (!a.value) return item
          const next = safeEval(a.value, itemEnv)
          return patch && isRecord(item) && isRecord(next) ? { ...item, ...next } : next
        }),
      )
    }
    case 'collection.clear':
      return setVar([])
    case 'set-variable':
      return setVar(value)
    case 'toggle-variable':
      return setVar(!rt.store[root])
    case 'increment':
      // Absent (or blank) value means +1, so the common stepper case needs no
      // expression. The emitter branches on the same truthiness.
      return setVar(asNumber(rt.store[root]) + (a.value ? asNumber(value) : 1))
    case 'node.setState':
      return { ...rt, nodeStates: { ...rt.nodeStates, [root]: String(value) } }
    case 'show-in-slot':
      // target = slot id (root); value = a *literal* view-frame id, not an
      // expression (a raw UUID wouldn't evaluate). Default in-place swap, no
      // history — back-button/routing is a lowering concern, not a runtime one.
      return { ...rt, slotViews: { ...rt.slotViews, [root]: a.value ?? '' } }
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
  if (it.if && !safeEval(it.if, env)) return rt
  let next = rt
  for (const a of it.do) next = applyAction(a, env, next)
  return next
}

// ---- observability -------------------------------------------------------
//
// An action's effect often lands somewhere you can't see — a variable read by a
// binding on another node, a state swap on a node outside the current scope.
// Because `applyAction` is pure, the before/after states are fully diffable, so
// what changed can be COMPUTED rather than guessed. These functions back the
// Build stage's state panel and its "changes outside this view" chip.

/** One cell of runtime state that moved. */
export interface StateChange {
  kind: 'variable' | 'node-state' | 'slot'
  id: string
  before: unknown
  after: unknown
}

/** A node whose rendering is invalidated by a state change, and why. */
export interface AffectedNode {
  node: NodeId
  /** Bound props that changed (`text`, `background`, …) plus synthetic markers. */
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

/** Every state cell that differs between two runtime states. */
export function diffRuntime(before: RuntimeState, after: RuntimeState): StateChange[] {
  return [
    ...diffRecord('variable', before.store, after.store),
    ...diffRecord('node-state', before.nodeStates, after.nodeStates),
    ...diffRecord('slot', before.slotViews, after.slotViews),
  ]
}

/**
 * Whether a change also LEFT the design — i.e. it wrote a cell backed from
 * outside, so the real app has to hear about it.
 *
 * Derived, not recorded. There is no log of outward calls because there is no
 * authored outward call: the write is the event, and `outside` on the cell is
 * what makes it one. Same question `normalize` answers by growing an out port
 * and `emitReactComponent` answers by emitting a callback.
 */
export function leavesDesign(ir: PageInteractions, change: StateChange): boolean {
  return change.kind === 'variable' && ir.variables.some((v) => v.id === change.id && !!v.outside)
}

/**
 * Which nodes render differently across a state change. Bindings are the main
 * signal — each one is re-evaluated in both environments — plus repeaters whose
 * collection changed, nodes whose variant state changed, and slots that swapped.
 *
 * Known gap: a binding scoped to a repeater item (referencing `item`) evaluates
 * to undefined in both environments, so it never reports on its own. The
 * repeater check below covers that case at the template level instead.
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

  for (const b of ir.bindings) {
    if (!same(safeEval(b.from, envBefore), safeEval(b.from, envAfter))) mark(b.node, b.prop)
  }
  for (const r of ir.repeaters) {
    if (!same(safeEval(r.over, envBefore), safeEval(r.over, envAfter))) mark(r.node, 'list')
  }
  for (const c of diffRecord('node-state', before.nodeStates, after.nodeStates)) mark(c.id, 'state')
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
