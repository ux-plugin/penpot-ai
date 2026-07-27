/**
 * Phase 0 trigger catalog. Node-scoped discrete triggers + a couple of app-scoped
 * ones, with honest platform tags. Hover (mouse-enter/leave) is web-only for now;
 * its press-in/press-out fallback lands when those entries exist.
 *
 * The time-based three (`after-delay`, `page-load`, `timer`) are `'planned'`:
 * they're declared so the IR and validator know their shape, but neither the
 * preview runtime nor the emitter has an effect path yet, so the panel offers
 * them disabled rather than letting you author a trigger that never fires.
 */

import type { TriggerCatalogEntry } from './registry'

export const PHASE0_TRIGGERS: TriggerCatalogEntry[] = [
  // node-scoped
  { key: 'press', label: 'On click / tap', scope: 'node', platforms: ['web', 'native'] },
  { key: 'mouse-enter', label: 'On hover in', scope: 'node', platforms: ['web'] },
  { key: 'mouse-leave', label: 'On hover out', scope: 'node', platforms: ['web'] },
  { key: 'after-delay', label: 'After delay', scope: 'node', platforms: ['web', 'native'], params: ['delay'], status: 'planned' },

  // app/page-scoped (no owning node — locked app-rule scope)
  { key: 'page-load', label: 'On page load', scope: 'app', platforms: ['web', 'native'], status: 'planned' },
  { key: 'timer', label: 'On timer', scope: 'app', platforms: ['web', 'native'], params: ['interval'], status: 'planned' },
]
