import { describe, expect, it } from 'vitest'
import {
  getSubpaths,
  segmentsToSubpaths,
  subpathsToSegments,
  compoundContent,
  type Subpath,
} from '../../../../src/lib/renderer/geom/subpaths'
import { anchorsToSegments, type Anchor } from '../../../../src/lib/renderer/geom/anchors'

const corner = (x: number, y: number): Anchor => ({ point: { x, y } })

const triangle: Subpath = { vertices: [corner(0, 0), corner(10, 0), corner(5, 9)], closed: true }
const stroke: Subpath = { vertices: [corner(20, 0), corner(30, 0)], closed: false }

describe('segmentsToSubpaths', () => {
  it('splits a multi-move-to segment list into sub-paths', () => {
    const segs = subpathsToSegments([triangle, stroke])
    expect(segs.filter((s) => s.type === 'move-to')).toHaveLength(2)
    const back = segmentsToSubpaths(segs)
    expect(back).toHaveLength(2)
    expect(back[0]).toEqual(triangle)
    expect(back[1]).toEqual(stroke)
  })

  it('a single ring round-trips as one sub-path', () => {
    expect(segmentsToSubpaths(anchorsToSegments(triangle.vertices, true))).toEqual([triangle])
  })
})

describe('getSubpaths normalizer', () => {
  it('reads explicit subpaths', () => {
    expect(getSubpaths({ subpaths: [triangle, stroke] })).toEqual([triangle, stroke])
  })

  it('wraps the legacy single vertices + closed', () => {
    expect(getSubpaths({ vertices: triangle.vertices, closed: true })).toEqual([triangle])
  })

  it('falls back to splitting raw segments', () => {
    const segs = subpathsToSegments([triangle, stroke])
    expect(getSubpaths({ segments: segs })).toEqual([triangle, stroke])
  })

  it('empty content → no sub-paths', () => {
    expect(getSubpaths(null)).toEqual([])
    expect(getSubpaths({})).toEqual([])
  })

  it('returns clones (mutating the result does not touch the input)', () => {
    const input = { subpaths: [triangle] }
    const out = getSubpaths(input)
    out[0].vertices[0].point.x = 999
    expect(input.subpaths[0].vertices[0].point.x).toBe(0)
  })
})

describe('compoundContent', () => {
  it('a single sub-path also exposes vertices + closed (back-compat)', () => {
    const c = compoundContent([triangle])
    expect(c.subpaths).toEqual([triangle])
    expect(c.vertices).toEqual(triangle.vertices)
    expect(c.closed).toBe(true)
    expect(c.segments).toEqual(anchorsToSegments(triangle.vertices, true))
  })

  it('multiple sub-paths: no single vertices field, concatenated segments', () => {
    const c = compoundContent([triangle, stroke])
    expect(c.vertices).toBeUndefined()
    expect(c.segments).toEqual(subpathsToSegments([triangle, stroke]))
    expect(c.subpaths).toHaveLength(2)
  })

  it('drops empty sub-paths', () => {
    const c = compoundContent([triangle, { vertices: [], closed: false }])
    expect(c.subpaths).toHaveLength(1)
  })
})
