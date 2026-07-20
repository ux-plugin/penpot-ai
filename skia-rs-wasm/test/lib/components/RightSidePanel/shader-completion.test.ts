import { describe, it, expect } from 'vitest'
import { buildCompletionOptions } from '@/lib/components/RightSidePanel/shader-completion'
import type { ShaderCompletion } from '@/lib/renderer/shader-lang'

const BUILTINS: ShaderCompletion[] = [
  { label: 'uniform', kind: 'keyword', detail: 'keyword' },
  { label: 'float', kind: 'type', detail: 'type' },
  { label: 'u_time', kind: 'variable', detail: 'engine uniform' },
  { label: 'sin', kind: 'function', detail: 'builtin' },
]

describe('buildCompletionOptions', () => {
  it('maps each neutral kind to its CodeMirror completion type', () => {
    const opts = buildCompletionOptions([], BUILTINS)
    expect(opts.map((o) => [o.label, o.type])).toEqual([
      ['uniform', 'keyword'],
      ['float', 'type'],
      ['u_time', 'variable'],
      ['sin', 'function'],
    ])
  })

  it('lists declared identifiers first, ahead of the builtin vocabulary', () => {
    const declared: ShaderCompletion[] = [
      { label: 'u_color', kind: 'variable', detail: 'uniform' },
      { label: 'TAU', kind: 'constant', detail: 'const' },
    ]
    const opts = buildCompletionOptions(declared, BUILTINS)
    expect(opts.slice(0, 2).map((o) => o.label)).toEqual(['u_color', 'TAU'])
    expect(opts.map((o) => o.label)).toContain('sin')
  })

  it('de-dupes a declared name that shadows a builtin — keeps the declared one', () => {
    const declared: ShaderCompletion[] = [{ label: 'u_time', kind: 'variable', detail: 'uniform' }]
    const opts = buildCompletionOptions(declared, BUILTINS)
    const uTimes = opts.filter((o) => o.label === 'u_time')
    expect(uTimes).toHaveLength(1)
    expect(uTimes[0].detail).toBe('uniform') // the author's, not 'engine uniform'
  })
})
