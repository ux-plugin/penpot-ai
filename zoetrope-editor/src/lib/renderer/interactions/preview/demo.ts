/**
 * The demo prototype used by the live preview harness: a todo list where
 *   - Add  appends a labeled row (uses items.length to number them)
 *   - Clear empties the list and is DISABLED while the list is empty
 *     (the "this button shouldn't be in this state when the list is empty"
 *      UI-state case — a property referencing a formula, not business logic)
 *   - each row shows its label via a reference to the loop item.
 */

import type { Behaviour } from '../ir'
import { fromText, type TextBehaviour } from '../expr'
import type { PNode } from '../compile/emit-react'

export const DEMO_PAGE = 'demo'

/** Written in the text form and resolved, the way the AI's answers are. */
export function demoBehaviour(): Behaviour {
  const text: TextBehaviour = {
    cells: [
      { name: 'items', type: { collection: 'object' }, initial: [] },
      { name: 'isEmpty', type: 'boolean', initial: null, formula: 'items.length == 0' },
    ],
    rules: [
      {
        node: 'addBtn',
        on: { type: 'press' },
        do: [{ type: 'collection.append', target: 'items', value: '{ label: "Item " + (items.length + 1) }' }],
      },
      { node: 'clearBtn', on: { type: 'press' }, do: [{ type: 'set-variable', target: 'items', value: '[]' }] },
    ],
    bindings: [
      { node: 'clearBtn', prop: 'disabled', expr: 'isEmpty' },
      { node: 'row', prop: 'repeat', expr: 'items', item: { as: 'item' } },
      { node: 'row', prop: 'text', expr: 'item.label' },
    ],
  }
  return fromText(text, DEMO_PAGE)
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
