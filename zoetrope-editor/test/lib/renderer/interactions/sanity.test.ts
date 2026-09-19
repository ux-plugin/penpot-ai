/**
 * Phase 0 sanity gate (PHASE_0_PLAN §5): prove that the future needs we said we'd
 * NOT implement yet — gestures, async/backend, full state-variants — are each a
 * CATALOG addition with ZERO change to the foundation.
 *
 * The proof is structural: every test below only (a) registers catalog entries at
 * runtime and (b) builds IR from the public types, then shows addressing +
 * normalize + anchor accept it. No test imports an internal, and none of these
 * scenarios required editing ir.ts / expression.ts / addressing.ts / anchor.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  resetCatalog,
  initDefaultCatalog,
  registerTriggers,
  registerActions,
  getTrigger,
} from '../../../../src/lib/renderer/interactions/catalog'
import { emptyPageInteractions } from '../../../../src/lib/renderer/interactions/ir'
import { validatePageInteractions } from '../../../../src/lib/renderer/interactions/addressing'
import { normalize } from '../../../../src/lib/renderer/interactions/compile/normalize'
import { requiredAnchors } from '../../../../src/lib/renderer/interactions/anchor'
import { pageCell, listCell, formulaCell, variantCell } from './todo-ir'

beforeEach(() => {
  resetCatalog()
  initDefaultCatalog()
})

describe('Phase 0 sanity gate — future needs are catalog-only, zero core change', () => {
  it('GESTURE (discrete): a swipe trigger is just a catalog entry', () => {
    registerTriggers([{ key: 'swipe', label: 'On swipe', scope: 'node', platforms: ['web', 'native'], params: ['direction'] }])
    const ir = emptyPageInteractions()
    ir.interactions.push({
      on: { node: 'card', trigger: { type: 'swipe', params: { direction: 'left' } } },
      do: [{ type: 'close-overlay' }],
    })
    expect(getTrigger('swipe')).toBeDefined()
    expect(validatePageInteractions(ir, new Set(['card']))).toEqual([])
    expect(normalize(ir).nodes.some((n) => n.kind === 'source' && n.produces === 'event')).toBe(true)
  })

  it('GESTURE (continuous): a drag value is an outside cell + a reference — already expressible', () => {
    const ir = emptyPageInteractions()
    // A continuous gesture value is an external signal, i.e. a cell that lives in
    // a store the designer made — not a second kind of thing, just where it lives.
    ir.cells.push(pageCell('dragX', 'number', 0, { store: 'gesture' }))
    ir.refs.push({ node: 'row', props: { x: 'dragX' } })
    expect(validatePageInteractions(ir, new Set(['row']))).toEqual([])
    // lowers to an inbound port node — derived plumbing, no new IR kind needed
    expect(normalize(ir).nodes.some((n) => n.kind === 'port' && n.dir === 'in')).toBe(true)
  })

  it('ASYNC / backend: an effectful action is a catalog entry', () => {
    registerActions([{ key: 'api.save', label: 'Save to API', platforms: ['web', 'native'], lowers: 'effect', expects: { value: true } }])
    const ir = emptyPageInteractions()
    ir.cells.push(listCell('items'))
    ir.interactions.push({ on: { node: 'saveBtn', trigger: { type: 'press' } }, do: [{ type: 'api.save', value: 'items' }] })
    expect(validatePageInteractions(ir, new Set(['saveBtn']))).toEqual([])
    expect(normalize(ir).nodes.some((n) => n.kind === 'effect')).toBe(true)
  })

  it('STATE-VARIANT (data-driven): "disabled when empty" is already core — a formula-driven variant cell', () => {
    const ir = emptyPageInteractions()
    ir.cells.push(listCell('items'))
    ir.cells.push(formulaCell('isEmpty', 'items.length == 0'))
    ir.cells.push(variantCell('addBtn', ['enabled', 'disabled'], { formula: "isEmpty ? 'disabled' : 'enabled'" }))
    expect(validatePageInteractions(ir, new Set(['addBtn']))).toEqual([])
    expect(requiredAnchors(ir).has('addBtn')).toBe(true)
  })
})
