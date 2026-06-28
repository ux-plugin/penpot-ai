import { describe, it, expect, beforeEach } from 'vitest'
import {
  emptyPageInteractions,
  reconcile,
  referencedNodeIds,
  type PageInteractions,
} from '../../../../src/lib/renderer/interactions/ir'
import {
  getTrigger,
  getAction,
  isKnownTrigger,
  isKnownAction,
  resolveTriggerForPlatform,
  resetCatalog,
  initDefaultCatalog,
} from '../../../../src/lib/renderer/interactions/catalog'

function sampleIR(): PageInteractions {
  const ir = emptyPageInteractions()
  ir.variables.push({ id: 'items', type: { collection: 'object' }, scope: 'page', initial: [], source: 'local' })
  ir.derived.push({ id: 'isEmpty', expr: 'items.length == 0' })
  ir.interactions.push({
    on: { node: 'addBtn', trigger: { type: 'press' } },
    do: [{ type: 'collection.append', target: 'items', value: '{ label: "" }' }],
  })
  ir.bindings.push({ node: 'addBtn', prop: 'disabled', from: 'isEmpty' })
  ir.repeaters.push({ node: 'list', over: 'items' })
  ir.states.push({ node: 'card', states: ['collapsed', 'expanded'], active: { from: 'self', initial: 'collapsed' } })
  return ir
}

describe('referencedNodeIds', () => {
  it('collects node ids across interactions, bindings, repeaters, states', () => {
    const ids = referencedNodeIds(sampleIR())
    expect([...ids].sort()).toEqual(['addBtn', 'card', 'list'])
  })
})

describe('reconcile (regenerate/merge contract)', () => {
  it('reports nothing dangling when every referenced node is present', () => {
    const r = reconcile(sampleIR(), new Set(['addBtn', 'list', 'card']))
    expect(r.ok).toBe(true)
    expect(r.dangling).toHaveLength(0)
  })

  it('flags behavior whose node was removed', () => {
    const r = reconcile(sampleIR(), new Set(['addBtn']))
    expect(r.ok).toBe(false)
    const kinds = r.dangling.map((d) => `${d.kind}:${d.node}`).sort()
    expect(kinds).toEqual(['repeater:list', 'state:card'])
  })

  it('does not treat new behaviorless nodes as errors', () => {
    const r = reconcile(emptyPageInteractions(), new Set(['brandNewNode']))
    expect(r.ok).toBe(true)
    expect(r.dangling).toHaveLength(0)
  })
})

describe('catalog', () => {
  beforeEach(() => {
    resetCatalog()
    initDefaultCatalog()
  })

  it('registers the Phase 0 defaults', () => {
    expect(isKnownTrigger('press')).toBe(true)
    expect(isKnownAction('collection.append')).toBe(true)
    expect(isKnownTrigger('does-not-exist')).toBe(false)
  })

  it('carries platform tags and lowering metadata', () => {
    expect(getTrigger('press')?.platforms).toEqual(['web', 'native'])
    expect(getAction('collection.append')?.lowers).toBe('fold')
    expect(getAction('navigate')?.lowers).toBe('switch')
  })

  it('resolves cross-platform with fallback rules', () => {
    expect(resolveTriggerForPlatform('press', 'native')?.key).toBe('press')
    // hover is web-only and has no fallback yet -> unsupported on native
    expect(resolveTriggerForPlatform('mouse-enter', 'web')?.key).toBe('mouse-enter')
    expect(resolveTriggerForPlatform('mouse-enter', 'native')).toBeUndefined()
  })
})
