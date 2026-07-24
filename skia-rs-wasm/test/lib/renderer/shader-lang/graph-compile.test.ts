import { describe, expect, it } from 'vitest'
import { compileGraphToSksl } from '@/lib/renderer/shader-lang/graph/compile'
import type { Edge, GraphNode, ShaderGraph } from '@/lib/renderer/shader-lang/graph/types'

/** Terse graph builders — position is irrelevant to codegen. */
function n(id: string, kind: string, params?: GraphNode['params']): GraphNode {
  return { id, kind, position: { x: 0, y: 0 }, ...(params ? { params } : {}) }
}
function e(fromNode: string, fromPort: string, toNode: string, toPort: string): Edge {
  return { id: `${fromNode}.${fromPort}->${toNode}.${toPort}`, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } }
}
function graph(nodes: GraphNode[], edges: Edge[]): ShaderGraph {
  return { nodes, edges }
}

/** Index of a declaration/use, for asserting things are declared before used. */
const idx = (src: string, needle: string) => src.indexOf(needle)

describe('compileGraphToSksl', () => {
  it('compiles a bare output node to a valid neutral shader', () => {
    const { source, error } = compileGraphToSksl(graph([n('out', 'output')], []))
    expect(error).toBeUndefined()
    expect(source).toContain('half4 main(float2 p)')
    // Unwired input falls back to the param constant, so it still compiles.
    expect(source).toContain('return half4(half3(0.5, 0.5, 0.5), 1.0);')
    // Nothing referenced the engine uniforms, so none are declared.
    expect(source).not.toContain('uniform')
  })

  it('declares u_resolution only when the graph samples UV', () => {
    const g = graph(
      [n('uv', 'uv'), n('grad', 'gradient'), n('out', 'output')],
      [e('uv', 'uv', 'grad', 'uv'), e('grad', 'out', 'out', 'color')],
    )
    const { source, error } = compileGraphToSksl(g)
    expect(error).toBeUndefined()
    expect(source).toContain('uniform float2 u_resolution;')
    expect(source).not.toContain('uniform float u_phase;')
    expect(source).toContain('(p / u_resolution)')
    expect(source).toContain('half4 main(float2 p)')
  })

  it('declares u_phase when a Time node drives something', () => {
    const g = graph(
      [n('t', 'time'), n('mix', 'mix'), n('out', 'output')],
      [e('t', 't', 'mix', 't'), e('mix', 'out', 'out', 'color')],
    )
    const { source } = compileGraphToSksl(g)
    expect(source).toContain('uniform float u_phase;')
    expect(source).toContain('u_phase')
  })

  // The whole point of the graph: two generators become one shader.
  it('COMBINES two generators through a mix node', () => {
    const g = graph(
      [
        n('uv', 'uv'),
        n('a', 'gradient', { colorA: [1, 0, 0], colorB: [0, 1, 0] }),
        n('b', 'checker', { scale: 6 }),
        n('m', 'mix', { t: 0.35 }),
        n('out', 'output'),
      ],
      [
        e('uv', 'uv', 'a', 'uv'),
        e('uv', 'uv', 'b', 'uv'),
        e('a', 'out', 'm', 'a'),
        e('b', 'out', 'm', 'b'),
        e('m', 'out', 'out', 'color'),
      ],
    )
    const { source, error } = compileGraphToSksl(g)
    expect(error).toBeUndefined()

    // Both generators emitted their own temps, and the return folds both in.
    // (v1 is a float2 — the checker's cell index — so match the name, not the type.)
    expect(source).toContain('float v0 =')
    expect(source).toContain('v1 =')
    const ret = source.slice(source.lastIndexOf('return'))
    expect(ret).toContain('v0')
    expect(ret).toContain('v2') // checker's parity temp feeds its mix
    // The combiner's blend factor is the node's param.
    expect(ret).toContain('0.35')
    // The custom gradient colors were inlined.
    expect(source).toContain('half3(1.0, 0.0, 0.0)')
    expect(source).toContain('half3(0.0, 1.0, 0.0)')
  })

  it('emits every temp before it is used (topological order)', () => {
    const g = graph(
      [n('uv', 'uv'), n('grad', 'gradient'), n('out', 'output')],
      [e('uv', 'uv', 'grad', 'uv'), e('grad', 'out', 'out', 'color')],
    )
    const { source } = compileGraphToSksl(g)
    expect(idx(source, 'float v0 =')).toBeLessThan(idx(source, 'return half4('))
  })

  it('pulls in helper functions (and their deps) when a node needs them', () => {
    const g = graph(
      [n('uv', 'uv'), n('nz', 'noise'), n('out', 'output')],
      [e('uv', 'uv', 'nz', 'uv'), e('nz', 'out', 'out', 'color')],
    )
    const { source } = compileGraphToSksl(g)
    expect(source).toContain('float _vnoise(float2 p)')
    expect(source).toContain('float _hash21(float2 p)')
    // vnoise calls hash21, so hash21 must be defined first.
    expect(idx(source, '_hash21(float2 p)')).toBeLessThan(idx(source, '_vnoise(float2 p)'))
    // Helpers precede main.
    expect(idx(source, '_vnoise(float2 p)')).toBeLessThan(idx(source, 'half4 main'))
  })

  it('coerces a float output wired into a color input', () => {
    const g = graph(
      [n('uv', 'uv'), n('nz', 'noise'), n('out', 'output')],
      [e('uv', 'uv', 'nz', 'uv'), e('nz', 'out', 'out', 'color')],
    )
    const { source } = compileGraphToSksl(g)
    // noise returns a float temp; the output takes a color -> splat to half3.
    expect(source).toMatch(/return half4\(half3\(v\d+\), 1\.0\);/)
  })

  it('uses the same-named param when an input port is unwired', () => {
    const g = graph([n('grad', 'gradient', { colorA: [0.25, 0, 0] }), n('out', 'output')], [
      e('grad', 'out', 'out', 'color'),
    ])
    const { source } = compileGraphToSksl(g)
    expect(source).toContain('half3(0.25, 0.0, 0.0)')
    // uv was never wired, so the gradient falls back to its constant.
    expect(source).toContain('float2(0.5, 0.5)')
  })

  it('reports a missing output node and still returns compilable source', () => {
    const { source, error } = compileGraphToSksl(graph([n('uv', 'uv')], []))
    expect(error).toMatch(/no Output/i)
    expect(source).toContain('half4 main(float2 p)')
  })

  it('detects a cycle and still returns compilable source', () => {
    const g = graph(
      [n('m1', 'mix'), n('m2', 'mix'), n('out', 'output')],
      [e('m1', 'out', 'm2', 'a'), e('m2', 'out', 'm1', 'a'), e('m1', 'out', 'out', 'color')],
    )
    const { source, error } = compileGraphToSksl(g)
    expect(error).toMatch(/cycle/i)
    expect(source).toContain('half4 main(float2 p)')
  })

  it('is deterministic — the same graph compiles to the same source', () => {
    const build = () =>
      compileGraphToSksl(
        graph(
          [n('uv', 'uv'), n('grad', 'gradient'), n('out', 'output')],
          [e('uv', 'uv', 'grad', 'uv'), e('grad', 'out', 'out', 'color')],
        ),
      ).source
    expect(build()).toBe(build())
  })
})
