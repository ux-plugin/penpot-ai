import { describe, expect, it } from 'vitest'
import {
  ANIM_FORMAT_VERSION,
  AnimFormatError,
  buildAnimDoc,
  deserializeAnimDoc,
  serializeAnimDoc,
} from '../../../../src/lib/renderer/anim/serialize'
import type { AnimDoc, Timeline } from '../../../../src/lib/renderer/anim/types'

const timeline: Timeline = {
  id: 'tl-s1',
  duration: 1000,
  bindings: [
    {
      target: { object: { kind: 'node', id: 's1' }, prop: 'x' },
      curve: {
        domain: { kind: 'time' },
        keys: [
          { at: 0, value: 0 },
          { at: 1000, value: 200, interp: 'easeOut' },
        ],
      },
    },
    {
      target: { object: { kind: 'node', id: 's1' }, prop: 'rotation' },
      curve: { domain: { kind: 'param', param: 'p1' }, keys: [{ at: 0, value: 0 }, { at: 1, value: 90 }] },
    },
  ],
}

const doc: AnimDoc = {
  params: [{ id: 'p1', kind: 'number', value: 0, min: 0, max: 1 }],
  timelines: [timeline],
}

describe('buildAnimDoc', () => {
  it('assembles a runtime doc from timelines + params', () => {
    expect(buildAnimDoc([timeline], doc.params)).toEqual(doc)
  })
})

describe('serialize / deserialize round-trip', () => {
  it('preserves the document exactly (incl. time and param bindings)', () => {
    const back = deserializeAnimDoc(serializeAnimDoc(doc))
    expect(back).toEqual(doc)
  })

  it('writes a versioned envelope', () => {
    const parsed = JSON.parse(serializeAnimDoc(doc))
    expect(parsed.version).toBe(ANIM_FORMAT_VERSION)
    expect(parsed.doc.timelines).toHaveLength(1)
  })
})

describe('deserialize validation', () => {
  it('rejects invalid JSON', () => {
    expect(() => deserializeAnimDoc('{ not json')).toThrow(AnimFormatError)
  })

  it('rejects an unsupported version', () => {
    const bumped = JSON.stringify({ version: ANIM_FORMAT_VERSION + 99, doc })
    expect(() => deserializeAnimDoc(bumped)).toThrow(/unsupported format version/)
  })

  it('rejects a missing params/timelines', () => {
    expect(() => deserializeAnimDoc(JSON.stringify({ version: ANIM_FORMAT_VERSION, doc: {} }))).toThrow(AnimFormatError)
  })

  it('rejects a malformed key', () => {
    const bad = {
      version: ANIM_FORMAT_VERSION,
      doc: {
        params: [],
        timelines: [
          {
            id: 't',
            duration: 0,
            bindings: [
              {
                target: { object: { kind: 'node', id: 's1' }, prop: 'x' },
                curve: { domain: { kind: 'time' }, keys: [{ at: 'oops', value: 1 }] },
              },
            ],
          },
        ],
      },
    }
    expect(() => deserializeAnimDoc(JSON.stringify(bad))).toThrow(/malformed key/)
  })

  it('rejects an unknown domain kind', () => {
    const bad = {
      version: ANIM_FORMAT_VERSION,
      doc: {
        params: [],
        timelines: [
          {
            id: 't',
            duration: 0,
            bindings: [
              {
                target: { object: { kind: 'node', id: 's1' }, prop: 'x' },
                curve: { domain: { kind: 'frame' }, keys: [] },
              },
            ],
          },
        ],
      },
    }
    expect(() => deserializeAnimDoc(JSON.stringify(bad))).toThrow(/unknown domain kind/)
  })
})
