import { describe, expect, it } from 'vitest'
import {
  shapeOutline,
  translateSegments,
  type ParametricShapeKind,
} from '../../../../src/lib/renderer/geom/primitives'
import { recognizeShape } from '../../../../src/lib/renderer/geom/recognize-shape'
import type { PathSegment } from '../../../../src/lib/renderer/types'

// Build a world-placed path (segments + selrect) for a generated shape, as the
// factory would: local outline translated to (ox, oy) over a w×h bbox.
function placed(
  kind: ParametricShapeKind,
  w: number,
  h: number,
  ox: number,
  oy: number,
  params: Record<string, number> = {},
): { segments: PathSegment[]; selrect: { x: number; y: number; width: number; height: number } } {
  const local = shapeOutline(kind, { width: w, height: h, ...params })
  return {
    segments: translateSegments(local, ox, oy),
    selrect: { x: ox, y: oy, width: w, height: h },
  }
}

describe('recognizeShape — matched-pair round-trip', () => {
  // Non-square bbox + non-origin placement to exercise unit-normalization and
  // translation invariance.
  const W = 140
  const H = 90
  const OX = 300
  const OY = 220

  it('line', () => {
    const { segments, selrect } = placed('line', W, H, OX, OY)
    expect(recognizeShape(segments, selrect)).toEqual({ kind: 'line', params: {} })
  })

  it('rect', () => {
    const { segments, selrect } = placed('rect', W, H, OX, OY)
    expect(recognizeShape(segments, selrect)).toEqual({ kind: 'rect', params: {} })
  })

  it('ellipse', () => {
    const { segments, selrect } = placed('ellipse', W, H, OX, OY)
    expect(recognizeShape(segments, selrect)).toEqual({ kind: 'ellipse', params: {} })
  })

  it('triangle (distinct from a regular 3-gon)', () => {
    const { segments, selrect } = placed('triangle', W, H, OX, OY)
    expect(recognizeShape(segments, selrect)).toEqual({ kind: 'triangle', params: {} })
  })

  it('polygon recovers the side count', () => {
    for (const sides of [3, 5, 6, 8]) {
      const { segments, selrect } = placed('polygon', W, H, OX, OY, { sides })
      expect(recognizeShape(segments, selrect)).toEqual({ kind: 'polygon', params: { sides } })
    }
  })

  it('star recovers point count and inner ratio', () => {
    const { segments, selrect } = placed('star', W, H, OX, OY, { points: 5, innerRatio: 0.5 })
    const out = recognizeShape(segments, selrect)
    expect(out?.kind).toBe('star')
    expect(out?.params.points).toBe(5)
    expect(out?.params.innerRatio).toBeCloseTo(0.5, 2)
  })

  it('square is read as rect, not polygon(4)', () => {
    const { segments, selrect } = placed('rect', 100, 100, 0, 0)
    expect(recognizeShape(segments, selrect)?.kind).toBe('rect')
  })

  it('a 4-pointed diamond polygon does not collide with rect', () => {
    const { segments, selrect } = placed('polygon', 100, 100, 0, 0, { sides: 4 })
    expect(recognizeShape(segments, selrect)).toEqual({ kind: 'polygon', params: { sides: 4 } })
  })
})

describe('recognizeShape — rejects non-primitives', () => {
  it('returns null for a skewed quad beyond tolerance', () => {
    const segments: PathSegment[] = [
      { type: 'move-to', x: 0, y: 0 },
      { type: 'line-to', x: 100, y: 8 }, // visibly off a right angle
      { type: 'line-to', x: 92, y: 100 },
      { type: 'line-to', x: 4, y: 96 },
      { type: 'close-path' },
    ]
    expect(recognizeShape(segments, { x: 0, y: 0, width: 100, height: 100 })).toBeNull()
  })

  it('returns null for an empty path', () => {
    expect(recognizeShape([], { x: 0, y: 0, width: 10, height: 10 })).toBeNull()
  })

  it('returns null for a compound / networked path (more than one sub-path)', () => {
    // A clean rect plus a spur — two move-tos — must not read as a rect/primitive.
    const segments: PathSegment[] = [
      { type: 'move-to', x: 0, y: 0 },
      { type: 'line-to', x: 100, y: 0 },
      { type: 'line-to', x: 100, y: 100 },
      { type: 'line-to', x: 0, y: 100 },
      { type: 'close-path' },
      { type: 'move-to', x: 0, y: 0 },
      { type: 'line-to', x: -20, y: -20 },
    ]
    expect(recognizeShape(segments, { x: -20, y: -20, width: 120, height: 120 })).toBeNull()
  })
})
