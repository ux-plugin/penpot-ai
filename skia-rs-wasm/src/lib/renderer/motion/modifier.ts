/**
 * Adapter from sampled property values to a render modifier — the seam between
 * the renderer-agnostic sampler and whatever applies transforms (the WASM
 * bridge, an export emitter, …). Composes translate ∘ rotate ∘ scale into one
 * affine matrix (rotation and scale taken around `pivot`, default origin) and
 * passes opacity through. Matrices use penpot's {a,b,c,d,e,f} convention; the
 * shared affine helpers live in geom/matrix.
 */

import type { Matrix } from 'penpot-exporter/types'
import { IDENTITY_MATRIX, composeMatrix, rotationMatrixAroundPoint, translateMatrix } from '../geom/matrix'
import type { SampledProperties } from './types'

export interface Pivot {
  cx: number
  cy: number
}

export interface Modifier {
  matrix: Matrix
  /** Multiplicative opacity in [0, 1], present only when the clip animates it. */
  opacity?: number
}

const ORIGIN: Pivot = { cx: 0, cy: 0 }

/** Scale by (sx, sy) about (cx, cy). */
function scaleAround(cx: number, cy: number, sx: number, sy: number): Matrix {
  return { a: sx, b: 0, c: 0, d: sy, e: cx * (1 - sx), f: cy * (1 - sy) }
}

/**
 * Compose sampled props into `{ matrix, opacity }`. Order is translate ∘ rotate
 * ∘ scale (scale applied first), with rotation and scale taken around `pivot`.
 */
export function propsToModifier(props: SampledProperties, pivot: Pivot = ORIGIN): Modifier {
  const sx = props.scaleX ?? 1
  const sy = props.scaleY ?? 1
  let matrix: Matrix = sx !== 1 || sy !== 1 ? scaleAround(pivot.cx, pivot.cy, sx, sy) : IDENTITY_MATRIX
  if (props.rotation) {
    matrix = composeMatrix(rotationMatrixAroundPoint(pivot.cx, pivot.cy, props.rotation), matrix)
  }
  const dx = props.x ?? 0
  const dy = props.y ?? 0
  if (dx !== 0 || dy !== 0) {
    matrix = composeMatrix(translateMatrix(dx, dy), matrix)
  }
  const modifier: Modifier = { matrix }
  if (props.opacity !== undefined) modifier.opacity = props.opacity
  return modifier
}
