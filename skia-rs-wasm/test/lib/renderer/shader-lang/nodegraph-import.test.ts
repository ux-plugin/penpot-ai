/**
 * Reading existing SkSL into a graph.
 *
 * The claim is that a shader is never *not* a graph, and that converting one
 * loses nothing — compiling what comes back has to reproduce what went in.
 */

import { describe, expect, it } from 'vitest'
import { graphFromSource } from '../../../../src/lib/renderer/shader-lang/nodegraph/import'
import { compileGraph } from '../../../../src/lib/renderer/shader-lang/nodegraph/compile'
import { validate } from '../../../../src/lib/renderer/shader-lang/nodegraph/model'

const SOURCE = `uniform float2 u_resolution;
uniform float u_phase;

const float TAU = 6.2831853;

float wave(float2 uv, float t) {
  return sin(uv.x + t) + sin(uv.y + t);
}

half4 main(float2 p) {
  float2 uv = p / u_resolution * 6.0;
  float t = TAU * u_phase;
  float v = 0.5 + 0.25 * wave(uv, t);
  half3 col = half3(v, v, v);
  return half4(col, 1.0);
}`

describe('graphFromSource', () => {
  it('produces a valid one-node graph', () => {
    const g = graphFromSource(SOURCE)
    expect(validate(g)).toEqual([])
    expect(Object.keys(g.nodes)).toHaveLength(1)
    expect(g.nodes[g.root].body).toContain('float2 uv = p / u_resolution')
  })

  it("names the root's parameter after main's own", () => {
    expect(graphFromSource(SOURCE).nodes.root.params[0].name).toBe('p')
  })

  it('keeps everything that is not main in the preamble', () => {
    const { preamble } = graphFromSource(SOURCE)
    expect(preamble).toContain('const float TAU')
    expect(preamble).toContain('float wave(float2 uv, float t)')
    expect(preamble).not.toContain('half4 main')
  })

  it('round-trips: compiling the graph reproduces the shader', () => {
    const { source, error } = compileGraph(graphFromSource(SOURCE))
    expect(error).toBeUndefined()
    expect(source).toContain('const float TAU = 6.2831853;')
    expect(source).toContain('float wave(float2 uv, float t)')
    expect(source).toContain('half4 main(float2 p)')
    expect(source).toContain('float v = 0.5 + 0.25 * wave(uv, t);')
    // Declared once, not duplicated between preamble and the engine scan.
    expect(source.match(/uniform float2 u_resolution;/g)).toHaveLength(1)
  })

  it('is not confused by a brace inside a comment', () => {
    const tricky = `half4 main(float2 p) {\n  // a stray { brace\n  return half4(1.0);\n}`
    const g = graphFromSource(tricky)
    expect(g.nodes[g.root].body).toContain('return half4(1.0);')
    expect(g.preamble).toBe('')
  })

  it('still yields an editable graph when there is no main at all', () => {
    const g = graphFromSource('float lonely(float x) { return x; }')
    expect(validate(g)).toEqual([])
    expect(g.preamble).toContain('float lonely')
    expect(compileGraph(g).error).toBeUndefined()
  })
})
