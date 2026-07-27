/**
 * Runtime observability — what backs the Build stage's state panel.
 *
 * The point of these functions is that an action's effect can land somewhere the
 * preview isn't showing. Since `applyAction` is pure, "what changed" and "which
 * nodes now render differently" are computable, and these tests pin that down —
 * especially the off-screen case: a variable change reaching a node through a
 * binding, with no visible connection to the element that was clicked.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { initDefaultCatalog } from '../../../../src/lib/renderer/interactions/catalog'
import { emptyPageInteractions, type PageInteractions } from '../../../../src/lib/renderer/interactions/ir'
import {
  initRuntime,
  buildEnv,
  runInteraction,
  diffRuntime,
  affectedNodes,
  pushActivity,
  type RuntimeState,
  type ActivityEntry,
  type LoggedActivity,
} from '../../../../src/lib/renderer/interactions/preview/runtime'

beforeAll(() => initDefaultCatalog())

const rtOf = (store: Record<string, unknown>, nodeStates = {}, slotViews = {}): RuntimeState => ({
  store,
  nodeStates,
  slotViews,
})

describe('diffRuntime', () => {
  it('reports a changed variable with both sides', () => {
    const changes = diffRuntime(rtOf({ status: 'draft' }), rtOf({ status: 'done' }))
    expect(changes).toEqual([{ kind: 'variable', id: 'status', before: 'draft', after: 'done' }])
  })

  it('says nothing when the state is untouched', () => {
    expect(diffRuntime(rtOf({ n: 1 }), rtOf({ n: 1 }))).toEqual([])
  })

  it('compares by value, not reference — a rebuilt equal array is not a change', () => {
    expect(diffRuntime(rtOf({ items: [1, 2] }), rtOf({ items: [1, 2] }))).toEqual([])
    expect(diffRuntime(rtOf({ items: [1] }), rtOf({ items: [1, 2] }))).toHaveLength(1)
  })

  it('covers variant state and slot swaps, not just variables', () => {
    const changes = diffRuntime(rtOf({}, { card: 'idle' }, { outlet: 'home' }), rtOf({}, { card: 'open' }, { outlet: 'about' }))
    expect(changes.map((c) => [c.kind, c.id])).toEqual([
      ['node-state', 'card'],
      ['slot', 'outlet'],
    ])
  })
})

describe('affectedNodes — where an effect actually lands', () => {
  /** Click Save → status flips; a Badge elsewhere reads status through a binding. */
  function ir(): PageInteractions {
    const it = emptyPageInteractions()
    it.variables.push({ id: 'status', type: 'string', scope: 'page', initial: 'draft', source: 'local' })
    it.bindings.push({ node: 'badge', prop: 'text', from: 'status' })
    it.bindings.push({ node: 'footer', prop: 'text', from: '"static"' })
    it.interactions.push({
      id: 'i1',
      on: { node: 'saveBtn', trigger: { type: 'press' } },
      do: [{ type: 'set-variable', target: 'status', value: '"done"' }],
    })
    return it
  }

  it('names the node whose binding changed — not the node that was clicked', () => {
    const model = ir()
    const before = initRuntime(model)
    const after = runInteraction(model, before, model.interactions[0], buildEnv(model, before))

    const affected = affectedNodes(model, before, after)
    expect(affected).toEqual([{ node: 'badge', props: ['text'] }])
    // the clicked button is not itself affected — this is exactly the case where
    // the preview looks like nothing happened
    expect(affected.map((a) => a.node)).not.toContain('saveBtn')
  })

  it('leaves bindings that do not depend on the change alone', () => {
    const model = ir()
    const before = initRuntime(model)
    const after = runInteraction(model, before, model.interactions[0], buildEnv(model, before))
    expect(affectedNodes(model, before, after).map((a) => a.node)).not.toContain('footer')
  })

  it('flags a repeater template when its collection changes', () => {
    const model = emptyPageInteractions()
    model.variables.push({ id: 'items', type: { collection: 'object' }, scope: 'page', initial: [], source: 'local' })
    model.repeaters.push({ node: 'row', over: 'items' })
    const before = initRuntime(model)
    const after = { ...before, store: { items: [{ id: 1 }] } }
    expect(affectedNodes(model, before, after)).toEqual([{ node: 'row', props: ['list'] }])
  })

  it('flags a node whose variant state changed and a slot that swapped', () => {
    const model = emptyPageInteractions()
    const affected = affectedNodes(model, rtOf({}, { card: 'idle' }, {}), rtOf({}, { card: 'open' }, { outlet: 'about' }))
    expect(affected).toEqual([
      { node: 'card', props: ['state'] },
      { node: 'outlet', props: ['view'] },
    ])
  })

  it('reports nothing when the state did not move', () => {
    const model = ir()
    const rt = initRuntime(model)
    expect(affectedNodes(model, rt, rt)).toEqual([])
  })
})

describe('pushActivity', () => {
  const entry = (trigger: string, id = 'n', changes: ActivityEntry['changes'] = []): ActivityEntry => ({
    node: id,
    trigger,
    changes,
    affected: [],
  })

  it('prepends newest first', () => {
    let log: LoggedActivity[] = []
    log = pushActivity(log, entry('press'))
    log = pushActivity(log, entry('mouse-enter'))
    expect(log.map((e) => e.trigger)).toEqual(['mouse-enter', 'press'])
  })

  it('collapses identical consecutive entries into a count', () => {
    let log: LoggedActivity[] = []
    log = pushActivity(log, entry('press'))
    log = pushActivity(log, entry('press'))
    log = pushActivity(log, entry('press'))
    expect(log).toHaveLength(1)
    expect(log[0].count).toBe(3)
  })

  it('does not collapse when the same trigger changed something different', () => {
    let log: LoggedActivity[] = []
    log = pushActivity(log, entry('press', 'n', [{ kind: 'variable', id: 'c', before: 0, after: 1 }]))
    log = pushActivity(log, entry('press', 'n', [{ kind: 'variable', id: 'c', before: 1, after: 2 }]))
    expect(log).toHaveLength(2)
  })

  it('caps the log so a timer cannot grow it without bound', () => {
    let log: LoggedActivity[] = []
    for (let i = 0; i < 50; i++) log = pushActivity(log, entry('press', `n${i}`), 20)
    expect(log).toHaveLength(20)
    expect(log[0].node).toBe('n49') // newest kept, oldest dropped
  })
})
