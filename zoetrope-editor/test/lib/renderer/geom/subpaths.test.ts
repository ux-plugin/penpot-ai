import { describe, expect, it } from 'vitest'
import {
  getSubpaths,
  joinOpenEnds,
  moveCoincidentPoint,
  reverseSubpath,
  segmentsToSubpaths,
  subpathsToSegments,
  compoundContent,
  type Subpath,
} from '../../../../src/lib/renderer/geom/subpaths'
import { anchorsToSegments, type Anchor } from '../../../../src/lib/renderer/geom/anchors'

const corner = (x: number, y: number): Anchor => ({ point: { x, y } })

const triangle: Subpath = { vertices: [corner(0, 0), corner(10, 0), corner(5, 9)], closed: true }
const stroke: Subpath = { vertices: [corner(20, 0), corner(30, 0)], closed: false }
const pts = (sp: Subpath) => sp.vertices.map((v) => [v.point.x, v.point.y])

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

describe('reverseSubpath', () => {
  it('reverses vertex order', () => {
    expect(pts(reverseSubpath(stroke))).toEqual([[30, 0], [20, 0]])
  })

  it('swaps handleIn and handleOut on each anchor', () => {
    const curved: Subpath = {
      vertices: [
        { point: { x: 0, y: 0 }, handleOut: { x: 3, y: 1 } },
        { point: { x: 10, y: 0 }, handleIn: { x: 7, y: 1 } },
      ],
      closed: false,
    }
    const r = reverseSubpath(curved)
    // first vertex of the reversed ring is the old last; its in-tangent becomes out
    expect(r.vertices[0].point).toEqual({ x: 10, y: 0 })
    expect(r.vertices[0].handleOut).toEqual({ x: 7, y: 1 })
    expect(r.vertices[0].handleIn).toBeUndefined()
    expect(r.vertices[1].point).toEqual({ x: 0, y: 0 })
    expect(r.vertices[1].handleIn).toEqual({ x: 3, y: 1 })
  })

  it('does not mutate the input', () => {
    reverseSubpath(stroke)
    expect(pts(stroke)).toEqual([[20, 0], [30, 0]])
  })
})

describe('joinOpenEnds', () => {
  const a: Subpath = { vertices: [corner(0, 0), corner(10, 0)], closed: false }
  const b: Subpath = { vertices: [corner(20, 0), corner(30, 0)], closed: false }

  it('end → start: A then B, in order', () => {
    const out = joinOpenEnds([a, b], 0, 'end', 1, 'start')
    expect(out).toHaveLength(1)
    expect(pts(out[0])).toEqual([[0, 0], [10, 0], [20, 0], [30, 0]])
    expect(out[0].closed).toBe(false)
  })

  it('end → end: A then reversed B', () => {
    const out = joinOpenEnds([a, b], 0, 'end', 1, 'end')
    expect(pts(out[0])).toEqual([[0, 0], [10, 0], [30, 0], [20, 0]])
  })

  it('start → start: reversed A then B', () => {
    const out = joinOpenEnds([a, b], 0, 'start', 1, 'start')
    expect(pts(out[0])).toEqual([[10, 0], [0, 0], [20, 0], [30, 0]])
  })

  it('start → end: reversed A then reversed B', () => {
    const out = joinOpenEnds([a, b], 0, 'start', 1, 'end')
    expect(pts(out[0])).toEqual([[10, 0], [0, 0], [30, 0], [20, 0]])
  })

  it('merged ring takes the lower slot; other sub-paths keep their order', () => {
    const out = joinOpenEnds([triangle, a, b], 1, 'end', 2, 'start')
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual(triangle) // untouched, still at slot 0
    expect(pts(out[1])).toEqual([[0, 0], [10, 0], [20, 0], [30, 0]])
  })

  it('same sub-path: closes it instead of merging', () => {
    const out = joinOpenEnds([a, b], 1, 'end', 1, 'start')
    expect(out).toHaveLength(2)
    expect(out[1].closed).toBe(true)
    expect(pts(out[1])).toEqual([[20, 0], [30, 0]])
  })

  it('does not mutate the inputs', () => {
    joinOpenEnds([a, b], 0, 'end', 1, 'start')
    expect(pts(a)).toEqual([[0, 0], [10, 0]])
    expect(pts(b)).toEqual([[20, 0], [30, 0]])
  })
})

describe('moveCoincidentPoint (rigid junction move)', () => {
  // A closed triangle sharing corner (0,0) with an open spur — the junction case.
  const ring: Subpath = { vertices: [corner(0, 0), corner(10, 0), corner(5, 9)], closed: true }
  const spur: Subpath = { vertices: [corner(0, 0), corner(-6, -6)], closed: false }

  it('moves the shared node in every sub-path by the same delta', () => {
    const out = moveCoincidentPoint([ring, spur], { x: 0, y: 0 }, { x: 3, y: -2 })
    expect(out[0].vertices[0].point).toEqual({ x: 3, y: -2 }) // ring corner
    expect(out[1].vertices[0].point).toEqual({ x: 3, y: -2 }) // spur base — moved in lockstep
    // they remain coincident → still a junction
    expect(out[0].vertices[0].point).toEqual(out[1].vertices[0].point)
  })

  it('leaves non-coincident vertices untouched', () => {
    const out = moveCoincidentPoint([ring, spur], { x: 0, y: 0 }, { x: 3, y: -2 })
    expect(out[0].vertices[1].point).toEqual({ x: 10, y: 0 })
    expect(out[1].vertices[1].point).toEqual({ x: -6, y: -6 })
  })

  it('carries the moved vertex’s handles with it', () => {
    const curvedRing: Subpath = {
      vertices: [{ point: { x: 0, y: 0 }, handleOut: { x: 2, y: 1 } }, corner(10, 0)],
      closed: false,
    }
    const out = moveCoincidentPoint([curvedRing], { x: 0, y: 0 }, { x: 5, y: 5 })
    expect(out[0].vertices[0].point).toEqual({ x: 5, y: 5 })
    expect(out[0].vertices[0].handleOut).toEqual({ x: 7, y: 6 })
  })

  it('does not mutate the input', () => {
    moveCoincidentPoint([ring, spur], { x: 0, y: 0 }, { x: 3, y: -2 })
    expect(ring.vertices[0].point).toEqual({ x: 0, y: 0 })
    expect(spur.vertices[0].point).toEqual({ x: 0, y: 0 })
  })
})
