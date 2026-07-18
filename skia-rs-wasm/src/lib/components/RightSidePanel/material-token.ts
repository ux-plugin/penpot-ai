/**
 * Token binding for shader-material uniforms. A uniform can bind to a design
 * token: a color uniform (`layout(color)` vec3/4) to a `color` token, a scalar
 * to a `number` token. The token's resolved value is *materialized* into the
 * uniform's `MaterialUniformValue`, so the renderer only ever sees a plain
 * value — the binding is an editor-time convenience, not a new render input.
 *
 * Pure — no React, no doc access — so it's shared by the controls and testable.
 */

import type { MaterialUniformValue, ReflectedUniform } from '../../renderer/api/material'
import type { ResolvedToken } from '../../tokens/resolve'

/** The design-token type a uniform can bind to, or null if it can't bind. */
export type UniformTokenType = 'color' | 'number'

export function uniformTokenType(u: ReflectedUniform): UniformTokenType | null {
  const comps = u.components || 0
  if (u.isColor && comps >= 3) return 'color'
  if (comps === 1) return 'number'
  return null // vec2 / non-color vecs / matrices don't map to a single token
}

/** Parse #RGB / #RRGGBB / #RRGGBBAA into normalized [r,g,b,a], else null. */
function parseHex(input: string): [number, number, number, number] | null {
  let h = input.trim().replace(/^#/, '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (h.length === 6) h += 'ff'
  if (h.length !== 8 || !/^[0-9a-fA-F]{8}$/.test(h)) return null
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255
  return [n(0), n(2), n(4), n(6)]
}

/**
 * Materialize a resolved token into the value for uniform `u`, or null if the
 * token is unresolved / the wrong shape. Colors → vec3/vec4 (matching the
 * uniform's component count); numbers → f32.
 */
export function materializeTokenValue(
  u: ReflectedUniform,
  resolved: ResolvedToken | undefined,
): MaterialUniformValue | null {
  if (!resolved || resolved.errors?.length || resolved.resolvedValue == null) return null
  const tt = uniformTokenType(u)
  if (tt === 'number') {
    const n = Number(resolved.resolvedValue)
    return Number.isFinite(n) ? { type: 'f32', value: n } : null
  }
  if (tt === 'color') {
    const rgba = parseHex(String(resolved.resolvedValue))
    if (!rgba) return null
    return (u.components || 0) >= 4
      ? { type: 'vec4', value: [rgba[0], rgba[1], rgba[2], rgba[3]] }
      : { type: 'vec3', value: [rgba[0], rgba[1], rgba[2]] }
  }
  return null
}
