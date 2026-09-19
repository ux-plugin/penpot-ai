/**
 * The "todo" page every compile-side suite starts from: a list, an is-empty
 * formula, Add appends, Add is disabled while empty, rows repeat over the list
 * showing each item's label. Small helpers for building cells sit alongside so
 * fixtures read as what they mean rather than as object literals.
 */

import { emptyPageInteractions, type Cell, type Json, type PageInteractions, type ValueType } from '../../../../src/lib/renderer/interactions/ir'

export const pageCell = (id: string, type: ValueType, initial: Json, extra: Partial<Cell> = {}): Cell => ({
  id,
  owner: { kind: 'page' },
  type,
  initial,
  ...extra,
})

export const listCell = (id: string, initial: Json[] = [], extra: Partial<Cell> = {}): Cell =>
  pageCell(id, { collection: 'object' }, initial, extra)

export const formulaCell = (id: string, formula: string): Cell => pageCell(id, 'any', null, { formula })

/** A node's variant set: an enum cell it owns. */
export const variantCell = (node: string, values: string[], extra: Partial<Cell> = {}): Cell => ({
  id: 'state',
  owner: { kind: 'node', node },
  type: { enum: values },
  initial: null,
  ...extra,
})

export function todoIR(): PageInteractions {
  const ir = emptyPageInteractions()
  ir.cells.push(listCell('items'))
  ir.cells.push(formulaCell('isEmpty', 'items.length == 0'))
  ir.interactions.push({
    on: { node: 'addBtn', trigger: { type: 'press' } },
    do: [{ type: 'collection.append', target: 'items', value: '{ label: "" }' }],
  })
  ir.refs.push({ node: 'addBtn', props: { disabled: 'isEmpty' } })
  ir.refs.push({ node: 'row', props: { repeat: 'items', text: 'item.label' }, item: { as: 'item' } })
  return ir
}
