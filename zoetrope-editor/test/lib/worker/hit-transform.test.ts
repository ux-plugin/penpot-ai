import { describe, expect, it } from 'vitest'
import { overlaps } from '@/lib/worker/geometry/intersect'
import * as selection from '@/lib/worker/selection'
import { makeSelrect } from '@/lib/common/conversions'
import type { IndexedPage } from '@/lib/worker/types'
import type { Matrix, PenpotNode } from 'penpot-exporter/types'

const translate = (dx: number, dy: number): Matrix => ({ a: 1, b: 0, c: 0, d: 1, e: dx, f: dy })
/** A tiny query rect centred on (x, y) — mirrors the point-query in query-at-point. */
const at = (x: number, y: number) => makeSelrect(x - 1, y - 1, 2, 2)

/** A filled 10x10 rect at rest origin (0,0). */
const rectShape = (): PenpotNode =>
  ({
    id: 's1',
    type: 'rect',
    fills: [{}],
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
    selrect: makeSelrect(0, 0, 10, 10),
  }) as unknown as PenpotNode

describe('overlaps — modifier-aware (hitTransform) inverse-maps the query', () => {
  it('hits at the animated position and misses at rest when a hitTransform is set', () => {
    const moved = { ...rectShape(), hitTransform: translate(100, 100) } as unknown as PenpotNode
    expect(overlaps(moved, at(105, 105))).toBe(true)
    expect(overlaps(moved, at(5, 5))).toBe(false)
  })

  it('is unchanged without a hitTransform', () => {
    const rest = rectShape()
    expect(overlaps(rest, at(5, 5))).toBe(true)
    expect(overlaps(rest, at(105, 105))).toBe(false)
  })
})

describe('selection index — hit-transform overlay routes broad + narrow phase', () => {
  it('finds the shape at its animated position after updateIndexSingle', () => {
    const objects = { s1: rectShape() } as unknown as Record<string, PenpotNode>
    const page = { id: 'p1', objects } as unknown as IndexedPage

    let state = selection.addPage({}, page)
    // Rest: hit at the shape, miss at the future animated spot.
    expect([...selection.query(state, { pageId: 'p1', rect: at(5, 5) })]).toEqual(['s1'])
    expect([...selection.query(state, { pageId: 'p1', rect: at(105, 105) })]).toEqual([])

    // Overlay a rest->animated translation of (100,100).
    const withHit = { ...objects.s1, hitTransform: translate(100, 100) } as unknown as PenpotNode
    state = { ...state, p1: selection.updateIndexSingle(state['p1'], objects, withHit) }

    // Now the shape is selectable where it's drawn, not where it rests.
    expect([...selection.query(state, { pageId: 'p1', rect: at(105, 105) })]).toEqual(['s1'])
    expect([...selection.query(state, { pageId: 'p1', rect: at(5, 5) })]).toEqual([])
  })
})
