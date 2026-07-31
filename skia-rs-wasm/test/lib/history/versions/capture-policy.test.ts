/**
 * The three capture knobs and the measure the threshold reads.
 *
 * What matters is that the measure tracks *how much was touched* rather than
 * how big the payload is — a one-character edit to a long shader has to read as
 * small, or a threshold set anywhere useful would capture on every keystroke.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_CAPTURE_POLICY,
  changeSize,
  shouldCapture,
  shouldCheckpoint,
  useCapturePolicyStore,
  type CapturePolicy,
} from '../../../../src/lib/history/versions/capture-policy'

const policy = (patch: Partial<CapturePolicy> = {}): CapturePolicy => ({
  ...DEFAULT_CAPTURE_POLICY,
  ...patch,
})

beforeEach(() => {
  useCapturePolicyStore.getState().reset()
})

describe('changeSize', () => {
  it('is zero for identical payloads', () => {
    expect(changeSize({ source: 'abc' }, { source: 'abc' })).toBe(0)
  })

  it('counts only the touched span of a long string', () => {
    const long = 'x'.repeat(500)
    expect(changeSize({ source: long }, { source: `${long}!` })).toBe(1)
    expect(changeSize({ source: `${long}abcd` }, { source: `${long}wxyz` })).toBe(4)
  })

  it('counts an edit in the middle, not the whole string', () => {
    expect(changeSize({ source: 'aaaaXbbbb' }, { source: 'aaaaYbbbb' })).toBe(1)
  })

  it('counts a non-string field as one unit', () => {
    expect(changeSize({ u: { a: 1 } }, { u: { a: 2 } })).toBe(1)
    expect(changeSize({ u: { a: 1 } }, { u: { a: 1 } })).toBe(0)
  })

  it('ignores key order inside a nested value', () => {
    expect(changeSize({ u: { a: 1, b: 2 } }, { u: { b: 2, a: 1 } })).toBe(0)
  })

  it('weighs an added or removed field by its content', () => {
    expect(changeSize({}, { source: 'abcde' })).toBe(5)
    expect(changeSize({ hidden: true }, {})).toBe(1)
  })

  it('treats a first version as always worth keeping', () => {
    expect(changeSize(undefined, { source: '' })).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('shouldCapture', () => {
  it('refuses a payload that changed nothing, threshold or not', () => {
    expect(shouldCapture({ source: 'a' }, { source: 'a' }, policy())).toBe(false)
    expect(
      shouldCapture({ source: 'a' }, { source: 'a' }, policy({ minChangeEnabled: true, minChange: 0 })),
    ).toBe(false)
  })

  it('lets any change through while the threshold is off', () => {
    expect(shouldCapture({ source: 'aa' }, { source: 'ab' }, policy())).toBe(true)
  })

  it('gates small changes once the threshold is on', () => {
    const p = policy({ minChangeEnabled: true, minChange: 8 })
    expect(shouldCapture({ source: 'aa' }, { source: 'ab' }, p)).toBe(false)
    expect(shouldCapture({ source: 'aa' }, { source: 'abcdefghij' }, p)).toBe(true)
  })

  it('always keeps the first version, however small', () => {
    expect(shouldCapture(undefined, { source: '' }, policy({ minChangeEnabled: true, minChange: 999 }))).toBe(
      true,
    )
  })
})

describe('shouldCheckpoint', () => {
  it('fires once the count reaches the interval', () => {
    const p = policy({ everyNChanges: 5 })
    expect(shouldCheckpoint(4, p)).toBe(false)
    expect(shouldCheckpoint(5, p)).toBe(true)
    expect(shouldCheckpoint(9, p)).toBe(true)
  })

  it('never fires when the interval is zero', () => {
    expect(shouldCheckpoint(1000, policy({ everyNChanges: 0 }))).toBe(false)
  })
})

describe('the policy store', () => {
  it('patches and resets', () => {
    useCapturePolicyStore.getState().set({ everyNChanges: 3, onExitFocus: false })
    expect(useCapturePolicyStore.getState().everyNChanges).toBe(3)
    expect(useCapturePolicyStore.getState().onExitFocus).toBe(false)

    useCapturePolicyStore.getState().reset()
    expect(useCapturePolicyStore.getState().everyNChanges).toBe(DEFAULT_CAPTURE_POLICY.everyNChanges)
    expect(useCapturePolicyStore.getState().onExitFocus).toBe(true)
  })
})
