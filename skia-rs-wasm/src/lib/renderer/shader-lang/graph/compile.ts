/**
 * Shader-graph codegen: a {@link ShaderGraph} compiles to ONE SkSL `half4 main()`.
 *
 * There are no Skia child-shaders involved — the graph is flattened into a single
 * runtime effect, so the compiled string drops straight into `Material.source` and
 * the existing render/preview/thumbnail pipeline is unchanged. "Combining two
 * shaders" is just two generator nodes wired into a `mix` node.
 *
 * Walk: depth-first from the `output` node over its input edges, emitting each
 * node once its dependencies exist (post-order = topological). Each input resolves
 * as edge > same-named param constant > type default, coerced to the port's type,
 * so a partially-wired graph still compiles — the editor never shows a broken
 * preview. Cycles and a missing output fall back to a valid neutral shader plus an
 * `error`, for the same reason.
 */

import {
  HELPER_DEPS,
  HELPER_SOURCE,
  NODE_SPECS,
  OUTPUT_KIND,
  constExpr,
  type EmitContext,
  type EngineUniform,
  type HelperId,
} from './nodes'
import type { Edge, GraphNode, ParamValue, PortType, ShaderGraph } from './types'

export interface GraphCompileResult {
  /** Always a compilable SkSL shader — a neutral fallback when `error` is set. */
  source: string
  /** Set when the graph couldn't be compiled as authored (cycle, no output). */
  error?: string
}

const FALLBACK_SOURCE = `half4 main(float2 p) {
  return half4(0.5, 0.5, 0.5, 1.0);
}`

/** Bridge a value between port types so a partially-typed wiring still compiles. */
function coerce(expr: string, from: PortType, to: PortType): string {
  if (from === to) return expr
  if (to === 'color') {
    // Rec.709 luma splat for a scalar; drop z for a vec2.
    return from === 'float' ? `half3(${expr})` : `half3(${expr}, 0.0)`
  }
  if (to === 'float') {
    return from === 'color' ? `dot(${expr}, half3(0.2126, 0.7152, 0.0722))` : `(${expr}).x`
  }
  // to === 'vec2'
  return from === 'float' ? `float2(${expr})` : `(${expr}).xy`
}

function outputPortType(node: GraphNode | undefined, port: string): PortType | null {
  const spec = node ? NODE_SPECS[node.kind] : undefined
  return spec?.outputs.find((o) => o.name === port)?.type ?? null
}

/** Pull in a helper and everything it calls, preserving dependency order. */
function addHelper(id: HelperId, into: Set<HelperId>): void {
  if (into.has(id)) return
  for (const dep of HELPER_DEPS[id] ?? []) addHelper(dep, into)
  into.add(id)
}

export function compileGraphToSksl(graph: ShaderGraph): GraphCompileResult {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
  const output = graph.nodes.find((n) => n.kind === OUTPUT_KIND)
  if (!output) {
    return { source: FALLBACK_SOURCE, error: 'Graph has no Output node.' }
  }

  // Incoming edge per "<node>:<inputPort>". A port takes at most one wire.
  const incoming = new Map<string, Edge>()
  for (const e of graph.edges) incoming.set(`${e.to.node}:${e.to.port}`, e)

  // Post-order DFS from the output = dependencies before dependents.
  const order: GraphNode[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  let cyclic = false

  const visit = (id: string): void => {
    const s = state.get(id)
    if (s === 'done') return
    if (s === 'visiting') {
      cyclic = true
      return
    }
    const node = nodeById.get(id)
    if (!node) return
    state.set(id, 'visiting')
    for (const port of NODE_SPECS[node.kind]?.inputs ?? []) {
      const edge = incoming.get(`${id}:${port.name}`)
      if (edge && nodeById.has(edge.from.node)) visit(edge.from.node)
    }
    state.set(id, 'done')
    order.push(node)
  }
  visit(output.id)

  if (cyclic) {
    return { source: FALLBACK_SOURCE, error: 'Graph contains a cycle.' }
  }

  const body: string[] = []
  const uniforms = new Set<EngineUniform>()
  const helpers = new Set<HelperId>()
  const outExpr = new Map<string, Record<string, string>>()
  let varSeq = 0

  for (const node of order) {
    const spec = NODE_SPECS[node.kind]
    if (!spec) continue

    const params: Record<string, ParamValue> = {}
    for (const p of spec.params) params[p.name] = node.params?.[p.name] ?? p.default

    const inputs: Record<string, string> = {}
    for (const port of spec.inputs) {
      const edge = incoming.get(`${node.id}:${port.name}`)
      const srcNode = edge ? nodeById.get(edge.from.node) : undefined
      const srcExpr = edge ? outExpr.get(edge.from.node)?.[edge.from.port] : undefined
      if (edge && srcExpr != null) {
        const srcType = outputPortType(srcNode, edge.from.port) ?? port.type
        inputs[port.name] = coerce(srcExpr, srcType, port.type)
      } else {
        // Unwired: the same-named param is the node's inline constant.
        inputs[port.name] = constExpr(port.type, params[port.name])
      }
    }

    const ctx: EmitContext = {
      inputs,
      params,
      freshVar: () => `v${varSeq++}`,
      useUniform: (n) => uniforms.add(n),
      useHelper: (id) => addHelper(id, helpers),
      emit: (stmt) => body.push(stmt),
    }
    outExpr.set(node.id, spec.build(ctx))
  }

  // Assembled as blank-line-separated blocks — this source is shown to the author
  // in the editor's compiled-SkSL view, so it should read like hand-written code.
  const blocks: string[] = []

  // Declared in a stable order so the generated source is deterministic.
  const uniformLines: string[] = []
  if (uniforms.has('u_resolution')) uniformLines.push('uniform float2 u_resolution;')
  if (uniforms.has('u_phase')) uniformLines.push('uniform float u_phase;')
  if (uniformLines.length > 0) blocks.push(uniformLines.join('\n'))

  // `helpers` is insertion-ordered and deps are added first, so callees precede callers.
  for (const id of helpers) blocks.push(HELPER_SOURCE[id])

  blocks.push(`half4 main(float2 p) {\n${body.map((l) => `  ${l}`).join('\n')}\n}`)

  return { source: blocks.join('\n\n') }
}
