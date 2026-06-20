/**
 * Pure IR edit reducers for the Interactions inspector tab.
 *
 * Every function is `(ir, …) -> nextIr` with no mutation and no React/store
 * coupling, so the authoring logic is fully unit-testable in node. The UI builds
 * the next IR with these, then hands it to `commitInteractions` to persist.
 *
 * Interactions are addressed by their `id` (assigned on creation); actions by
 * their index within an interaction's `do[]`.
 */

import type { PageInteractions, Interaction, Action, Variable, ValueType, Json, Repeater, Binding } from '../ir'

function mapInteraction(
  ir: PageInteractions,
  id: string,
  fn: (it: Interaction) => Interaction,
): PageInteractions {
  return { ...ir, interactions: ir.interactions.map((it) => (it.id === id ? fn(it) : it)) }
}

function mapAction(
  ir: PageInteractions,
  id: string,
  index: number,
  fn: (a: Action) => Action,
): PageInteractions {
  return mapInteraction(ir, id, (it) => ({
    ...it,
    do: it.do.map((a, i) => (i === index ? fn(a) : a)),
  }))
}

/** Append a new `press` interaction on `node`. `id` is supplied (UUID in app, fixed in tests). */
export function addInteraction(ir: PageInteractions, node: string, id: string): PageInteractions {
  const it: Interaction = { id, on: { node, trigger: { type: 'press' } }, do: [] }
  return { ...ir, interactions: [...ir.interactions, it] }
}

export function removeInteraction(ir: PageInteractions, id: string): PageInteractions {
  return { ...ir, interactions: ir.interactions.filter((it) => it.id !== id) }
}

export function setTrigger(ir: PageInteractions, id: string, type: string): PageInteractions {
  return mapInteraction(ir, id, (it) => ({ ...it, on: { ...it.on, trigger: { ...it.on.trigger, type } } }))
}

/** Set or (with empty string) clear the guard condition. */
export function setCondition(ir: PageInteractions, id: string, expr: string): PageInteractions {
  return mapInteraction(ir, id, (it) => {
    const next: Interaction = { ...it }
    if (expr.trim()) next.if = expr
    else delete next.if
    return next
  })
}

export function addAction(ir: PageInteractions, id: string, type = 'set-variable'): PageInteractions {
  return mapInteraction(ir, id, (it) => ({ ...it, do: [...it.do, { type }] }))
}

export function removeAction(ir: PageInteractions, id: string, index: number): PageInteractions {
  return mapInteraction(ir, id, (it) => ({ ...it, do: it.do.filter((_, i) => i !== index) }))
}

/** Change an action's type; clears target/value since a different type expects different ones. */
export function setActionType(ir: PageInteractions, id: string, index: number, type: string): PageInteractions {
  return mapAction(ir, id, index, () => ({ type }))
}

export function setActionTarget(ir: PageInteractions, id: string, index: number, target: string): PageInteractions {
  return mapAction(ir, id, index, (a) => ({ ...a, target: target || undefined }))
}

export function setActionValue(ir: PageInteractions, id: string, index: number, value: string): PageInteractions {
  return mapAction(ir, id, index, (a) => ({ ...a, value: value || undefined }))
}

// ---- page variables (page-scoped state the actions read/write) ----

export function makeCollectionVariable(id: string): Variable {
  return { id, type: { collection: 'object' }, scope: 'page', initial: [], source: 'local' }
}

export function makeScalarVariable(id: string, type: ValueType = 'any', initial: Json = null): Variable {
  return { id, type, scope: 'page', initial, source: 'local' }
}

/** Add a variable if its id is free (no-op otherwise). */
export function addVariable(ir: PageInteractions, variable: Variable): PageInteractions {
  if (ir.variables.some((v) => v.id === variable.id)) return ir
  return { ...ir, variables: [...ir.variables, variable] }
}

export function removeVariable(ir: PageInteractions, id: string): PageInteractions {
  return { ...ir, variables: ir.variables.filter((v) => v.id !== id) }
}

/** Sanitize a user-typed name into a valid variable identifier. */
export function toVariableId(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1')
}

/** A sensible empty initial for a scalar/collection type — used when adding or retyping. */
export function defaultInitial(type: ValueType): Json {
  if (typeof type === 'object') return []
  switch (type) {
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'string':
      return ''
    default:
      return null
  }
}

function mapVariable(ir: PageInteractions, id: string, fn: (v: Variable) => Variable): PageInteractions {
  return { ...ir, variables: ir.variables.map((v) => (v.id === id ? fn(v) : v)) }
}

/** Set a variable's initial value — the seed the runtime store starts from. */
export function setVariableValue(ir: PageInteractions, id: string, initial: Json): PageInteractions {
  return mapVariable(ir, id, (v) => ({ ...v, initial }))
}

/** Change a scalar variable's type, resetting its initial to that type's default. */
export function setVariableType(ir: PageInteractions, id: string, type: ValueType): PageInteractions {
  return mapVariable(ir, id, (v) => ({ ...v, type, initial: defaultInitial(type) }))
}

// ---- derived values (read-only formulas over other state) ----
//
// `Derived { id, expr }` already exists in the IR and is evaluated by both the
// preview runtime (buildEnv) and the emitter (`const id = <expr>`); these
// reducers just make it authorable.

export function addDerived(ir: PageInteractions, id: string, expr = ''): PageInteractions {
  if (!id || ir.derived.some((d) => d.id === id) || ir.variables.some((v) => v.id === id)) return ir
  return { ...ir, derived: [...ir.derived, { id, expr }] }
}

export function setDerivedExpr(ir: PageInteractions, id: string, expr: string): PageInteractions {
  return { ...ir, derived: ir.derived.map((d) => (d.id === id ? { ...d, expr } : d)) }
}

export function removeDerived(ir: PageInteractions, id: string): PageInteractions {
  return { ...ir, derived: ir.derived.filter((d) => d.id !== id) }
}

// ---- repeaters (mark a node as a list template) ----

/**
 * Upsert the single repeater for `node`, merging `patch` over the existing one
 * (at most one repeater per node). Pass an empty string for `as`/`key` to clear
 * those optional fields back to their defaults.
 */
export function setRepeater(
  ir: PageInteractions,
  node: string,
  patch: { over?: string; as?: string; key?: string },
): PageInteractions {
  const existing = ir.repeaters.find((r) => r.node === node)
  const next: Repeater = { node, over: patch.over ?? existing?.over ?? '' }
  const as = (patch.as ?? existing?.as ?? '').trim()
  if (as) next.as = as
  const key = (patch.key ?? existing?.key ?? '').trim()
  if (key) next.key = key
  const repeaters = existing
    ? ir.repeaters.map((r) => (r.node === node ? next : r))
    : [...ir.repeaters, next]
  return { ...ir, repeaters }
}

export function clearRepeater(ir: PageInteractions, node: string): PageInteractions {
  return { ...ir, repeaters: ir.repeaters.filter((r) => r.node !== node) }
}

/** Move a node's repeater to a different template node, preserving over/as/key. */
export function moveRepeater(ir: PageInteractions, from: string, to: string): PageInteractions {
  const rep = ir.repeaters.find((r) => r.node === from)
  if (!rep || from === to) return ir
  return setRepeater(clearRepeater(ir, from), to, { over: rep.over, as: rep.as, key: rep.key })
}

// ---- bindings (wire a node prop to an expression) ----
//
// A node can hold several bindings, so they're addressed by `(node, occurrence)`
// — the 0-based index among that node's own bindings — which the UI iterates.

/** Global index of the `occurrence`-th binding for `node`, or -1 if absent. */
function bindingIndex(ir: PageInteractions, node: string, occurrence: number): number {
  let seen = -1
  for (let i = 0; i < ir.bindings.length; i++) {
    if (ir.bindings[i].node === node && ++seen === occurrence) return i
  }
  return -1
}

export function addBinding(ir: PageInteractions, node: string, prop = 'text', from = ''): PageInteractions {
  const binding: Binding = { node, prop, from }
  return { ...ir, bindings: [...ir.bindings, binding] }
}

function mapBinding(
  ir: PageInteractions,
  node: string,
  occurrence: number,
  fn: (b: Binding) => Binding,
): PageInteractions {
  const gi = bindingIndex(ir, node, occurrence)
  if (gi < 0) return ir
  return { ...ir, bindings: ir.bindings.map((b, i) => (i === gi ? fn(b) : b)) }
}

export function setBindingProp(ir: PageInteractions, node: string, occurrence: number, prop: string): PageInteractions {
  return mapBinding(ir, node, occurrence, (b) => ({ ...b, prop }))
}

export function setBindingFrom(ir: PageInteractions, node: string, occurrence: number, from: string): PageInteractions {
  return mapBinding(ir, node, occurrence, (b) => ({ ...b, from }))
}

export function removeBinding(ir: PageInteractions, node: string, occurrence: number): PageInteractions {
  const gi = bindingIndex(ir, node, occurrence)
  if (gi < 0) return ir
  return { ...ir, bindings: ir.bindings.filter((_, i) => i !== gi) }
}
