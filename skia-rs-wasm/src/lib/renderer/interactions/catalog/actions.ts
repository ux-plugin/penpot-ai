/**
 * Phase 0 action catalog. Each entry declares which normalized graph node-kind it
 * lowers to (`lowers`) and what its `target`/`value` mean (`expects`). The web
 * emitter (Task #4) dispatches on these. All Phase 0 actions are cross-platform.
 */

import type { ActionCatalogEntry } from './registry'

export const PHASE0_ACTIONS: ActionCatalogEntry[] = [
  // navigation / overlays -> switch
  { key: 'navigate', label: 'Navigate to', platforms: ['web', 'native'], lowers: 'switch', expects: { target: 'screen' } },
  { key: 'open-overlay', label: 'Open overlay', platforms: ['web', 'native'], lowers: 'switch', expects: { target: 'overlay' } },
  { key: 'close-overlay', label: 'Close overlay', platforms: ['web', 'native'], lowers: 'switch', expects: { target: 'overlay' } },
  // slot swap (SPA router outlet) -> switch. target = the slot node, value = the view id.
  // Single designer-facing verb; routing (Outlet/Route, push/replace) is derived at
  // lowering, never authored here. See common/slot-shape.ts + project_slots_spa_outlets.
  { key: 'show-in-slot', label: 'Show here', platforms: ['web', 'native'], lowers: 'switch', expects: { target: 'slot', value: true } },

  // side effects -> effect
  { key: 'open-url', label: 'Open URL', platforms: ['web', 'native'], lowers: 'effect', expects: { value: true } },

  // state mutation -> fold
  { key: 'collection.append', label: 'Add to list', platforms: ['web', 'native'], lowers: 'fold', expects: { target: 'collection', value: true } },
  { key: 'collection.remove', label: 'Remove from list', platforms: ['web', 'native'], lowers: 'fold', expects: { target: 'collection', value: true } },
  { key: 'collection.update', label: 'Update list item', platforms: ['web', 'native'], lowers: 'fold', expects: { target: 'collection', value: true } },
  { key: 'set-variable', label: 'Set variable', platforms: ['web', 'native'], lowers: 'fold', expects: { target: 'variable', value: true } },

  // variant state -> setState
  { key: 'node.setState', label: 'Set state', platforms: ['web', 'native'], lowers: 'setState', expects: { target: 'node.state', value: true } },
]
