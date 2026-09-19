/**
 * The demo prototype used by the live preview harness: a todo list where
 *   - Add  appends a labeled row (uses items.length to number them)
 *   - Clear empties the list and is DISABLED while the list is empty
 *     (the "this button shouldn't be in this state when the list is empty"
 *      UI-state case — a property referencing a formula, not business logic)
 *   - each row shows its label via a reference to the loop item.
 */

import { emptyPageInteractions, type PageInteractions } from '../ir'
import type { PNode } from '../compile/emit-react'

export function demoIR(): PageInteractions {
  const ir = emptyPageInteractions()
  ir.cells.push({ id: 'items', owner: { kind: 'page' }, type: { collection: 'object' }, initial: [] })
  ir.cells.push({ id: 'isEmpty', owner: { kind: 'page' }, type: 'boolean', initial: null, formula: 'items.length == 0' })
  ir.interactions.push({
    on: { node: 'addBtn', trigger: { type: 'press' } },
    do: [{ type: 'collection.append', target: 'items', value: '{ label: "Item " + (items.length + 1) }' }],
  })
  ir.interactions.push({
    on: { node: 'clearBtn', trigger: { type: 'press' } },
    do: [{ type: 'set-variable', target: 'items', value: '[]' }],
  })
  ir.refs.push({ node: 'clearBtn', props: { disabled: 'isEmpty' } })
  ir.refs.push({ node: 'row', props: { repeat: 'items', text: 'item.label' }, item: { as: 'item' } })
  return ir
}

export const demoPresentation: PNode = {
  nodeId: 'page',
  role: 'container',
  children: [
    {
      nodeId: 'controls',
      role: 'container',
      children: [
        { nodeId: 'addBtn', role: 'button', text: 'Add' },
        { nodeId: 'clearBtn', role: 'button', text: 'Clear' },
      ],
    },
    { nodeId: 'list', role: 'list', children: [{ nodeId: 'row', role: 'item' }] },
  ],
}
