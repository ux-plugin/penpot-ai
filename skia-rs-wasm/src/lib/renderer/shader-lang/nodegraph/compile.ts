/**
 * Codegen for the nested node model: every node becomes a function, and a group
 * becomes the function that calls the functions inside it.
 *
 * The walk is post-order over the containment tree. Children are emitted before
 * the group that wires them, so by the time a group's body is written every
 * function it calls already exists. Containment is a tree, so recursion is
 * unrepresentable and no cycle detection is needed *across* levels — only among
 * siblings, which {@link validate} checks.
 *
 * Like the older graph compiler, this never throws and never returns unusable
 * source: a malformed graph yields a neutral shader plus an `error`, so the
 * editor's preview degrades instead of going blank while you are mid-edit.
 */

import {
  OUT,
  childrenOf,
  incoming,
  isGroup,
  validate,
  type ParamValue,
  type PortType,
  type ShaderGraph,
  type ShaderNode,
} from './model'

export interface CompileResult {
  /** Always compilable. A neutral fallback when `error` is set. */
  source: string
  /** Uniform names emitted, in declaration order — what the rail binds to. */
  uniforms: { name: string; type: PortType }[]
  error?: string
}

const FALLBACK = 'half4 main(float2 uv) {\n  return half4(0.0, 0.0, 0.0, 1.0);\n}'

const SKSL_TYPE: Record<PortType, string> = {
  float: 'float',
  vec2: 'float2',
  vec3: 'float3',
  vec4: 'float4',
  color: 'half3',
  shader: 'shader',
}

/** A neutral value per type, for an input that is neither wired nor set. */
const ZERO: Record<PortType, string> = {
  float: '0.0',
  vec2: 'float2(0.0)',
  vec3: 'float3(0.0)',
  vec4: 'float4(0.0)',
  color: 'half3(0.0)',
  shader: 'shader(0)',
}

/** Identifier-safe, stable, and unique: the node's name plus a slice of its id. */
function fnName(node: ShaderNode): string {
  const base = node.name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^([0-9])/, '_$1') || 'node'
  return `${base}_${node.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 6)}`
}

function literal(type: PortType, value: ParamValue | undefined): string {
  if (value === undefined) return ZERO[type]
  if (typeof value === 'number') return type === 'float' ? fixed(value) : `${SKSL_TYPE[type]}(${fixed(value)})`
  const parts = value.map(fixed).join(', ')
  return type === 'float' ? (parts.split(',')[0] ?? '0.0') : `${SKSL_TYPE[type]}(${parts})`
}

/** SkSL rejects a bare integer where a float is wanted, so always emit a point. */
function fixed(n: number): string {
  return Number.isFinite(n) ? (Number.isInteger(n) ? `${n}.0` : String(n)) : '0.0'
}

/** Children ordered so each comes after everything it consumes. */
function topological(graph: ShaderGraph, parentId: string): ShaderNode[] {
  const kids = childrenOf(graph, parentId)
  const byId = new Map(kids.map((n) => [n.id, n]))
  const out: ShaderNode[] = []
  const done = new Set<string>()

  const visit = (node: ShaderNode): void => {
    if (done.has(node.id)) return
    done.add(node.id) // marked first: a cycle degrades to an order, never a hang
    for (const p of node.params) {
      const edge = incoming(graph, node.id, p.name)
      const upstream = edge && edge.from.node !== parentId ? byId.get(edge.from.node) : undefined
      if (upstream) visit(upstream)
    }
    out.push(node)
  }
  for (const k of kids) visit(k)
  return out
}

/** Every exposed parameter across the graph, deduplicated by uniform name. */
function uniformsOf(graph: ShaderGraph): { name: string; type: PortType }[] {
  const seen = new Map<string, PortType>()
  for (const node of Object.values(graph.nodes)) {
    for (const p of node.params) {
      const exposed = node.values[p.name]?.exposed
      if (exposed && !seen.has(exposed.uniform)) seen.set(exposed.uniform, p.type)
    }
  }
  return [...seen].map(([name, type]) => ({ name, type }))
}

/**
 * Emit `node` and everything beneath it. Returns the function declarations in
 * dependency order — children first, so a group's body can call them.
 */
function emit(graph: ShaderGraph, node: ShaderNode, isRoot: boolean): string[] {
  const out: string[] = []
  const group = isGroup(graph, node.id)

  if (group) for (const child of childrenOf(graph, node.id)) out.push(...emit(graph, child, false))

  const params = node.params.map((p) => `${SKSL_TYPE[p.type]} ${p.name}`).join(', ')
  const header = isRoot
    ? `half4 main(float2 ${node.params[0]?.name ?? 'uv'})`
    : `${SKSL_TYPE[node.returns]} ${fnName(node)}(${params})`

  out.push(`${header} {\n${group ? groupBody(graph, node, isRoot) : indent(node.body ?? '')}\n}`)
  return out
}

/** A group's body: call each child in order, then return what feeds its result. */
function groupBody(graph: ShaderGraph, group: ShaderNode, isRoot: boolean): string {
  const lines: string[] = []
  const vars = new Map<string, string>()

  for (const child of topological(graph, group.id)) {
    const args = child.params.map((p) => resolve(graph, group, child, p.name, p.type, vars))
    const v = `v_${fnName(child)}`
    vars.set(child.id, v)
    lines.push(`  ${SKSL_TYPE[child.returns]} ${v} = ${fnName(child)}(${args.join(', ')});`)
  }

  // What leaves the group: the edge wired to its own result port.
  const result = Object.values(graph.edges).find(
    (e) => e.to.node === group.id && e.to.port === OUT,
  )
  const value = result ? (vars.get(result.from.node) ?? ZERO[group.returns]) : ZERO[group.returns]
  lines.push(`  return ${isRoot ? wrapAsColor(graph, result?.from.node, value) : value};`)
  return lines.join('\n')
}

/** `main` must return half4 whatever the last node produced. */
function wrapAsColor(graph: ShaderGraph, sourceId: string | undefined, value: string): string {
  const type = sourceId ? graph.nodes[sourceId]?.returns : undefined
  if (type === 'vec4') return `half4(${value})`
  if (type === 'color' || type === 'vec3') return `half4(${value}, 1.0)`
  if (type === 'float') return `half4(half3(${value}), 1.0)`
  return type === undefined ? 'half4(0.0, 0.0, 0.0, 1.0)' : `half4(${value})`
}

/** One argument: a wired upstream call, the group's own parameter, a uniform, or a constant. */
function resolve(
  graph: ShaderGraph,
  group: ShaderNode,
  child: ShaderNode,
  param: string,
  type: PortType,
  vars: Map<string, string>,
): string {
  const edge = incoming(graph, child.id, param)
  if (edge) {
    // Sourced from the enclosing group means "this group's parameter".
    if (edge.from.node === group.id) return edge.from.port
    const v = vars.get(edge.from.node)
    if (v) return v
  }
  const state = child.values[param]
  if (state?.exposed) return state.exposed.uniform
  return literal(type, state?.value)
}

function indent(body: string): string {
  return body
    .split('\n')
    .map((l) => (l.trim().length === 0 ? l : `  ${l}`))
    .join('\n')
}

export function compileGraph(graph: ShaderGraph): CompileResult {
  const problems = validate(graph)
  if (problems.length > 0) {
    return { source: FALLBACK, uniforms: [], error: problems.join('; ') }
  }

  const root = graph.nodes[graph.root]
  const uniforms = uniformsOf(graph)
  const decls = uniforms.map((u) => `uniform ${SKSL_TYPE[u.type]} ${u.name};`)
  const fns = emit(graph, root, true)

  return {
    source: [...decls, ...(decls.length > 0 ? [''] : []), ...fns].join('\n'),
    uniforms,
  }
}
