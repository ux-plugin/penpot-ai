/**
 * The demo prototype used by the live preview harness: a todo list where
 *   - Add  appends a labeled row (uses items.length to number them)
 *   - Clear empties the list and is DISABLED while the list is empty
 *     (the "this button shouldn't be in this state when the list is empty"
 *      UI-state case — a binding to a derived value, not business logic)
 *   - each row shows its label via a binding to the loop item.
 */

import { emptyPageInteractions, type PageInteractions } from '../ir'
import type { PNode } from '../compile/emit-react'

export function demoIR(): PageInteractions {
  const ir = emptyPageInteractions()
  ir.variables.push({ id: 'items', type: { collection: 'object' }, scope: 'page', initial: [], source: 'local' })
  ir.derived.push({ id: 'isEmpty', expr: 'items.length == 0' })
  ir.interactions.push({
    on: { node: 'addBtn', trigger: { type: 'press' } },
    do: [{ type: 'collection.append', target: 'items', value: '{ label: "Item " + (items.length + 1) }' }],
  })
  ir.interactions.push({
    on: { node: 'clearBtn', trigger: { type: 'press' } },
    do: [{ type: 'set-variable', target: 'items', value: '[]' }],
  })
  ir.bindings.push({ node: 'clearBtn', prop: 'disabled', from: 'isEmpty' })
  ir.bindings.push({ node: 'row', prop: 'text', from: 'item.label' })
  ir.repeaters.push({ node: 'row', over: 'items', as: 'item' })
  return ir
}

export const demoPresentation: PNode = {
  nodeId: 'page',
  tag: 'div',
  children: [
    {
      nodeId: 'controls',
      tag: 'div',
      children: [
        { nodeId: 'addBtn', tag: 'button', text: 'Add' },
        { nodeId: 'clearBtn', tag: 'button', text: 'Clear' },
      ],
    },
    { nodeId: 'list', tag: 'ul', children: [{ nodeId: 'row', tag: 'li' }] },
  ],
}
