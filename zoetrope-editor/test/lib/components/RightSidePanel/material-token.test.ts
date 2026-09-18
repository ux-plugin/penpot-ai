import { describe, it, expect } from 'vitest'
import { materializeTokenValue, uniformTokenType } from '@/lib/components/RightSidePanel/material-token'
import type { ReflectedUniform } from '@/lib/renderer/api/material'
import type { ResolvedToken } from '@/lib/tokens/resolve'

const u = (p: Partial<ReflectedUniform>): ReflectedUniform => ({ name: 'u', components: 1, isColor: false, count: 1, ...p })
const r = (p: Partial<ResolvedToken>): ResolvedToken => ({ name: 't', resolvedValue: null, ...p })

describe('uniformTokenType', () => {
  it('maps a layout(color) vec3/4 to a color token', () => {
    expect(uniformTokenType(u({ isColor: true, components: 4 }))).toBe('color')
    expect(uniformTokenType(u({ isColor: true, components: 3 }))).toBe('color')
  })
  it('maps a scalar to a number token', () => {
    expect(uniformTokenType(u({ components: 1 }))).toBe('number')
  })
  it('leaves non-color vecs / vec2 unbindable', () => {
    expect(uniformTokenType(u({ components: 2 }))).toBeNull()
    expect(uniformTokenType(u({ components: 3, isColor: false }))).toBeNull()
  })
})

describe('materializeTokenValue', () => {
  it('materializes a number token to f32', () => {
    expect(materializeTokenValue(u({ components: 1 }), r({ type: 'number', resolvedValue: '0.5' }))).toEqual({ type: 'f32', value: 0.5 })
  })
  it('materializes a #RRGGBB color to a normalized vec3', () => {
    // #ff8000 → 1, 0.5019.., 0
    const v = materializeTokenValue(u({ isColor: true, components: 3 }), r({ type: 'color', resolvedValue: '#ff8000' }))
    expect(v?.type).toBe('vec3')
    expect((v as { value: number[] }).value.map((x) => Math.round(x * 255))).toEqual([255, 128, 0])
  })
  it('materializes an #RRGGBBAA color to a vec4 including alpha', () => {
    const v = materializeTokenValue(u({ isColor: true, components: 4 }), r({ type: 'color', resolvedValue: '#00000080' }))
    expect(v?.type).toBe('vec4')
    expect((v as { value: number[] }).value.map((x) => Math.round(x * 255))).toEqual([0, 0, 0, 128])
  })
  it('returns null for an unresolved token or one with errors', () => {
    expect(materializeTokenValue(u({ components: 1 }), r({ resolvedValue: null }))).toBeNull()
    expect(materializeTokenValue(u({ components: 1 }), r({ resolvedValue: '1', errors: ['cycle'] }))).toBeNull()
    expect(materializeTokenValue(u({ components: 1 }), undefined)).toBeNull()
  })
})
