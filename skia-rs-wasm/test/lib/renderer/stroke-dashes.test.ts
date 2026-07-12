import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeDashes,
  miterAngleToLimit,
  miterLimitToAngle,
  type StrokeWithSettings,
} from '../../../src/lib/renderer/stroke-settings'

// Stub the WASM context guard so setShapeStrokes runs without a live renderer.
vi.mock('../../../src/lib/renderer/api/context', () => ({ checkContext: () => {} }))

import { setShapeStrokes } from '../../../src/lib/renderer/api/strokes'
import type { WasmModule } from '../../../src/lib/renderer/wasm-types'

describe('normalizeDashes', () => {
  it('passes an even pattern through unchanged', () => {
    expect(normalizeDashes([8, 6])).toEqual([8, 6])
    expect(normalizeDashes([8, 6, 2, 6])).toEqual([8, 6, 2, 6])
  })

  it('doubles an odd-length pattern (SVG semantics)', () => {
    expect(normalizeDashes([5])).toEqual([5, 5])
    expect(normalizeDashes([8, 6, 2])).toEqual([8, 6, 2, 8, 6, 2])
  })

  it('clamps negative / non-finite to 0', () => {
    expect(normalizeDashes([-3, 6])).toEqual([0, 6])
    expect(normalizeDashes([Number.NaN, 4])).toEqual([0, 4])
  })

  it('collapses an all-zero (or empty) pattern to solid', () => {
    expect(normalizeDashes([0, 0])).toEqual([])
    expect(normalizeDashes([])).toEqual([])
  })
})

describe('miter angle ↔ limit', () => {
  it("maps Skia's default limit 4 to Figma's ~28.96°", () => {
    expect(miterLimitToAngle(4)).toBeCloseTo(28.955, 2)
  })

  it('round-trips angle → limit → angle', () => {
    for (const limit of [1, 2, 4, 10]) {
      expect(miterAngleToLimit(miterLimitToAngle(limit))).toBeCloseTo(limit, 4)
    }
  })
})

describe('setShapeStrokes — Basic settings reach the WASM ABI', () => {
  let calls: string[]
  let heap: Uint8Array
  let dashesSeen: number[] | null
  let propsSeen: [number, number, number] | null
  let module: WasmModule

  beforeEach(() => {
    calls = []
    heap = new Uint8Array(1024)
    dashesSeen = null
    propsSeen = null
    const rec =
      (name: string, ret?: number) =>
      (..._args: unknown[]) => {
        calls.push(name)
        return ret
      }
    module = {
      HEAPU8: heap,
      _clear_shape_strokes: rec('_clear_shape_strokes'),
      _add_shape_center_stroke: rec('_add_shape_center_stroke'),
      _add_shape_inner_stroke: rec('_add_shape_inner_stroke'),
      _add_shape_outer_stroke: rec('_add_shape_outer_stroke'),
      _add_shape_stroke_fill: rec('_add_shape_stroke_fill'),
      _alloc_bytes: rec('_alloc_bytes', 0),
      _free_bytes: rec('_free_bytes'),
      _set_shape_stroke_props: vi.fn((join: number, cap: number, miter: number) => {
        propsSeen = [join, cap, miter]
      }),
      _set_shape_stroke_dashes: vi.fn(() => {
        const dv = new DataView(heap.buffer)
        dashesSeen = [dv.getFloat32(0, true), dv.getFloat32(4, true)]
      }),
      _set_shape_stroke_dynamic: vi.fn(),
    } as unknown as WasmModule
  })

  const run = (stroke: Partial<StrokeWithSettings>) =>
    setShapeStrokes(module, 'shape-1', [{ strokeColor: '#112233', strokeWidth: 2, ...stroke }])

  it('sends a custom dash pattern via _set_shape_stroke_dashes', () => {
    run({ strokeStyle: 'dashed', strokeDashes: [8, 6] })
    expect(module._set_shape_stroke_dashes).toHaveBeenCalledOnce()
    expect(dashesSeen?.[0]).toBeCloseTo(8)
    expect(dashesSeen?.[1]).toBeCloseTo(6)
    expect(module._set_shape_stroke_props).not.toHaveBeenCalled()
  })

  it('sends join / dash-cap / miter via _set_shape_stroke_props', () => {
    run({ strokeJoin: 'round', strokeDashCap: 'square', strokeMiterLimit: 4 })
    // round=1, square=2, miter=4
    expect(propsSeen).toEqual([1, 2, 4])
    expect(module._set_shape_stroke_dashes).not.toHaveBeenCalled()
  })

  it('sends a Dynamic perturbation via _set_shape_stroke_dynamic when wiggle > 0', () => {
    run({ strokeDynamic: { frequency: 0.5, wiggle: 0.3, smoothen: 0.5 } })
    expect(module._set_shape_stroke_dynamic).toHaveBeenCalledWith(0.5, 0.3, 0.5)
  })

  it('skips Dynamic when wiggle is 0', () => {
    run({ strokeDynamic: { frequency: 0.5, wiggle: 0, smoothen: 0.5 } })
    expect(module._set_shape_stroke_dynamic).not.toHaveBeenCalled()
  })

  it('leaves a plain solid stroke untouched (no dash/props/dynamic calls)', () => {
    run({})
    expect(module._set_shape_stroke_dashes).not.toHaveBeenCalled()
    expect(module._set_shape_stroke_props).not.toHaveBeenCalled()
    expect(module._set_shape_stroke_dynamic).not.toHaveBeenCalled()
  })

  it('routes alignment to the matching add_* entrypoint', () => {
    run({ strokeAlignment: 'inner' })
    expect(calls).toContain('_add_shape_inner_stroke')
    expect(calls).not.toContain('_add_shape_center_stroke')
  })
})
