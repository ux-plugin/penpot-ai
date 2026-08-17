/**
 * constrainResizeScale — per-axis resize constraint (Shift = uniform scale).
 *
 * 3D scenes no longer aspect-lock on resize: they use the window/crop camera
 * model (the box is a viewport onto the world), so they resize per-side — one
 * axis on a side handle, both on a corner — exactly like any other shape.
 */

import { describe, expect, it } from 'vitest'
import { constrainResizeScale } from '../../../../src/lib/renderer/handlers/resize'

describe('constrainResizeScale', () => {
  it('passes through without shift — per-side / per-corner resize', () => {
    expect(constrainResizeScale(1.5, 0.8, { shift: false })).toEqual({ sx: 1.5, sy: 0.8 })
    // A side handle pins the inactive axis to 1; we leave it alone.
    expect(constrainResizeScale(1.7, 1, { shift: false })).toEqual({ sx: 1.7, sy: 1 })
    expect(constrainResizeScale(1, 0.6, { shift: false })).toEqual({ sx: 1, sy: 0.6 })
  })

  it('shift locks to the larger magnitude (sign-preserving)', () => {
    expect(constrainResizeScale(1.5, 0.8, { shift: true })).toEqual({ sx: 1.5, sy: 1.5 })
    expect(constrainResizeScale(-0.4, 0.9, { shift: true })).toEqual({ sx: -0.9, sy: 0.9 })
  })
})
