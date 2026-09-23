/**
 * State-mutating action catalog: semantics, and runtime ↔ emitter agreement.
 *
 * The design rule is that the preview interpreter and the generated React
 * compute the same thing. These tests enforce it by actually RUNNING the
 * emitted updater (`setX((prev) => …)` is a pure function of `prev`, so it can
 * be evaluated in isolation) and comparing it to `applyAction`'s result on the
 * same input — rather than snapshotting the emitted string.
 *
 * The last block is the guard that keeps the catalog honest: every action
 * registered as `stable` must actually be executed by both sides. A registered
 * entry that silently no-ops is the exact bug this suite exists to prevent.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { initDefaultCatalog, listActions, isPlanned } from '../../../../src/lib/renderer/interactions/catalog'
import { applyAction, type RuntimeState } from '../../../../src/lib/renderer/interactions/preview/runtime'
import { emitAction } from '../../../../src/lib/renderer/interactions/compile/emit-react'
import type { Action, Behaviour } from '../../../../src/lib/renderer/interactions/ir'
import type { TextAction } from '../../../../src/lib/renderer/interactions/expr'
import { act, beh, listCell, pageCell } from './behaviour-fixtures'

beforeAll(() => initDefaultCatalog())

/** The page every fixture targets: `v` (any), `todos` (a list). */
const IR: Behaviour = beh({ cells: [pageCell('v', 'any', null), listCell('todos')] })
/** An action from its text form, against that page. */
const A = (a: TextAction): Action => act(IR, a)

const emptyRt = (store: Record<string, unknown>): RuntimeState => ({ store, slotViews: {} })

/** Run an action through the preview interpreter, returning the target's value. */
function viaRuntime(a: Action, prev: unknown, target = 'v'): unknown {
  return applyAction(a, {}, emptyRt({ [target]: prev }), IR).store[target]
}

/**
 * Run an action through the EMITTED source. `emitAction` produces `setX(arg)`
 * where arg is either an updater lambda or a plain value, so evaluating arg and
 * applying it to `prev` reproduces exactly what React's setState would store.
 */
function viaEmitter(a: Action, prev: unknown): unknown {
  const src = emitAction(a, IR)
  const arg = src.slice(src.indexOf('(') + 1, -1)
  const evaluated: unknown = new Function(`return (${arg})`)()
  return typeof evaluated === 'function' ? (evaluated as (p: unknown) => unknown)(prev) : evaluated
}

/** Both paths agree, and agree with `expected`. */
function expectParity(a: Action, prev: unknown, expected: unknown): void {
  expect(viaRuntime(a, prev)).toEqual(expected)
  expect(viaEmitter(a, prev)).toEqual(expected)
}

describe('collection.update — the action that used to silently do nothing', () => {
  const rows = [
    { id: 1, label: 'a', done: false },
    { id: 2, label: 'b', done: false },
  ]

  it('patches only the matching item when the value is an object literal', () => {
    const a: Action = A({
      type: 'collection.update',
      target: 'v',
      value: '{ done: true }',
      params: { where: 'item.id == 2' },
    })
    expectParity(a, rows, [
      { id: 1, label: 'a', done: false },
      { id: 2, label: 'b', done: true },
    ])
  })

  it('merges rather than replaces — untouched fields survive the patch', () => {
    const a: Action = A({ type: 'collection.update', target: 'v', value: '{ done: true }' })
    const out = viaRuntime(a, rows) as Array<Record<string, unknown>>
    expect(out[0].label).toBe('a')
    expect(out[1].label).toBe('b')
    expect(out.every((r) => r.done === true)).toBe(true)
  })

  it('a blank `where` updates every item (stated in the panel, never silent)', () => {
    const a: Action = A({ type: 'collection.update', target: 'v', value: '{ done: true }' })
    expectParity(a, rows, [
      { id: 1, label: 'a', done: true },
      { id: 2, label: 'b', done: true },
    ])
  })

  it('a non-object value REPLACES the matched item', () => {
    const a: Action = A({
      type: 'collection.update',
      target: 'v',
      value: '"gone"',
      params: { where: 'item.id == 1' },
    })
    expectParity(a, rows, ['gone', { id: 2, label: 'b', done: false }])
  })

  it('leaves items alone when no value is supplied', () => {
    const a: Action = A({ type: 'collection.update', target: 'v' })
    expectParity(a, rows, rows)
  })

  it('emits a spread merge, not a nested spread of an object literal', () => {
    const src = emitAction(A({ type: 'collection.update', target: 'todos', value: '{ done: true }', params: { where: 'item.id == 2' } }), IR)
    expect(src).toBe('setTodos((prev) => prev.map((item) => ((item.id === 2) ? { ...item, done: true } : item)))')
  })
})

describe('new fold actions', () => {
  it('toggle-variable flips a boolean', () => {
    const a: Action = A({ type: 'toggle-variable', target: 'v' })
    expectParity(a, false, true)
    expectParity(a, true, false)
  })

  it('increment adds the value, defaulting to 1 when blank', () => {
    expectParity(A({ type: 'increment', target: 'v' }), 5, 6)
    expectParity(A({ type: 'increment', target: 'v', value: '3' }), 5, 8)
    expectParity(A({ type: 'increment', target: 'v', value: '-1' }), 5, 4)
  })

  it('collection.clear empties the list', () => {
    expectParity(A({ type: 'collection.clear', target: 'v' }), [1, 2, 3], [])
  })

  it('collection.insert defaults to the top of the list', () => {
    expectParity(A({ type: 'collection.insert', target: 'v', value: '9' }), [1, 2], [9, 1, 2])
  })

  it('collection.insert honours an `at` index', () => {
    const a: Action = A({ type: 'collection.insert', target: 'v', value: '9', params: { at: '1' } })
    expectParity(a, [1, 2], [1, 9, 2])
  })

  it('collection.insert clamps an out-of-range index instead of tearing the list', () => {
    const a: Action = A({ type: 'collection.insert', target: 'v', value: '9', params: { at: '99' } })
    expect(viaRuntime(a, [1, 2])).toEqual([1, 2, 9])
  })
})

describe('catalog honesty', () => {
  /**
   * One fixture per stable state-mutating action. The coverage assertion below
   * fails when a new one is registered without a fixture here, so a future
   * catalog entry can't quietly ship unexecuted.
   */
  const FIXTURES: Record<string, { action: Action; prev: unknown }> = {
    'collection.append': { action: A({ type: 'collection.append', target: 'v', value: '1' }), prev: [] },
    'collection.insert': { action: A({ type: 'collection.insert', target: 'v', value: '1' }), prev: [] },
    'collection.remove': { action: A({ type: 'collection.remove', target: 'v', value: 'item == 1' }), prev: [1] },
    'collection.update': { action: A({ type: 'collection.update', target: 'v', value: '2' }), prev: [1] },
    'collection.clear': { action: A({ type: 'collection.clear', target: 'v' }), prev: [1] },
    'set-variable': { action: A({ type: 'set-variable', target: 'v', value: '1' }), prev: 0 },
    'toggle-variable': { action: A({ type: 'toggle-variable', target: 'v' }), prev: false },
    increment: { action: A({ type: 'increment', target: 'v' }), prev: 0 },
  }

  const stateful = listActions().filter((e) => !isPlanned(e) && e.lowers === 'fold')

  it('every stable state-mutating action has a fixture', () => {
    expect(stateful.map((e) => e.key).sort()).toEqual(Object.keys(FIXTURES).sort())
  })

  it.each(stateful.map((e) => e.key))('%s actually changes state in the preview runtime', (key) => {
    const { action, prev } = FIXTURES[key]
    const before = emptyRt({ v: prev })
    const after = applyAction(action, {}, before, IR)
    expect(after).not.toBe(before)
    expect(after.store).not.toEqual(before.store)
  })

  it.each(stateful.map((e) => e.key))('%s lowers to real code, not a TODO comment', (key) => {
    expect(emitAction(FIXTURES[key].action, IR)).not.toMatch(/TODO\(web emit\)/)
  })

  it('planned entries are exactly the ones no side executes yet', () => {
    const planned = listActions().filter(isPlanned).map((e) => e.key).sort()
    expect(planned).toEqual(['close-overlay', 'navigate', 'open-overlay'])
  })

  it('a planned action still lowers to a marked TODO rather than wrong code', () => {
    expect(emitAction(A({ type: 'navigate', target: 'other' }), IR)).toMatch(/TODO\(web emit\)/)
  })
})
