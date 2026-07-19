import { describe, expect, it } from 'vitest'
import { overlaps } from '@/lib/worker/geometry/intersect'
import { makeSelrect } from '@/lib/common/conversions'
import type { PenpotNode } from 'penpot-exporter/types'

/** A stroke-only path that dips to (50,50) in the middle of its 100×100 box.
 *  The apex is interior to the bbox, so the old `shape.points` (bbox-rectangle)
 *  approximation missed clicks there. */
function vShape(content: unknown): PenpotNode {
  return {
    type: 'path',
    fills: [],
    strokes: [{ strokeWidth: 2 }],
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ],
    selrect: makeSelrect(0, 0, 100, 100),
    content,
  } as unknown as PenpotNode
}

const segments = [
  { type: 'move-to', x: 0, y: 0 },
  { type: 'line-to', x: 100, y: 0 },
  { type: 'line-to', x: 50, y: 50 },
  { type: 'line-to', x: 100, y: 100 },
  { type: 'line-to', x: 0, y: 100 },
]

const at = (x: number, y: number) => makeSelrect(x - 1, y - 1, 2, 2)

describe('overlaps — path hit-test uses real segment geometry', () => {
  it('hits a stroke point in the interior of the bbox (the regression)', () => {
    expect(overlaps(vShape({ segments }), at(50, 50))).toBe(true)
  })

  it('misses an interior point that is NOT near any stroke', () => {
    expect(overlaps(vShape({ segments }), at(20, 50))).toBe(false)
  })

  it('still hits points along a straight run of the stroke', () => {
    expect(overlaps(vShape({ segments }), at(50, 0))).toBe(true)
  })

  it('flattens curves so a point on the curve hits', () => {
    // move-to (0,100) -> curve up to apex ~ (50,25) -> (100,100)
    const curved = [
      { type: 'move-to', x: 0, y: 100 },
      { type: 'curve-to', x: 100, y: 100, c1x: 0, c1y: 0, c2x: 100, c2y: 0 },
    ]
    expect(overlaps(vShape({ segments: curved }), at(50, 25))).toBe(true)
    expect(overlaps(vShape({ segments: curved }), at(50, 70))).toBe(false)
  })

  it('falls back to bounding points when content has no segments', () => {
    // No segments -> legacy approximation against the bbox rectangle edges.
    expect(overlaps(vShape({ foo: 1 }), at(0, 50))).toBe(true) // on the left bbox edge
  })
})

/** A no-fill rect, optionally carrying a shader material, for interior-hit tests. */
function shaderRect(material: unknown): PenpotNode {
  return {
    type: 'rect',
    fills: [],
    strokes: [{ strokeWidth: 2 }],
    selrect: makeSelrect(0, 0, 100, 100),
    ...(material != null ? { material } : {}),
  } as unknown as PenpotNode
}

const SHADER = { source: 'half4 main(float2 p){return half4(1);}' }

describe('overlaps — a shader material makes the interior solid', () => {
  it('rect: interior click MISSES with no fill and no material (stroke-only)', () => {
    expect(overlaps(shaderRect(null), at(50, 50))).toBe(false)
  })

  it('rect: interior click HITS once a shader material fills it', () => {
    expect(overlaps(shaderRect(SHADER), at(50, 50))).toBe(true)
  })

  it('rect: a hidden shader material does NOT count as a fill', () => {
    expect(overlaps(shaderRect({ ...SHADER, hidden: true }), at(50, 50))).toBe(false)
  })

  it('rect: an empty-source material does NOT count as a fill', () => {
    expect(overlaps(shaderRect({ source: '  ' }), at(50, 50))).toBe(false)
  })

  it('closed path: interior click MISSES with no fill, HITS with a shader material', () => {
    // A closed square with no fill — interior is hollow until the shader fills it.
    const closed = [
      { type: 'move-to', x: 0, y: 0 },
      { type: 'line-to', x: 100, y: 0 },
      { type: 'line-to', x: 100, y: 100 },
      { type: 'line-to', x: 0, y: 100 },
      { type: 'close-path' },
    ]
    expect(overlaps(vShape({ segments: closed }), at(50, 50))).toBe(false)
    expect(overlaps({ ...vShape({ segments: closed }), material: SHADER } as PenpotNode, at(50, 50))).toBe(true)
  })
})
