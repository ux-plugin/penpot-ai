/**
 * Catalog barrel. Re-exports the registry API and registers the Phase 0 default
 * entries on import. `initDefaultCatalog` is idempotent and exposed so tests can
 * `resetCatalog()` then re-init.
 */

import { registerTriggers, registerActions } from './registry'
import { PHASE0_TRIGGERS } from './triggers'
import { PHASE0_ACTIONS } from './actions'

export * from './registry'
export { PHASE0_TRIGGERS } from './triggers'
export { PHASE0_ACTIONS } from './actions'

export function initDefaultCatalog(): void {
  registerTriggers(PHASE0_TRIGGERS)
  registerActions(PHASE0_ACTIONS)
}

initDefaultCatalog()
