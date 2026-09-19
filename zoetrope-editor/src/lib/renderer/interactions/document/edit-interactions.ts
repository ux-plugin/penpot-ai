/**
 * Pure IR edit reducers for the inspector.
 *
 * Every function is `(ir, …) -> nextIr` with no mutation and no React/store
 * coupling, so the authoring logic is fully unit-testable in node. The UI builds
 * the next IR with these, then hands it to `commitInteractions` to persist.
 *
 * Interactions are addressed by their `id` (assigned on creation); actions by
 * their index within an interaction's `do[]`; cells by their reference
 * (`draft`, `card.state`); property references by `(node, prop)`.
 *
 * Stores are document-wide, so their reducers take and return the document's
 * `Store[]`; the one that touches both (removing a store detaches its cells)
 * is split into a store half and a page half.
 */

import type { PageInteractions, Interaction, Action, Cell, Store, ValueType, Json, Owner, Expr, NodeRefs } from '../ir'
import { cellRef, isEnumType, REPEAT_PROP } from '../ir'

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

/**
 * Set (or, with an empty string, clear) one of an action's extra expression
 * params — `where` on `collection.update`, `at` on `collection.insert`. Which
 * keys an action accepts is declared by its catalog entry's `expects.params`.
 * Clearing the last param drops `params` entirely so the IR stays minimal.
 */
export function setActionParam(
  ir: PageInteractions,
  id: string,
  index: number,
  key: string,
  value: string,
): PageInteractions {
  return mapAction(ir, id, index, (a) => {
    const params = { ...a.params }
    if (value.trim()) params[key] = value
    else delete params[key]
    const next: Action = { ...a }
    if (Object.keys(params).length) next.params = params
    else delete next.params
    return next
  })
}

// ---- cells (the one kind of state) ----

export const PAGE: Owner = { kind: 'page' }
export const DOCUMENT: Owner = { kind: 'document' }
export const nodeOwner = (node: string): Owner => ({ kind: 'node', node })

export function makeListCell(id: string, owner: Owner = PAGE): Cell {
  return { id, owner, type: { collection: 'object' }, initial: [] }
}

export function makeCell(id: string, type: ValueType = 'any', initial: Json = null, owner: Owner = PAGE): Cell {
  return { id, owner, type, initial }
}

export function makeFormula(id: string, formula: Expr = '', owner: Owner = PAGE): Cell {
  return { id, owner, type: 'any', initial: null, formula }
}

/** A node's variant set: an enum cell it owns, starting on the first value. */
export function makeVariantCell(node: string, id: string, values: string[]): Cell {
  return { id, owner: nodeOwner(node), type: { enum: values }, initial: values[0] ?? null }
}

/** Sanitize a user-typed name into a valid cell identifier. */
export function toCellId(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1')
}

/** A sensible empty initial for a type — used when adding or retyping. */
export function defaultInitial(type: ValueType): Json {
  if (typeof type === 'object') return 'enum' in type ? (type.enum[0] ?? null) : []
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

/**
 * Whether a cell reference is already taken. Cells on the page share one
 * namespace with the document's stores (both are referenced by bare name in
 * expressions and `Cell.store`), so any collision would make a reference
 * ambiguous. A node's cells are namespaced by their node.
 */
export function isNameTaken(ir: PageInteractions, ref: string, stores: readonly Store[] = []): boolean {
  return ir.cells.some((c) => cellRef(c) === ref) || stores.some((s) => s.id === ref)
}

/** Add a cell if its reference is free (no-op otherwise). */
export function addCell(ir: PageInteractions, cell: Cell, stores: readonly Store[] = []): PageInteractions {
  if (isNameTaken(ir, cellRef(cell), stores)) return ir
  return { ...ir, cells: [...ir.cells, cell] }
}

export function removeCell(ir: PageInteractions, ref: string): PageInteractions {
  return { ...ir, cells: ir.cells.filter((c) => cellRef(c) !== ref) }
}

function mapCell(ir: PageInteractions, ref: string, fn: (c: Cell) => Cell): PageInteractions {
  return { ...ir, cells: ir.cells.map((c) => (cellRef(c) === ref ? fn(c) : c)) }
}

/** Set a cell's initial value — the seed the runtime store starts from. */
export function setCellValue(ir: PageInteractions, ref: string, initial: Json): PageInteractions {
  return mapCell(ir, ref, (c) => ({ ...c, initial }))
}

/** Change a cell's type, resetting its initial to that type's default. */
export function setCellType(ir: PageInteractions, ref: string, type: ValueType): PageInteractions {
  return mapCell(ir, ref, (c) => ({ ...c, type, initial: defaultInitial(type) }))
}

/** Set (or, with a blank string, clear) a cell's formula. */
export function setCellFormula(ir: PageInteractions, ref: string, formula: string): PageInteractions {
  return mapCell(ir, ref, (c) => {
    const next: Cell = { ...c }
    if (formula.trim()) next.formula = formula
    else delete next.formula
    return next
  })
}

/**
 * Where a cell lives. Set by the designer, changeable at any time — wiring a
 * component's own flag to something document-wide is a legitimate thing to want,
 * so this never second-guesses the choice.
 */
export function setCellOwner(ir: PageInteractions, ref: string, owner: Owner): PageInteractions {
  return mapCell(ir, ref, (c) => ({ ...c, owner }))
}

/** The values of a variant cell. A current initial outside the new set resets to the first. */
export function setVariantValues(ir: PageInteractions, ref: string, values: string[]): PageInteractions {
  return mapCell(ir, ref, (c) => {
    if (!isEnumType(c.type)) return c
    const initial = typeof c.initial === 'string' && values.includes(c.initial) ? c.initial : (values[0] ?? null)
    return { ...c, type: { enum: values }, initial }
  })
}

/**
 * Set (or, with a blank string, clear) what a cell MEANS. Prose, aimed at whoever
 * binds the real value at handover. Only meaningful on a store cell, but harmless
 * on any cell — the emitter only reads it for store cells.
 */
export function setCellDescription(ir: PageInteractions, ref: string, description: string): PageInteractions {
  return mapCell(ir, ref, (c) => {
    const next: Cell = { ...c }
    const text = description.trim()
    if (text) next.description = text
    else delete next.description
    return next
  })
}

/**
 * Move a cell into a store (or, with undefined, back out to design-owned). The
 * cell keeps its id, type, value and wiring — membership is the only change,
 * which is the whole point: "from the app" is where a value lives, not a flag.
 */
export function setCellStore(ir: PageInteractions, ref: string, store: string | undefined, stores: readonly Store[]): PageInteractions {
  return mapCell(ir, ref, (c) => {
    const next: Cell = { ...c }
    if (store && stores.some((s) => s.id === store)) next.store = store
    else delete next.store
    return next
  })
}

/** Add a cell to a store — a value the store supplies. `initial` is its sample. */
export function addStoreField(
  ir: PageInteractions,
  stores: readonly Store[],
  store: string,
  id: string,
  type: ValueType = 'string',
): PageInteractions {
  if (!id || isNameTaken(ir, id, stores) || !stores.some((s) => s.id === store)) return ir
  return { ...ir, cells: [...ir.cells, { id, owner: DOCUMENT, type, initial: defaultInitial(type), store }] }
}

/** Detach every cell of a store — the page half of removing a store. */
export function detachStore(ir: PageInteractions, store: string): PageInteractions {
  return {
    ...ir,
    cells: ir.cells.map((c) => {
      if (c.store !== store) return c
      const next = { ...c }
      delete next.store
      return next
    }),
  }
}

// ---- stores (document-wide containers the designer creates; the seam to real data) ----

/** Create a store if its name is free (no-op otherwise). */
export function addStore(stores: readonly Store[], id: string): Store[] {
  if (!id || stores.some((s) => s.id === id)) return [...stores]
  return [...stores, { id }]
}

/**
 * Delete a store. Its cells are NOT deleted — pair with `detachStore` on each
 * page so they become design-owned, which keeps every interaction already wired
 * to them working. Removing the container is "this data isn't external after
 * all", not "throw the wiring away".
 */
export function removeStore(stores: readonly Store[], id: string): Store[] {
  return stores.filter((s) => s.id !== id)
}

export function setStoreDescription(stores: readonly Store[], id: string, description: string): Store[] {
  return stores.map((s) => {
    if (s.id !== id) return s
    const next: Store = { ...s }
    const text = description.trim()
    if (text) next.description = text
    else delete next.description
    return next
  })
}

// ---- property references (a node's property points at cells) ----

function mapRefs(ir: PageInteractions, node: string, fn: (r: NodeRefs) => NodeRefs | undefined): PageInteractions {
  const existing = ir.refs.find((r) => r.node === node)
  const next = fn(existing ?? { node, props: {} })
  const rest = ir.refs.filter((r) => r.node !== node)
  return { ...ir, refs: next && (Object.keys(next.props).length || next.item) ? [...rest, next] : rest }
}

export function getRef(ir: PageInteractions, node: string, prop: string): Expr | undefined {
  return ir.refs.find((r) => r.node === node)?.props[prop]
}

/** Point `node.prop` at an expression, or (with a blank string) back at its literal. */
export function setRef(ir: PageInteractions, node: string, prop: string, expr: string): PageInteractions {
  if (!expr.trim()) return clearRef(ir, node, prop)
  return mapRefs(ir, node, (r) => ({ ...r, props: { ...r.props, [prop]: expr } }))
}

export function clearRef(ir: PageInteractions, node: string, prop: string): PageInteractions {
  return mapRefs(ir, node, (r) => {
    const props = { ...r.props }
    delete props[prop]
    const next: NodeRefs = { ...r, props }
    if (prop === REPEAT_PROP) delete next.item
    return next
  })
}

/** Rename the property a reference is on (the inspector's prop picker). */
export function moveRef(ir: PageInteractions, node: string, from: string, to: string): PageInteractions {
  const expr = getRef(ir, node, from)
  if (expr === undefined || from === to) return ir
  return setRef(clearRef(ir, node, from), node, to, expr)
}

/**
 * Repeat `node` over a list: upsert the `repeat` reference, merging `patch`
 * over the existing loop settings. Pass an empty string for `as`/`key` to clear
 * those back to their defaults.
 */
export function setRepeat(
  ir: PageInteractions,
  node: string,
  patch: { over?: string; as?: string; key?: string },
): PageInteractions {
  return mapRefs(ir, node, (r) => {
    const over = patch.over ?? r.props[REPEAT_PROP] ?? ''
    const item: NonNullable<NodeRefs['item']> = {}
    const as = (patch.as ?? r.item?.as ?? '').trim()
    if (as) item.as = as
    const key = (patch.key ?? r.item?.key ?? '').trim()
    if (key) item.key = key
    const next: NodeRefs = { ...r, props: { ...r.props, [REPEAT_PROP]: over } }
    if (Object.keys(item).length) next.item = item
    else delete next.item
    return next
  })
}

export function clearRepeat(ir: PageInteractions, node: string): PageInteractions {
  return clearRef(ir, node, REPEAT_PROP)
}

/** Move a node's repeat to a different template node, preserving over/as/key. */
export function moveRepeat(ir: PageInteractions, from: string, to: string): PageInteractions {
  const r = ir.refs.find((x) => x.node === from)
  const over = r?.props[REPEAT_PROP]
  if (!over || from === to) return ir
  return setRepeat(clearRepeat(ir, from), to, { over, as: r?.item?.as, key: r?.item?.key })
}
