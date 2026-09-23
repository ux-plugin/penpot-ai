/**
 * Runtime observability — what backs the Build stage's state panel.
 *
 * The point of these functions is that an action's effect can land somewhere the
 * preview isn't showing. Since `applyAction` is pure, "what changed" and "which
 * nodes now render differently" are computable, and these tests pin that down —
 * especially the off-screen case: a variable change reaching a node through a
 * property reference, with no visible connection to the element that was clicked.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { initDefaultCatalog } from '../../../../src/lib/renderer/interactions/catalog'
import type { Behaviour } from '../../../../src/lib/renderer/interactions/ir'
import { beh, pageCell, listCell, variantCell } from './behaviour-fixtures'
import {
  initRuntime,
  buildEnv,
  runRule,
  diffRuntime,
  affectedNodes,
  pushActivity,
  type RuntimeState,
  type ActivityEntry,
  type LoggedActivity,
} from '../../../../src/lib/renderer/interactions/preview/runtime'

beforeAll(() => initDefaultCatalog())

const rtOf = (store: Record<string, unknown>, slotViews = {}): RuntimeState => ({ store, slotViews })

describe('diffRuntime', () => {
  it('reports a changed cell with both sides', () => {
    const changes = diffRuntime(rtOf({ status: 'draft' }), rtOf({ status: 'done' }))
    expect(changes).toEqual([{ kind: 'cell', id: 'status', before: 'draft', after: 'done' }])
  })

  it('says nothing when the state is untouched', () => {
    expect(diffRuntime(rtOf({ n: 1 }), rtOf({ n: 1 }))).toEqual([])
  })

  it('compares by value, not reference — a rebuilt equal array is not a change', () => {
    expect(diffRuntime(rtOf({ items: [1, 2] }), rtOf({ items: [1, 2] }))).toEqual([])
    expect(diffRuntime(rtOf({ items: [1] }), rtOf({ items: [1, 2] }))).toHaveLength(1)
  })

  it("covers a node's own cell and slot swaps, not just page cells", () => {
    const changes = diffRuntime(rtOf({ 'card.state': 'idle' }, { outlet: 'home' }), rtOf({ 'card.state': 'open' }, { outlet: 'about' }))
    expect(changes.map((c) => [c.kind, c.id])).toEqual([
      ['cell', 'card.state'],
      ['slot', 'outlet'],
    ])
  })
})

describe('affectedNodes — where an effect actually lands', () => {
  /** Click Save → status flips; a Badge elsewhere reads status through a reference. */
  function ir(): Behaviour {
    return beh({
      cells: [pageCell('status', 'string', 'draft')],
      bindings: [
        { node: 'badge', prop: 'text', expr: 'status' },
        { node: 'footer', prop: 'text', expr: '"static"' },
      ],
      rules: [{ id: 'i1', node: 'saveBtn', on: { type: 'press' }, do: [{ type: 'set-variable', target: 'status', value: '"done"' }] }],
    })
  }

  it('names the node whose reference changed — not the node that was clicked', () => {
    const model = ir()
    const before = initRuntime(model)
    const after = runRule(model, before, model.rules[0], buildEnv(model, before))

    const affected = affectedNodes(model, before, after)
    expect(affected).toEqual([{ node: 'badge', props: ['text'] }])
    // the clicked button is not itself affected — this is exactly the case where
    // the preview looks like nothing happened
    expect(affected.map((a) => a.node)).not.toContain('saveBtn')
  })

  it('leaves references that do not depend on the change alone', () => {
    const model = ir()
    const before = initRuntime(model)
    const after = runRule(model, before, model.rules[0], buildEnv(model, before))
    expect(affectedNodes(model, before, after).map((a) => a.node)).not.toContain('footer')
  })

  it('flags a repeated template when its list changes', () => {
    const model = beh({ cells: [listCell('items')], bindings: [{ node: 'row', prop: 'repeat', expr: 'items' }] })
    const before = initRuntime(model)
    const after = { ...before, store: { items: [{ id: 1 }] } }
    expect(affectedNodes(model, before, after)).toEqual([{ node: 'row', props: ['list'] }])
  })

  it('flags a node whose own cell changed and a slot that swapped', () => {
    const model = beh({ cells: [variantCell('card', ['idle', 'open'])] })
    const affected = affectedNodes(model, rtOf({ 'card.state': 'idle' }, {}), rtOf({ 'card.state': 'open' }, { outlet: 'about' }))
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
    log = pushActivity(log, entry('press', 'n', [{ kind: 'cell', id: 'c', before: 0, after: 1 }]))
    log = pushActivity(log, entry('press', 'n', [{ kind: 'cell', id: 'c', before: 1, after: 2 }]))
    expect(log).toHaveLength(2)
  })

  it('caps the log so a timer cannot grow it without bound', () => {
    let log: LoggedActivity[] = []
    for (let i = 0; i < 50; i++) log = pushActivity(log, entry('press', `n${i}`), 20)
    expect(log).toHaveLength(20)
    expect(log[0].node).toBe('n49') // newest kept, oldest dropped
  })
})
