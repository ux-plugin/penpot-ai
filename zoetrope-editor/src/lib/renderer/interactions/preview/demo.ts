/**
 * The demo prototype used by the live preview harness: a todo list where
 *   - Add  appends a labeled row (uses items.length to number them)
 *   - Clear empties the list and is DISABLED while the list is empty
 *     (the "this button shouldn't be in this state when the list is empty"
 *      UI-state case — a property referencing a formula, not business logic)
 *   - each row shows its label via a reference to the loop item.
 */

import type { PageInteractions, V2PageInteractions } from '../ir'
import { upgradePageInteractions } from '../upgrade'
import type { PNode } from '../compile/emit-react'

/** Written in the text form (version 2) and upgraded, which is how a document reads. */
export function demoIR(): PageInteractions {
  const v2: V2PageInteractions = {
    version: 2,
    cells: [
      { id: 'items', owner: { kind: 'page' }, type: { collection: 'object' }, initial: [] },
      { id: 'isEmpty', owner: { kind: 'page' }, type: 'boolean', initial: null, formula: 'items.length == 0' },
    ],
    interactions: [
      {
        on: { node: 'addBtn', trigger: { type: 'press' } },
        do: [{ type: 'collection.append', target: 'items', value: '{ label: "Item " + (items.length + 1) }' }],
      },
      { on: { node: 'clearBtn', trigger: { type: 'press' } }, do: [{ type: 'set-variable', target: 'items', value: '[]' }] },
    ],
    refs: [
      { node: 'clearBtn', props: { disabled: 'isEmpty' } },
      { node: 'row', props: { repeat: 'items', text: 'item.label' }, item: { as: 'item' } },
    ],
    appRules: [],
  }
  return upgradePageInteractions(v2).ir
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
