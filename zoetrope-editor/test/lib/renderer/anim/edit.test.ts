import { describe, expect, it } from 'vitest'
import { emptyTimeline, findKey, moveKey, removeKey, setKey } from '../../../../src/lib/renderer/anim/edit'
import type { Domain, Target, Timeline } from '../../../../src/lib/renderer/anim/types'

const tx: Target = { object: { kind: 'node', id: 's1' }, prop: 'x' }
const build = (edits: (tl: Timeline) => Timeline): Timeline => edits(emptyTimeline('t'))

describe('setKey', () => {
  it('creates the binding + key; duration tracks the latest time-domain key', () => {
    let tl = setKey(emptyTimeline('t'), tx, 0, 10)
    expect(tl.bindings).toHaveLength(1)
    expect(tl.bindings[0].target.prop).toBe('x')
    expect(tl.bindings[0].curve.keys).toEqual([{ at: 0, value: 10 }])
    expect(tl.duration).toBe(0)

    tl = setKey(tl, tx, 500, 100)
    expect(tl.duration).toBe(500)
    expect(tl.bindings[0].curve.keys).toHaveLength(2)
  })

  it('updates the key already at that position, preserving interp', () => {
    const a = setKey(emptyTimeline('t'), tx, 200, 10, 'easeIn')
    const b = setKey(a, tx, 200, 99)
    expect(b.bindings[0].curve.keys).toEqual([{ at: 200, value: 99, interp: 'easeIn' }])
  })

  it('keeps keys sorted regardless of insertion order', () => {
    const tl = build((t) => setKey(setKey(setKey(t, tx, 1000, 1), tx, 0, 2), tx, 500, 3))
    expect(tl.bindings[0].curve.keys.map((k) => k.at)).toEqual([0, 500, 1000])
  })

  it('adds a second property as a second binding', () => {
    const tl = build((t) => setKey(setKey(t, tx, 0, 0), { object: { kind: 'node', id: 's1' }, prop: 'rotation' }, 1000, 360))
    expect(tl.bindings.map((b) => b.target.prop).sort()).toEqual(['rotation', 'x'])
  })

  it('does not mutate the input', () => {
    const a = setKey(emptyTimeline('t'), tx, 0, 10)
    const b = setKey(a, tx, 500, 100)
    expect(a.bindings[0].curve.keys).toHaveLength(1)
    expect(b.bindings[0].curve.keys).toHaveLength(2)
  })
})

describe('removeKey', () => {
  const base = build((t) => setKey(setKey(t, tx, 0, 0), tx, 500, 100))

  it('removes a key and recomputes duration', () => {
    const r = removeKey(base, tx, 500)
    expect(r.bindings[0].curve.keys.map((k) => k.at)).toEqual([0])
    expect(r.duration).toBe(0)
  })

  it('drops the binding when its curve empties', () => {
    const r = removeKey(removeKey(base, tx, 0), tx, 500)
    expect(r.bindings).toEqual([])
  })

  it('returns the same reference when nothing matches', () => {
    expect(removeKey(base, tx, 999)).toBe(base)
    expect(removeKey(base, { object: { kind: 'node', id: 'nope' }, prop: 'x' }, 0)).toBe(base)
  })
})

describe('moveKey', () => {
  const base = build((t) => setKey(setKey(t, tx, 0, 0), tx, 500, 100))

  it('retimes a key, preserving value, and recomputes duration', () => {
    const r = moveKey(base, tx, 500, 800)
    expect(r.bindings[0].curve.keys.map((k) => k.at)).toEqual([0, 800])
    expect(findKey(r, tx, 800)).toEqual({ at: 800, value: 100 })
    expect(r.duration).toBe(800)
  })

  it('overwrites a key already at the destination', () => {
    const r = moveKey(base, tx, 0, 500)
    expect(r.bindings[0].curve.keys).toHaveLength(1)
    expect(findKey(r, tx, 500)).toEqual({ at: 500, value: 0 })
  })

  it('no-ops (same ref) with no source key or an unchanged position', () => {
    expect(moveKey(base, tx, 250, 300)).toBe(base)
    expect(moveKey(base, tx, 500, 500)).toBe(base)
  })
})

describe('findKey', () => {
  const tl = build((t) => setKey(setKey(t, tx, 0, 0), tx, 500, 100))

  it('finds a key at the position, else undefined', () => {
    expect(findKey(tl, tx, 500)).toEqual({ at: 500, value: 100 })
    expect(findKey(tl, tx, 250)).toBeUndefined()
    expect(findKey(tl, { object: { kind: 'node', id: 's1' }, prop: 'opacity' }, 0)).toBeUndefined()
  })
})

describe('param-domain bindings', () => {
  const paramDomain: Domain = { kind: 'param', param: 'speed' }

  it('creates a separate binding per domain for the same target', () => {
    let tl = setKey(emptyTimeline('t'), tx, 0, 0) // time
    tl = setKey(tl, tx, 1, 100, undefined, paramDomain) // param
    expect(tl.bindings).toHaveLength(2)
    expect(tl.bindings.map((b) => b.curve.domain.kind).sort()).toEqual(['param', 'time'])
  })

  it('does not extend duration with param-domain keys', () => {
    const tl = setKey(emptyTimeline('t'), tx, 5, 100, undefined, paramDomain)
    expect(tl.duration).toBe(0)
  })

  it('finds/removes keys on the matching domain only', () => {
    let tl = setKey(setKey(emptyTimeline('t'), tx, 0, 0), tx, 1, 100, undefined, paramDomain)
    expect(findKey(tl, tx, 1, paramDomain)).toEqual({ at: 1, value: 100 })
    expect(findKey(tl, tx, 1)).toBeUndefined() // time domain has no key at at=1
    tl = removeKey(tl, tx, 1, paramDomain)
    expect(tl.bindings.map((b) => b.curve.domain.kind)).toEqual(['time'])
  })
})
