/**
 * Behaviour edits for the inspector, as changes.
 *
 * Every function reads the page's `Behaviour` (for names, scope and the record
 * it edits) and returns the `add` / `del` / `mod` changes the edit is; the UI
 * commits them (./behaviour `commitBehaviour`). Nothing here writes.
 *
 * Rules are addressed by id; actions by their index within a rule's `do[]`;
 * cells by their reference (`draft`, `card.state`); bindings by `(node, prop)`.
 * A new rule or binding takes the page of its node.
 */

import type { Action, Behaviour, Binding, Cell, Expr, Json, Ref, Rule, Store, ValueType } from '../ir'
import { bindingOf, cellRef, findCell, isEnumType, newId, REPEAT_PROP } from '../ir'
import { buildScope } from '../addressing'
import { parseExprLenient, parseRef, rawExpr } from '../expr'
import { add, del, get, mod, orderBetween, readersOf, type LocalChange } from '../../../doc'

/**
 * Text from the inspector becomes a stored tree here, resolved against the
 * behaviour alone (nodes it mentions are in scope; see `buildScope`). Text
 * that does not parse is kept verbatim as an unresolved name, never dropped.
 */
const scopeOf = (b: Behaviour, items: string[] = []) => buildScope(b, [], items)
const exprOf = (b: Behaviour, text: string, items: string[] = []): Expr | undefined =>
  text.trim() ? parseExprLenient(text, scopeOf(b, items)) : undefined

const pageOf = (node: string): string => get('node', node)?.page ?? ''

// ---- rules ----

function editRule(b: Behaviour, id: string, fn: (r: Rule) => Partial<Rule>): LocalChange[] {
  const r = b.rules.find((x) => x.id === id)
  return r ? [mod('rule', id, fn(r))] : []
}

function editAction(b: Behaviour, id: string, index: number, fn: (a: Action) => Action): LocalChange[] {
  return editRule(b, id, (r) => ({ do: r.do.map((a, i) => (i === index ? fn(a) : a)) }))
}

/** A new `press` rule on `node`, after the page's last rule. */
export function addRule(b: Behaviour, node: string, id: string = newId('r')): LocalChange[] {
  const last = b.rules[b.rules.length - 1]
  const rule: Rule = { id, page: pageOf(node), node, order: orderBetween(last?.order, undefined), on: { type: 'press' }, do: [] }
  return [add('rule', rule)]
}

export function removeRule(id: string): LocalChange[] {
  return [del('rule', id)]
}

export function setTrigger(b: Behaviour, id: string, type: string): LocalChange[] {
  return editRule(b, id, (r) => ({ on: { ...r.on, type } }))
}

/** Set or (with empty string) clear the guard condition. */
export function setCondition(b: Behaviour, id: string, expr: string): LocalChange[] {
  return editRule(b, id, () => ({ if: exprOf(b, expr) }))
}

export function addAction(b: Behaviour, id: string, type = 'set-variable'): LocalChange[] {
  return editRule(b, id, (r) => ({ do: [...r.do, { type }] }))
}

export function removeAction(b: Behaviour, id: string, index: number): LocalChange[] {
  return editRule(b, id, (r) => ({ do: r.do.filter((_, i) => i !== index) }))
}

/** Change an action's type; clears target/value since a different type expects different ones. */
export function setActionType(b: Behaviour, id: string, index: number, type: string): LocalChange[] {
  return editAction(b, id, index, () => ({ type }))
}

/** Point an action at what `target` names (`items`, `card.state`); blank clears it. */
export function setActionTarget(b: Behaviour, id: string, index: number, target: string): LocalChange[] {
  const ref: Ref | undefined = target.trim() ? (parseRef(target, scopeOf(b)) ?? { kind: 'name', name: target }) : undefined
  return putActionTarget(b, id, index, ref)
}

/** Point an action at a node — a slot for `show-in-slot`. */
export function setActionNodeTarget(b: Behaviour, id: string, index: number, node: string): LocalChange[] {
  return putActionTarget(b, id, index, node ? { kind: 'node', node } : undefined)
}

function putActionTarget(b: Behaviour, id: string, index: number, target: Ref | undefined): LocalChange[] {
  return editAction(b, id, index, (a) => {
    const next: Action = { ...a }
    if (target) next.target = target
    else delete next.target
    return next
  })
}

export function setActionValue(b: Behaviour, id: string, index: number, value: string): LocalChange[] {
  return editAction(b, id, index, (a) => {
    const next: Action = { ...a }
    const expr = exprOf(b, value)
    if (expr) next.value = expr
    else delete next.value
    return next
  })
}

/**
 * Set (or, with an empty string, clear) one of an action's extra expression
 * params — `where` on `collection.update`, `at` on `collection.insert`. Which
 * keys an action accepts is declared by its catalog entry's `expects.params`.
 * Clearing the last param drops `params` entirely.
 */
export function setActionParam(b: Behaviour, id: string, index: number, key: string, value: string): LocalChange[] {
  return editAction(b, id, index, (a) => {
    const params = { ...a.params }
    const expr = exprOf(b, value)
    if (expr) params[key] = expr as never
    else delete params[key]
    const next: Action = { ...a }
    if (Object.keys(params).length) next.params = params
    else delete next.params
    return next
  })
}

// ---- cells (the one kind of state) ----

/** Where a cell lives: its `page` and `node` references. The document is neither. */
export type Home = Pick<Cell, 'page' | 'node'>

export const DOCUMENT: Home = {}
export const pageHome = (page: string): Home => ({ page })
export const nodeHome = (page: string, node: string): Home => ({ page, node })

export function makeListCell(name: string, home: Home, id = newId('c')): Cell {
  return { id, name, ...home, type: { collection: 'object' }, initial: [] }
}

export function makeCell(name: string, type: ValueType = 'any', initial: Json = null, home: Home = DOCUMENT, id = newId('c')): Cell {
  return { id, name, ...home, type, initial }
}

/** A formula cell. An empty formula is kept as empty text until the designer fills it in. */
export function makeFormula(name: string, formula: Expr = rawExpr(''), home: Home = DOCUMENT, id = newId('c')): Cell {
  return { id, name, ...home, type: 'any', initial: null, formula }
}

/** A node's variant set: an enum cell it owns, starting on the first value. */
export function makeVariantCell(page: string, node: string, name: string, values: string[], id = newId('c')): Cell {
  return { id, name, page, node, type: { enum: values }, initial: values[0] ?? null }
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
export function isNameTaken(b: Behaviour, ref: string, stores: readonly Store[] = []): boolean {
  return b.cells.some((c) => cellRef(c) === ref) || stores.some((s) => s.id === ref)
}

/** Add a cell if its reference is free (no changes otherwise). */
export function addCell(b: Behaviour, cell: Cell, stores: readonly Store[] = []): LocalChange[] {
  if (isNameTaken(b, cellRef(cell), stores)) return []
  return [add('cell', cell)]
}

export function removeCell(b: Behaviour, ref: string): LocalChange[] {
  const c = findCell(b, ref)
  return c ? [del('cell', c.id)] : []
}

function editCell(b: Behaviour, ref: string, fn: (c: Cell) => Partial<Cell> | null): LocalChange[] {
  const c = findCell(b, ref)
  const set = c ? fn(c) : null
  return c && set ? [mod('cell', c.id, set)] : []
}

/** Set a cell's initial value — the seed the runtime store starts from. */
export function setCellValue(b: Behaviour, ref: string, initial: Json): LocalChange[] {
  return editCell(b, ref, () => ({ initial }))
}

/** Change a cell's type, resetting its initial to that type's default. */
export function setCellType(b: Behaviour, ref: string, type: ValueType): LocalChange[] {
  return editCell(b, ref, () => ({ type, initial: defaultInitial(type) }))
}

/** Set (or, with a blank string, clear) a cell's formula. */
export function setCellFormula(b: Behaviour, ref: string, formula: string): LocalChange[] {
  return editCell(b, ref, () => ({ formula: exprOf(b, formula) }))
}

/**
 * Where a cell lives. Set by the designer, changeable at any time — wiring a
 * component's own flag to something document-wide is a legitimate thing to want,
 * so this never second-guesses the choice.
 */
export function setCellOwner(b: Behaviour, ref: string, home: Home): LocalChange[] {
  return editCell(b, ref, () => ({ page: home.page, node: home.node }))
}

/** The values of a variant cell. A current initial outside the new set resets to the first. */
export function setVariantValues(b: Behaviour, ref: string, values: string[]): LocalChange[] {
  return editCell(b, ref, (c) => {
    if (!isEnumType(c.type)) return null
    const initial = typeof c.initial === 'string' && values.includes(c.initial) ? c.initial : (values[0] ?? null)
    return { type: { enum: values }, initial }
  })
}

/**
 * Set (or, with a blank string, clear) what a cell MEANS. Prose, aimed at whoever
 * binds the real value at handover. Only meaningful on a store cell, but harmless
 * on any cell — the emitter only reads it for store cells.
 */
export function setCellDescription(b: Behaviour, ref: string, description: string): LocalChange[] {
  return editCell(b, ref, () => ({ description: description.trim() || undefined }))
}

/**
 * Move a cell into a store (or, with undefined, back out to design-owned). The
 * cell keeps its id, type, value and wiring — membership is the only change,
 * which is the whole point: "from the app" is where a value lives, not a flag.
 */
export function setCellStore(b: Behaviour, ref: string, store: string | undefined, stores: readonly Store[]): LocalChange[] {
  return editCell(b, ref, () => ({ store: store && stores.some((s) => s.id === store) ? store : undefined }))
}

/** Add a document cell to a store — a value the store supplies. `initial` is its sample. */
export function addStoreField(
  b: Behaviour,
  stores: readonly Store[],
  store: string,
  name: string,
  type: ValueType = 'string',
): LocalChange[] {
  if (!name || isNameTaken(b, name, stores) || !stores.some((s) => s.id === store)) return []
  return [add('cell', { id: newId('c'), name, type, initial: defaultInitial(type), store })]
}

// ---- stores (document-wide containers the designer creates; the seam to real data) ----

/** Create a store if its name is free (no changes otherwise). */
export function addStore(stores: readonly Store[], id: string): LocalChange[] {
  if (!id || stores.some((s) => s.id === id)) return []
  return [add('store', { id })]
}

/**
 * Delete a store. Its cells, on every page, are NOT deleted: they are detached
 * and become design-owned, which keeps every interaction already wired to them
 * working. Removing the container is "this data isn't external after all",
 * not "throw the wiring away".
 */
export function removeStore(id: string): LocalChange[] {
  const detach = readersOf('cell', 'store', id)
    .filter((c) => get('cell', c))
    .map((c) => mod('cell', c, { store: undefined }))
  return [...detach, del('store', id)]
}

export function setStoreDescription(stores: readonly Store[], id: string, description: string): LocalChange[] {
  if (!stores.some((s) => s.id === id)) return []
  return [mod('store', id, { description: description.trim() || undefined })]
}

// ---- bindings (a node's property points at cells) ----

export function getRef(b: Behaviour, node: string, prop: string): Expr | undefined {
  return bindingOf(b, node, prop)?.expr
}

/** Point `node.prop` at an expression, or (with a blank string) back at its literal. */
export function setRef(b: Behaviour, node: string, prop: string, expr: string): LocalChange[] {
  const tree = exprOf(b, expr)
  return tree ? putRef(b, node, prop, tree) : clearRef(b, node, prop)
}

/** The stored form of `setRef`. */
export function putRef(b: Behaviour, node: string, prop: string, expr: Expr): LocalChange[] {
  const existing = bindingOf(b, node, prop)
  if (existing) return [mod('binding', existing.id, { expr })]
  return [add('binding', { id: newId('b'), page: pageOf(node), node, prop, expr })]
}

export function clearRef(b: Behaviour, node: string, prop: string): LocalChange[] {
  const existing = bindingOf(b, node, prop)
  return existing ? [del('binding', existing.id)] : []
}

/** Rename the property a binding is on (the inspector's prop picker). A binding already there is replaced. */
export function moveRef(b: Behaviour, node: string, from: string, to: string): LocalChange[] {
  const existing = bindingOf(b, node, from)
  if (!existing || from === to) return []
  return [...clearRef(b, node, to), mod('binding', existing.id, { prop: to })]
}

/**
 * Repeat `node` over a list: upsert the `repeat` binding, merging `patch`
 * over the existing loop settings. Pass an empty string for `as`/`key` to clear
 * those back to their defaults.
 */
export function setRepeat(
  b: Behaviour,
  node: string,
  patch: { over?: string; as?: string; key?: string },
): LocalChange[] {
  const existing = bindingOf(b, node, REPEAT_PROP)
  const as = (patch.as ?? existing?.item?.as ?? '').trim()
  const itemName = as || 'item'
  const over = patch.over !== undefined ? (exprOf(b, patch.over) ?? rawExpr('')) : (existing?.expr ?? rawExpr(''))
  const key = patch.key !== undefined ? exprOf(b, patch.key, [itemName]) : existing?.item?.key
  return putRepeat(b, node, { over, as: as || undefined, key })
}

function itemOf(loop: { as?: string; key?: Expr }): Binding['item'] {
  const item: NonNullable<Binding['item']> = {}
  if (loop.as) item.as = loop.as
  if (loop.key) item.key = loop.key
  return Object.keys(item).length ? item : undefined
}

/** The stored form of `setRepeat`. */
export function putRepeat(b: Behaviour, node: string, loop: { over: Expr; as?: string; key?: Expr }): LocalChange[] {
  const existing = bindingOf(b, node, REPEAT_PROP)
  const item = itemOf(loop)
  if (existing) return [mod('binding', existing.id, { expr: loop.over, item })]
  const binding: Binding = { id: newId('b'), page: pageOf(node), node, prop: REPEAT_PROP, expr: loop.over }
  if (item) binding.item = item
  return [add('binding', binding)]
}

export function clearRepeat(b: Behaviour, node: string): LocalChange[] {
  return clearRef(b, node, REPEAT_PROP)
}

/** Move a node's repeat to a different template node, preserving over/as/key. */
export function moveRepeat(b: Behaviour, from: string, to: string): LocalChange[] {
  const existing = bindingOf(b, from, REPEAT_PROP)
  if (!existing || from === to) return []
  return [...clearRepeat(b, to), mod('binding', existing.id, { node: to })]
}
