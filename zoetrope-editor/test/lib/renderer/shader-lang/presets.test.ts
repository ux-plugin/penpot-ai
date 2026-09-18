import { describe, expect, it } from 'vitest'
import { SHADER_PRESETS } from '@/lib/renderer/shader-lang/presets'

// The presets' shaders are verified to COMPILE in-browser (each renders a
// distinct thumbnail). These are the cheap structural guards against a typo
// slipping in later: unique ids, a `main` entry point, the engine uniform
// declared, and a thumbnail phase in range.
describe('shader presets', () => {
  it('have unique ids', () => {
    const ids = SHADER_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('each declares u_resolution and a main() entry point', () => {
    for (const p of SHADER_PRESETS) {
      expect(p.material.source, p.id).toContain('uniform float2 u_resolution')
      expect(p.material.source, p.id).toMatch(/half4\s+main\s*\(/)
    }
  })

  it('each carries a name, description and an in-range thumb phase', () => {
    for (const p of SHADER_PRESETS) {
      expect(p.name.length, p.id).toBeGreaterThan(0)
      expect(p.description.length, p.id).toBeGreaterThan(0)
      expect(p.thumbPhase, p.id).toBeGreaterThanOrEqual(0)
      expect(p.thumbPhase, p.id).toBeLessThanOrEqual(1)
    }
  })

  it('tags language as sksl and starts with no bound uniforms', () => {
    for (const p of SHADER_PRESETS) {
      expect(p.material.language, p.id).toBe('sksl')
      expect(p.material.uniforms ?? [], p.id).toEqual([])
    }
  })
})
