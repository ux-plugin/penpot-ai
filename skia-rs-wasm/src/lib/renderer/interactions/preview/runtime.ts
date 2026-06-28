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

import type { PageInteractions, Interaction, Action } from '../ir'
import { parse, evaluate } from '../expression'
import { parseRefPath } from '../addressing'

export interface RuntimeState {
  /** variable id -> value */
  store: Record<string, unknown>
  /** node id -> active self-managed variant state */
  nodeStates: Record<string, string>
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
// JSON round-trip, not structuredClone: variable initials are always JSON, and
// the IR may arrive as a valtio tracking proxy (from useSnapshot) that
// structuredClone rejects with DataCloneError.
const clone = <T>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T))

export function initRuntime(ir: PageInteractions): RuntimeState {
  const store: Record<string, unknown> = {}
  for (const v of ir.variables) store[v.id] = clone(v.initial)
  const nodeStates: Record<string, string> = {}
  for (const s of ir.states) if ('from' in s.active) nodeStates[s.node] = s.active.initial ?? s.states[0] ?? ''
  return { store, nodeStates }
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
  switch (a.type) {
    case 'collection.append':
      return { ...rt, store: { ...rt.store, [root]: [...asArray(rt.store[root]), value] } }
    case 'collection.remove':
      return {
        ...rt,
        store: { ...rt.store, [root]: asArray(rt.store[root]).filter((item) => !safeEval(a.value ?? 'false', { ...env, item })) },
      }
    case 'set-variable':
      return { ...rt, store: { ...rt.store, [root]: value } }
    case 'node.setState':
      return { ...rt, nodeStates: { ...rt.nodeStates, [root]: String(value) } }
    case 'open-url':
      if (typeof value === 'string' && typeof window !== 'undefined') window.open(value)
      return rt
    default:
      // navigate / overlay / unimplemented — preview no-op
      return rt
  }
}

export function runInteraction(ir: PageInteractions, rt: RuntimeState, it: Interaction, env: Record<string, unknown>): RuntimeState {
  if (it.if && !safeEval(it.if, env)) return rt
  let next = rt
  for (const a of it.do) next = applyAction(a, env, next)
  return next
}
