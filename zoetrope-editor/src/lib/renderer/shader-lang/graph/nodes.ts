/**
 * Node registry for the shader graph — the library of things you can drop on the
 * canvas. Each spec declares its ports (what can be wired), its params (constants
 * editable on the node, also used as the fallback when a same-named input port is
 * unwired), and `build()`: the SkSL codegen for that node.
 *
 * `build` returns an SkSL EXPRESSION per output port. Nodes needing intermediate
 * work allocate a temp var (`ctx.freshVar()`) and push statements (`ctx.emit`),
 * then return a reference to it — that keeps the generated `main()` flat and
 * readable. Engine uniforms and shared helper functions are pulled in on demand
 * (`ctx.useUniform` / `ctx.useHelper`) so the compiled source only declares what
 * the graph actually uses.
 */

import type { ParamValue, PortType } from './types'

export interface PortSpec {
  name: string
  type: PortType
  /** Shown in the editor; defaults to `name`. */
  label?: string
}

export interface ParamSpec {
  name: string
  type: PortType
  default: ParamValue
  label?: string
}

/** Engine-provided uniforms a node may pull in. Matches the preset contract. */
export type EngineUniform = 'u_resolution' | 'u_phase'

/** Shared SkSL functions a node may need emitted once at file scope. */
export type HelperId = 'hash21' | 'vnoise'

export interface EmitContext {
  /** Resolved SkSL expression per input port, already coerced to the port's type. */
  inputs: Record<string, string>
  /** This node's param values (defaults applied). */
  params: Record<string, ParamValue>
  freshVar(): string
  useUniform(name: EngineUniform): void
  useHelper(id: HelperId): void
  /** Push a statement into the body of `main()`. */
  emit(statement: string): void
}

export interface NodeSpec {
  kind: string
  title: string
  inputs: PortSpec[]
  outputs: PortSpec[]
  params: ParamSpec[]
  /** SkSL expression per output port name. The `output` node returns `{}`. */
  build(ctx: EmitContext): Record<string, string>
}

/** SkSL float literal — always carries a decimal point so `4` doesn't read as an int. */
export function f(n: number): string {
  if (!Number.isFinite(n)) return '0.0'
  return Number.isInteger(n) ? `${n}.0` : String(n)
}

/** Inline a param constant as an SkSL expression of `type`. */
export function constExpr(type: PortType, value: ParamValue | undefined): string {
  if (type === 'float') {
    return f(typeof value === 'number' ? value : 0)
  }
  if (type === 'vec2') {
    const v = Array.isArray(value) ? value : [0.5, 0.5]
    return `float2(${f(v[0] ?? 0)}, ${f(v[1] ?? 0)})`
  }
  const c = Array.isArray(value) ? value : [0.5, 0.5, 0.5]
  return `half3(${f(c[0] ?? 0)}, ${f(c[1] ?? 0)}, ${f(c[2] ?? 0)})`
}

/** SkSL source for each helper, emitted once when used. */
export const HELPER_SOURCE: Record<HelperId, string> = {
  // Works on a local copy rather than mutating the parameter — every other
  // construct we emit is mirrored by a shipping preset, and this keeps that true.
  hash21: `float _hash21(float2 p) {
  float2 q = fract(p * float2(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}`,
  vnoise: `float _vnoise(float2 p) {
  float2 i = floor(p);
  float2 fr = fract(p);
  float a = _hash21(i);
  float b = _hash21(i + float2(1.0, 0.0));
  float c = _hash21(i + float2(0.0, 1.0));
  float d = _hash21(i + float2(1.0, 1.0));
  float2 u = fr * fr * (3.0 - 2.0 * fr);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}`,
}

/** `vnoise` calls `hash21`, so pulling it in must pull that too. */
export const HELPER_DEPS: Record<HelperId, HelperId[]> = {
  hash21: [],
  vnoise: ['hash21'],
}

const SPECS: NodeSpec[] = [
  {
    kind: 'uv',
    title: 'UV',
    inputs: [],
    outputs: [{ name: 'uv', type: 'vec2' }],
    params: [],
    build(ctx) {
      ctx.useUniform('u_resolution')
      // Normalized 0..1 coordinates — the standard entry point for generators.
      return { uv: '(p / u_resolution)' }
    },
  },
  {
    kind: 'time',
    title: 'Time',
    inputs: [],
    outputs: [{ name: 't', type: 'float' }],
    params: [],
    build(ctx) {
      ctx.useUniform('u_phase')
      // 0 -> 1 over one loop, so previews and thumbnails can sample any frame.
      return { t: 'u_phase' }
    },
  },
  {
    kind: 'constFloat',
    title: 'Value',
    inputs: [],
    outputs: [{ name: 'out', type: 'float' }],
    params: [{ name: 'value', type: 'float', default: 0.5 }],
    build(ctx) {
      return { out: constExpr('float', ctx.params.value) }
    },
  },
  {
    kind: 'constColor',
    title: 'Color',
    inputs: [],
    outputs: [{ name: 'out', type: 'color' }],
    params: [{ name: 'color', type: 'color', default: [0.2, 0.5, 0.9] }],
    build(ctx) {
      return { out: constExpr('color', ctx.params.color) }
    },
  },
  {
    kind: 'gradient',
    title: 'Gradient',
    inputs: [
      { name: 'uv', type: 'vec2' },
      { name: 'colorA', type: 'color' },
      { name: 'colorB', type: 'color' },
    ],
    outputs: [{ name: 'out', type: 'color' }],
    params: [
      { name: 'uv', type: 'vec2', default: [0.5, 0.5] },
      { name: 'colorA', type: 'color', default: [0.1, 0.3, 0.9] },
      { name: 'colorB', type: 'color', default: [0.9, 0.2, 0.6] },
      { name: 'angle', type: 'float', default: 0, label: 'Angle (turns)' },
    ],
    build(ctx) {
      // Angle is a constant param, so fold cos/sin at codegen time.
      const turns = typeof ctx.params.angle === 'number' ? ctx.params.angle : 0
      const rad = turns * Math.PI * 2
      const g = ctx.freshVar()
      ctx.emit(
        `float ${g} = clamp(dot(${ctx.inputs.uv} - 0.5, float2(${f(Math.cos(rad))}, ${f(Math.sin(rad))})) + 0.5, 0.0, 1.0);`,
      )
      return { out: `mix(${ctx.inputs.colorA}, ${ctx.inputs.colorB}, ${g})` }
    },
  },
  {
    kind: 'noise',
    title: 'Noise',
    inputs: [{ name: 'uv', type: 'vec2' }],
    outputs: [{ name: 'out', type: 'float' }],
    params: [
      { name: 'uv', type: 'vec2', default: [0.5, 0.5] },
      { name: 'scale', type: 'float', default: 4 },
    ],
    build(ctx) {
      ctx.useHelper('vnoise')
      const n = ctx.freshVar()
      ctx.emit(`float ${n} = _vnoise(${ctx.inputs.uv} * ${constExpr('float', ctx.params.scale)});`)
      return { out: n }
    },
  },
  {
    kind: 'checker',
    title: 'Checker',
    inputs: [
      { name: 'uv', type: 'vec2' },
      { name: 'colorA', type: 'color' },
      { name: 'colorB', type: 'color' },
    ],
    outputs: [{ name: 'out', type: 'color' }],
    params: [
      { name: 'uv', type: 'vec2', default: [0.5, 0.5] },
      { name: 'colorA', type: 'color', default: [1, 1, 1] },
      { name: 'colorB', type: 'color', default: [0, 0, 0] },
      { name: 'scale', type: 'float', default: 8 },
    ],
    build(ctx) {
      const c = ctx.freshVar()
      ctx.emit(`float2 ${c} = floor(${ctx.inputs.uv} * ${constExpr('float', ctx.params.scale)});`)
      const k = ctx.freshVar()
      ctx.emit(`float ${k} = mod(${c}.x + ${c}.y, 2.0);`)
      return { out: `mix(${ctx.inputs.colorA}, ${ctx.inputs.colorB}, ${k})` }
    },
  },
  {
    kind: 'mix',
    title: 'Mix',
    inputs: [
      { name: 'a', type: 'color' },
      { name: 'b', type: 'color' },
      { name: 't', type: 'float' },
    ],
    outputs: [{ name: 'out', type: 'color' }],
    params: [
      { name: 'a', type: 'color', default: [0, 0, 0] },
      { name: 'b', type: 'color', default: [1, 1, 1] },
      { name: 't', type: 'float', default: 0.5 },
    ],
    build(ctx) {
      // The combiner: this is how two generators become one shader.
      return { out: `mix(${ctx.inputs.a}, ${ctx.inputs.b}, ${ctx.inputs.t})` }
    },
  },
  {
    kind: 'multiply',
    title: 'Multiply',
    inputs: [
      { name: 'a', type: 'color' },
      { name: 'b', type: 'color' },
    ],
    outputs: [{ name: 'out', type: 'color' }],
    params: [
      { name: 'a', type: 'color', default: [1, 1, 1] },
      { name: 'b', type: 'color', default: [1, 1, 1] },
    ],
    build(ctx) {
      return { out: `(${ctx.inputs.a} * ${ctx.inputs.b})` }
    },
  },
  {
    kind: 'output',
    title: 'Output',
    inputs: [{ name: 'color', type: 'color' }],
    outputs: [],
    params: [{ name: 'color', type: 'color', default: [0.5, 0.5, 0.5] }],
    build(ctx) {
      ctx.emit(`return half4(${ctx.inputs.color}, 1.0);`)
      return {}
    },
  },
]

export const NODE_SPECS: Record<string, NodeSpec> = Object.fromEntries(
  SPECS.map((s) => [s.kind, s]),
)

/** The kind every graph must terminate in. */
export const OUTPUT_KIND = 'output'

/** Registry listing for the editor's "add node" palette. */
export const NODE_PALETTE: ReadonlyArray<NodeSpec> = SPECS
