/**
 * Phase 0 sanity gate (PHASE_0_PLAN §5): prove that the future needs we said we'd
 * NOT implement yet — gestures, async/backend, full state-variants — are each a
 * CATALOG addition with ZERO change to the foundation.
 *
 * The proof is structural: every test below only (a) registers catalog entries at
 * runtime and (b) builds behaviour from its text form, then shows addressing +
 * anchor accept it. No test imports an internal, and none of these scenarios
 * required editing ir.ts / expression.ts / addressing.ts / anchor.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  resetCatalog,
  initDefaultCatalog,
  registerTriggers,
  registerActions,
  getTrigger,
} from '../../../../src/lib/renderer/interactions/catalog'
import { validateBehaviour } from '../../../../src/lib/renderer/interactions/addressing'
import { requiredAnchors } from '../../../../src/lib/renderer/interactions/anchor'
import { beh, pageCell, listCell, formulaCell, variantCell } from './behaviour-fixtures'

beforeEach(() => {
  resetCatalog()
  initDefaultCatalog()
})

describe('Phase 0 sanity gate — future needs are catalog-only, zero core change', () => {
  it('GESTURE (discrete): a swipe trigger is just a catalog entry', () => {
    registerTriggers([{ key: 'swipe', label: 'On swipe', scope: 'node', platforms: ['web', 'native'], params: ['direction'] }])
    const b = beh({
      rules: [{ node: 'card', on: { type: 'swipe', params: { direction: 'left' } }, do: [{ type: 'close-overlay' }] }],
    })
    expect(getTrigger('swipe')).toBeDefined()
    expect(validateBehaviour(b, new Set(['card']))).toEqual([])
    expect(requiredAnchors(b).has('card')).toBe(true)
  })

  it('GESTURE (continuous): a drag value is an outside cell + a reference — already expressible', () => {
    const b = beh({ cells: [pageCell('dragX', 'number', 0, { store: 'gesture' })], bindings: [{ node: 'row', prop: 'x', expr: 'dragX' }] })
    expect(validateBehaviour(b, new Set(['row']))).toEqual([])
    expect(requiredAnchors(b).has('row')).toBe(true)
  })

  it('ASYNC / backend: an effectful action is a catalog entry', () => {
    registerActions([{ key: 'api.save', label: 'Save to API', platforms: ['web', 'native'], lowers: 'effect', expects: { value: true } }])
    const b = beh({
      cells: [listCell('items')],
      rules: [{ node: 'saveBtn', on: { type: 'press' }, do: [{ type: 'api.save', value: 'items' }] }],
    })
    expect(validateBehaviour(b, new Set(['saveBtn']))).toEqual([])
    expect(requiredAnchors(b).has('saveBtn')).toBe(true)
  })

  it('STATE-VARIANT (data-driven): "disabled when empty" is already core — a formula-driven variant cell', () => {
    const b = beh({
      cells: [listCell('items'), formulaCell('isEmpty', 'items.length == 0'), variantCell('addBtn', ['enabled', 'disabled'], { formula: "isEmpty ? 'disabled' : 'enabled'" })],
    })
    expect(validateBehaviour(b, new Set(['addBtn']))).toEqual([])
    expect(requiredAnchors(b).has('addBtn')).toBe(true)
  })
})
