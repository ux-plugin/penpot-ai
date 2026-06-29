/**
 * constrainResizeScale — proportional-resize constraint, with the 3D-scene
 * aspect-lock (always on, driven by the handle's active axis).
 */

import { describe, expect, it } from 'vitest'
import { constrainResizeScale } from '../../../../src/lib/renderer/handlers/resize'

const RIGHT = { x: 1, y: 0 }
const BOTTOM = { x: 0, y: 1 }
const CORNER = { x: 1, y: 1 }

describe('constrainResizeScale', () => {
  it('passes through when neither lock nor shift', () => {
    expect(constrainResizeScale(1.5, 0.8, CORNER, { lockAspect: false, shift: false })).toEqual({
      sx: 1.5,
      sy: 0.8,
    })
  })

  it('shift locks to the larger magnitude (sign-preserving)', () => {
    expect(constrainResizeScale(1.5, 0.8, CORNER, { lockAspect: false, shift: true })).toEqual({
      sx: 1.5,
      sy: 1.5,
    })
  })

  it('3D side handle scales BOTH axes — including shrink (the bug max() would block)', () => {
    // A side handle pins the inactive axis to 1; the lock must drive both from the
    // active axis, so a shrink (sx < 1) actually shrinks instead of snapping to 1.
    expect(constrainResizeScale(0.5, 1, RIGHT, { lockAspect: true, shift: false })).toEqual({
      sx: 0.5,
      sy: 0.5,
    })
    expect(constrainResizeScale(1.7, 1, RIGHT, { lockAspect: true, shift: false })).toEqual({
      sx: 1.7,
      sy: 1.7,
    })
    expect(constrainResizeScale(1, 0.6, BOTTOM, { lockAspect: true, shift: false })).toEqual({
      sx: 0.6,
      sy: 0.6,
    })
  })

  it('3D corner follows the axis that moved more', () => {
    expect(constrainResizeScale(1.8, 1.1, CORNER, { lockAspect: true, shift: false })).toEqual({
      sx: 1.8,
      sy: 1.8,
    })
    expect(constrainResizeScale(1.1, 0.4, CORNER, { lockAspect: true, shift: false })).toEqual({
      sx: 0.4,
      sy: 0.4,
    })
  })

  it('aspect-lock takes precedence over shift', () => {
    expect(constrainResizeScale(0.5, 1, RIGHT, { lockAspect: true, shift: true })).toEqual({
      sx: 0.5,
      sy: 0.5,
    })
  })
})
