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

/**
 * Uniforms the engine provides. A body that mentions one gets the declaration;
 * a body that does not, does not — so the compiled source only ever declares
 * what the graph actually uses.
 */
const ENGINE_UNIFORMS: Record<string, PortType> = {
  u_resolution: 'vec2',
  u_phase: 'float',
}

/** Shared functions emitted once at file scope, with their own dependencies. */
const HELPER_SOURCE: Record<string, string> = {
  _hash21: `float _hash21(float2 p) {
  float2 q = fract(p * float2(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}`,
  _vnoise: `float _vnoise(float2 p) {
  float2 i = floor(p);
  float2 fr = fract(p);
  float a = _hash21(i);
  float b = _hash21(i + float2(1.0, 0.0));
  float c = _hash21(i + float2(0.0, 1.0));
  float d = _hash21(i + float2(1.0, 1.0));
  float2 u = fr * fr * (3.0 - 2.0 * fr);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) + (d - d);
}`,
}

const HELPER_DEPS: Record<string, string[]> = {
  _hash21: [],
  _vnoise: ['_hash21'],
}

/**
 * What the emitted source references, found by scanning it.
 *
 * Deliberately a scan rather than metadata declared on each node. A node you
 * wrote yourself is the normal case here, and requiring it to also declare
 * "this body uses `u_phase`" is bookkeeping that will be forgotten — the symptom
 * being a shader that fails to compile for a reason the author cannot see. The
 * scan cannot be forgotten.
 */
function referenced(source: string, names: string[]): string[] {
  return names.filter((n) => new RegExp(`\\b${n}\\b`).test(source))
}

/** Helpers used, plus what those helpers need, in declaration order. */
function helpersFor(source: string): string[] {
  const out: string[] = []
  const add = (name: string): void => {
    if (out.includes(name)) return
    for (const dep of HELPER_DEPS[name] ?? []) add(dep)
    out.push(name)
  }
  for (const name of referenced(source, Object.keys(HELPER_SOURCE))) add(name)
  return out
}

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
  const raw = result ? (vars.get(result.from.node) ?? ZERO[group.returns]) : ZERO[group.returns]
  // A group declares its own return type, so what leaves it is converted too —
  // wiring a float node to a group that returns color has to widen, exactly as
  // it would across any other wire.
  const from = result ? graph.nodes[result.from.node]?.returns : undefined
  const value = from ? coerce(raw, from, group.returns) : raw
  lines.push(`  return ${isRoot ? wrapAsColor(graph, result?.from.node, raw) : value};`)
  return lines.join('\n')
}

/**
 * `main` must return half4 whatever the last node produced, so every type gets
 * padded to four components explicitly.
 *
 * Every case is spelled out rather than falling through to `half4(value)`,
 * because that only happens to be right for vec4 — a `vec2` result produced
 * `half4(float2)` and SkSL rejected it for having two scalars where it wanted
 * four. An unknown type returns opaque black rather than something unparseable.
 */
const AS_COLOR: Partial<Record<PortType, (v: string) => string>> = {
  vec4: (v) => `half4(${v})`,
  vec3: (v) => `half4(${v}, 1.0)`,
  color: (v) => `half4(${v}, 1.0)`,
  vec2: (v) => `half4(${v}, 0.0, 1.0)`,
  float: (v) => `half4(half3(${v}), 1.0)`,
}

function wrapAsColor(graph: ShaderGraph, sourceId: string | undefined, value: string): string {
  const type = sourceId ? graph.nodes[sourceId]?.returns : undefined
  const wrap = type ? AS_COLOR[type] : undefined
  return wrap ? wrap(value) : 'half4(0.0, 0.0, 0.0, 1.0)'
}

/** Component count per type, for widening and narrowing across a wire. */
const WIDTH: Record<PortType, number> = {
  float: 1,
  vec2: 2,
  vec3: 3,
  color: 3,
  vec4: 4,
  shader: 0,
}

/**
 * Convert `expr` from one port type to another.
 *
 * Wires between mismatched types are normal in a node editor — dropping a noise
 * scalar onto a colour input is a thing people do on purpose — so the compiler
 * adapts rather than refusing. Without this a mismatched wire emits SkSL that
 * fails to compile, which was a regression against the older graph compiler
 * that the type-per-port model made easy to overlook.
 *
 * Narrowing takes the leading components; widening splats a scalar and pads
 * anything else with zero.
 */
function coerce(expr: string, from: PortType, to: PortType): string {
  if (from === to) return expr
  if (from === 'shader' || to === 'shader') return expr // nothing sensible to do
  const [a, b] = [WIDTH[from], WIDTH[to]]

  if (a === b) return b === 1 ? expr : `${SKSL_TYPE[to]}(${expr})` // color ↔ vec3
  if (b === 1) return from === 'color' ? `dot(${expr}, half3(0.2126, 0.7152, 0.0722))` : `(${expr}).x`
  if (a === 1) return `${SKSL_TYPE[to]}(${expr})` // splat
  if (a > b) return `(${expr}).${'xyzw'.slice(0, b)}`
  return `${SKSL_TYPE[to]}(${expr}${', 0.0'.repeat(b - a - 1)}, ${to === 'vec4' ? '1.0' : '0.0'})`
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
    if (edge.from.node === group.id) {
      const from = group.params.find((p) => p.name === edge.from.port)?.type
      return from ? coerce(edge.from.port, from, type) : edge.from.port
    }
    const v = vars.get(edge.from.node)
    if (v) return coerce(v, graph.nodes[edge.from.node]?.returns ?? type, type)
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
  const fns = emit(graph, root, true)
  const body = fns.join('\n')

  // Engine uniforms come from scanning what the bodies mention; exposed ones are
  // declared by the graph. Both are emitted before any function that reads them.
  const engine = referenced(body, Object.keys(ENGINE_UNIFORMS)).map(
    (n) => `uniform ${SKSL_TYPE[ENGINE_UNIFORMS[n]]} ${n};`,
  )
  const declared = uniforms.map((u) => `uniform ${SKSL_TYPE[u.type]} ${u.name};`)
  const helpers = helpersFor(body).map((n) => HELPER_SOURCE[n])

  const sections = [
    [...engine, ...declared].join('\n'),
    helpers.join('\n'),
    body,
  ].filter((s) => s.length > 0)

  return { source: sections.join('\n\n'), uniforms }
}
