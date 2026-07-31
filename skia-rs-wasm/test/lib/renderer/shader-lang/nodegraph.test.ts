/**
 * The nested shader node model and its codegen.
 *
 * The example built here is the one from the design: a Material root containing
 * a Warp group (Noise → Offset → Mix) and a Tint leaf. It exists to pin the
 * central claim — a group is a function that calls the functions inside it, and
 * the containment tree is the call structure.
 */

import { describe, expect, it } from 'vitest'
import {
  OUT,
  childrenOf,
  validate,
  type Edge,
  type ShaderGraph,
  type ShaderNode,
} from '../../../../src/lib/renderer/shader-lang/nodegraph/model'
import { compileGraph } from '../../../../src/lib/renderer/shader-lang/nodegraph/compile'
import {
  TEMPLATE_BY_KIND,
  instantiate,
} from '../../../../src/lib/renderer/shader-lang/nodegraph/palette'

type NodeInit = Partial<ShaderNode> & Pick<ShaderNode, 'id' | 'name' | 'returns'>

function node(init: NodeInit): ShaderNode {
  return {
    parentId: undefined,
    pos: init.id,
    position: { x: 0, y: 0 },
    params: [],
    values: {},
    ...init,
  }
}

function edge(from: [string, string], to: [string, string]): Edge {
  return { id: `${from[0]}.${from[1]}->${to[0]}.${to[1]}`, from: { node: from[0], port: from[1] }, to: { node: to[0], port: to[1] } }
}

function graphOf(nodes: ShaderNode[], edges: Edge[]): ShaderGraph {
  return {
    root: nodes[0].id,
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges: Object.fromEntries(edges.map((e) => [e.id, e])),
  }
}

/** Material → [ Warp → (Noise, Offset, Mix), Tint ] */
function example(): ShaderGraph {
  const nodes = [
    node({ id: 'r', name: 'Material', returns: 'vec4', params: [{ name: 'uv', type: 'vec2' }] }),
    node({ id: 'warp', name: 'Warp', parentId: 'r', pos: 'a', returns: 'color', params: [{ name: 'uv', type: 'vec2' }] }),
    node({
      id: 'tint',
      name: 'Tint',
      parentId: 'r',
      pos: 'b',
      returns: 'color',
      params: [{ name: 'c', type: 'color' }],
      body: 'return c * 0.5;',
    }),
    node({
      id: 'noise',
      name: 'Noise',
      parentId: 'warp',
      pos: 'a',
      returns: 'color',
      params: [
        { name: 'uv', type: 'vec2' },
        { name: 'scale', type: 'float' },
      ],
      values: { scale: { exposed: { uniform: 'warp_scale' } } },
      body: 'return half3(fract(uv * scale), 0.0);',
    }),
    node({
      id: 'offset',
      name: 'Offset',
      parentId: 'warp',
      pos: 'b',
      returns: 'vec2',
      params: [
        { name: 'uv', type: 'vec2' },
        { name: 'n', type: 'color' },
      ],
      body: 'return uv + n.xy;',
    }),
    node({
      id: 'mix',
      name: 'Mix',
      parentId: 'warp',
      pos: 'c',
      returns: 'color',
      params: [
        { name: 'a', type: 'color' },
        { name: 'b', type: 'vec2' },
        { name: 't', type: 'float' },
      ],
      values: { t: { value: 0.5, pinned: true } },
      body: 'return mix(a, half3(b, 0.0), t);',
    }),
  ]
  const edges = [
    edge(['r', 'uv'], ['warp', 'uv']),
    edge(['warp', OUT], ['tint', 'c']),
    edge(['tint', OUT], ['r', OUT]),
    edge(['warp', 'uv'], ['noise', 'uv']),
    edge(['warp', 'uv'], ['offset', 'uv']),
    edge(['noise', OUT], ['offset', 'n']),
    edge(['noise', OUT], ['mix', 'a']),
    edge(['offset', OUT], ['mix', 'b']),
    edge(['mix', OUT], ['warp', OUT]),
  ]
  return graphOf(nodes, edges)
}

describe('the model', () => {
  it('accepts the example', () => {
    expect(validate(example())).toEqual([])
  })

  it('lists children in sibling order', () => {
    expect(childrenOf(example(), 'warp').map((n) => n.name)).toEqual(['Noise', 'Offset', 'Mix'])
  })

  it('rejects a node that has both a body and children', () => {
    const g = example()
    g.nodes.warp = { ...g.nodes.warp, body: 'return half3(0.0);' }
    expect(validate(g)).toContain('Warp has both a body and children')
  })

  it('rejects a node with neither', () => {
    const g = example()
    g.nodes.tint = { ...g.nodes.tint, body: undefined }
    expect(validate(g)).toContain('Tint has neither a body nor children')
  })

  it('rejects an edge that reaches into a group from outside', () => {
    const g = example()
    // Tint lives beside Warp, so it must not wire straight to Warp's innards.
    const bad = edge(['tint', OUT], ['mix', 'a'])
    g.edges[bad.id] = bad
    expect(validate(g).some((p) => p.includes('crosses a group boundary'))).toBe(true)
  })

  it('rejects a cycle among siblings', () => {
    const g = example()
    const back = edge(['mix', OUT], ['noise', 'uv'])
    g.edges[back.id] = back
    expect(validate(g)).toContain('Warp contains a cycle')
  })
})

describe('codegen', () => {
  it('emits one function per node, children before the group that calls them', () => {
    const { source, error } = compileGraph(example())
    expect(error).toBeUndefined()

    const at = (needle: string) => source.indexOf(needle)
    expect(at('half3 Noise_noise(')).toBeGreaterThan(-1)
    expect(at('float2 Offset_offset(')).toBeGreaterThan(-1)
    expect(at('half3 Warp_warp(')).toBeGreaterThan(-1)
    // Every leaf is declared before the group whose body calls it.
    expect(at('half3 Noise_noise(')).toBeLessThan(at('half3 Warp_warp('))
    expect(at('float2 Offset_offset(')).toBeLessThan(at('half3 Warp_warp('))
  })

  it('makes a group a function that calls the nodes inside it', () => {
    const { source } = compileGraph(example())
    const warp = source.slice(source.indexOf('half3 Warp_warp('))
    const body = warp.slice(0, warp.indexOf('\n}') + 2)

    expect(body).toContain('Noise_noise(')
    expect(body).toContain('Offset_offset(')
    expect(body).toContain('Mix_mix(')
    // Dependency order inside the body, not sibling order.
    expect(body.indexOf('Noise_noise(')).toBeLessThan(body.indexOf('Offset_offset('))
    expect(body.indexOf('Offset_offset(')).toBeLessThan(body.indexOf('Mix_mix('))
  })

  it('passes the group parameter through the boundary by name', () => {
    const { source } = compileGraph(example())
    const warp = source.slice(source.indexOf('half3 Warp_warp('))
    // `uv` arrives as the group's own parameter, not as a call or a constant.
    expect(warp).toContain('Noise_noise(uv,')
  })

  it('declares an exposed parameter as a uniform and reads it by name', () => {
    const { source, uniforms } = compileGraph(example())
    expect(uniforms).toEqual([{ name: 'warp_scale', type: 'float' }])
    expect(source.startsWith('uniform float warp_scale;')).toBe(true)
    expect(source).toContain('Noise_noise(uv, warp_scale)')
  })

  it('inlines an unwired parameter as a constant', () => {
    const { source } = compileGraph(example())
    expect(source).toContain('0.5)') // Mix's `t`
  })

  it('returns half4 from main whatever the last node produced', () => {
    const { source } = compileGraph(example())
    expect(source).toContain('half4 main(float2 uv)')
    expect(source).toContain('return half4(v_Tint_tint, 1.0);')
  })

  it('falls back to a neutral shader rather than emitting nothing', () => {
    const g = example()
    g.nodes.tint = { ...g.nodes.tint, body: undefined }
    const { source, error } = compileGraph(g)
    expect(error).toBeDefined()
    expect(source).toContain('half4 main(')
  })

  it('pulls in only the helpers and engine uniforms the bodies mention', () => {
    // Material(p) → Normalize → Noise → result. Noise calls _vnoise, which calls
    // _hash21; Normalize reads u_resolution. Nothing here touches u_phase.
    const nodes = [
      node({ id: 'r', name: 'Material', returns: 'vec4', params: [{ name: 'p', type: 'vec2' }] }),
      instantiate(TEMPLATE_BY_KIND.normalize, 'norm', 'r', 'a', { x: 0, y: 0 }),
      instantiate(TEMPLATE_BY_KIND.noise, 'noi', 'r', 'b', { x: 0, y: 0 }),
    ]
    const edges = [
      edge(['r', 'p'], ['norm', 'p']),
      edge(['norm', OUT], ['noi', 'uv']),
      edge(['noi', OUT], ['r', OUT]),
    ]
    const { source, error } = compileGraph(graphOf(nodes, edges))

    expect(error).toBeUndefined()
    expect(source).toContain('uniform float2 u_resolution;')
    expect(source).not.toContain('u_phase')
    // The dependency is emitted before the helper that calls it.
    expect(source.indexOf('float _hash21(')).toBeLessThan(source.indexOf('float _vnoise('))
    // And before any function that uses it.
    expect(source.indexOf('float _vnoise(')).toBeLessThan(source.indexOf('half4 main('))
  })

  it('declares no helpers when nothing references them', () => {
    const { source } = compileGraph(example())
    expect(source).not.toContain('_hash21')
    expect(source).not.toContain('u_resolution')
  })

  it('instantiates a template with its defaults as unwired constants', () => {
    const n = instantiate(TEMPLATE_BY_KIND.mix, 'm', 'r', 'a', { x: 4, y: 5 })
    expect(n.returns).toBe('color')
    expect(n.values.t).toEqual({ value: 0.5 })
    expect(n.body).toContain('mix(a, b, t)')
    expect(n.position).toEqual({ x: 4, y: 5 })
  })

  it('handles a shader that is one hand-written node', () => {
    const only = node({
      id: 'r',
      name: 'Material',
      returns: 'vec4',
      params: [{ name: 'uv', type: 'vec2' }],
      body: 'return half4(uv, 0.0, 1.0);',
    })
    const { source, error } = compileGraph(graphOf([only], []))
    expect(error).toBeUndefined()
    expect(source).toContain('half4 main(float2 uv)')
    expect(source).toContain('return half4(uv, 0.0, 1.0);')
  })
})
