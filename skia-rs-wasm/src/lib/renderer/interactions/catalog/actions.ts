/**
 * Phase 0 action catalog. Each entry declares which normalized graph node-kind it
 * lowers to (`lowers`) and what its `target`/`value` mean (`expects`). The web
 * emitter (Task #4) dispatches on these. All Phase 0 actions are cross-platform.
 *
 * `status: 'planned'` marks entries that are declared but not yet executed by
 * either the preview runtime or the emitter — the panel offers them disabled.
 * Everything without a status is wired end to end in both.
 */

import type { ActionCatalogEntry } from './registry'

export const PHASE0_ACTIONS: ActionCatalogEntry[] = [
  // navigation / overlays -> switch
  { key: 'navigate', label: 'Navigate to', platforms: ['web', 'native'], lowers: 'switch', expects: { target: 'screen' }, status: 'planned' },
  { key: 'open-overlay', label: 'Open overlay', platforms: ['web', 'native'], lowers: 'switch', expects: { target: 'overlay' }, status: 'planned' },
  { key: 'close-overlay', label: 'Close overlay', platforms: ['web', 'native'], lowers: 'switch', expects: { target: 'overlay' }, status: 'planned' },
  // slot swap (SPA router outlet) -> switch. target = the slot node, value = the view id.
  // Single designer-facing verb; routing (Outlet/Route, push/replace) is derived at
  // lowering, never authored here. See common/slot-shape.ts + project_slots_spa_outlets.
  { key: 'show-in-slot', label: 'Show here', platforms: ['web', 'native'], lowers: 'switch', expects: { target: 'slot', value: true } },

  // side effects -> effect
  { key: 'open-url', label: 'Open URL', platforms: ['web', 'native'], lowers: 'effect', expects: { value: true } },
  // Report something outward. The only action whose effect leaves the design, so
  // the preview cannot "do" it — it records the call instead, which is what makes
  // it visible in the state panel rather than a click that appears to do nothing.
  { key: 'port.call', label: 'Send out', platforms: ['web', 'native'], lowers: 'effect', expects: { target: 'port-out', value: true } },

  // state mutation -> fold
  { key: 'collection.append', label: 'Add to list', platforms: ['web', 'native'], lowers: 'fold', expects: { target: 'collection', value: true } },
  {
    key: 'collection.insert',
    label: 'Add to list at position',
    platforms: ['web', 'native'],
    lowers: 'fold',
    expects: {
      target: 'collection',
      value: true,
      params: [{ key: 'at', label: 'at index', placeholder: '0 (top of the list)' }],
    },
  },
  { key: 'collection.remove', label: 'Remove from list', platforms: ['web', 'native'], lowers: 'fold', expects: { target: 'collection', value: true } },
  {
    key: 'collection.update',
    label: 'Update list item',
    platforms: ['web', 'native'],
    lowers: 'fold',
    expects: {
      target: 'collection',
      value: true,
      // `where` picks which items change; blank means every item. `value` is the
      // replacement — an object literal is MERGED into the item (a patch), any
      // other expression replaces it outright. See applyAction/emitAction.
      params: [{ key: 'where', label: 'where', placeholder: 'blank = every item, e.g. item.id == editingId' }],
    },
  },
  { key: 'collection.clear', label: 'Clear list', platforms: ['web', 'native'], lowers: 'fold', expects: { target: 'collection' } },
  { key: 'set-variable', label: 'Set variable', platforms: ['web', 'native'], lowers: 'fold', expects: { target: 'variable', value: true } },
  { key: 'toggle-variable', label: 'Toggle variable', platforms: ['web', 'native'], lowers: 'fold', expects: { target: 'variable' } },
  // `value` is optional on purpose: blank means +1, which both the runtime and
  // the emitter implement. Declaring it required would fail validation on the
  // commonest stepper.
  { key: 'increment', label: 'Add to number', platforms: ['web', 'native'], lowers: 'fold', expects: { target: 'variable' } },

  // variant state -> setState
  { key: 'node.setState', label: 'Set state', platforms: ['web', 'native'], lowers: 'setState', expects: { target: 'node.state', value: true } },
]
