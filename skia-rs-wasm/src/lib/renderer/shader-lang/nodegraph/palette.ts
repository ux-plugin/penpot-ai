/**
 * The built-in nodes you can drop on the canvas.
 *
 * These are not a special kind of thing. A template is just the data needed to
 * make an ordinary node — a signature and a body — so a built-in and something
 * you wrote by hand are indistinguishable once placed, and you can open any of
 * them and edit the code.
 *
 * Four of the old registry's ten kinds are gone, absorbed by the model rather
 * than ported:
 *
 * - `uv` became {@link normalize}, an ordinary node, because main's parameter is
 *   the raw coordinate and normalizing is just a function of it.
 * - `constFloat` and `constColor` were nodes that emitted their own parameter.
 *   An unwired parameter already does that.
 * - `output` designated the terminal. An edge into the root's result port says
 *   the same thing without a node whose only job is to exist.
 *
 * One deliberate regression: `gradient` used to fold its angle's cos/sin at
 * codegen time, since the angle was always a constant. A body is fixed text now,
 * so the trig happens at runtime. That is a few instructions per pixel in
 * exchange for bodies that are readable, editable, and identical whether the
 * node came from here or from you.
 */

import type { Param, PortType, ShaderNode } from './model'

export interface NodeTemplate {
  kind: string
  title: string
  returns: PortType
  params: Param[]
  /** Defaults for unwired parameters. */
  defaults?: Record<string, number | readonly number[]>
  body: string
}

const TEMPLATES: NodeTemplate[] = [
  {
    kind: 'normalize',
    title: 'Normalize',
    returns: 'vec2',
    params: [{ name: 'p', type: 'vec2' }],
    body: 'return p / u_resolution;',
  },
  {
    kind: 'time',
    title: 'Time',
    returns: 'float',
    params: [],
    // 0 → 1 over one loop, so previews and thumbnails can sample any frame.
    body: 'return u_phase;',
  },
  {
    kind: 'gradient',
    title: 'Gradient',
    returns: 'color',
    params: [
      { name: 'uv', type: 'vec2' },
      { name: 'colorA', type: 'color' },
      { name: 'colorB', type: 'color' },
      { name: 'angle', type: 'float' },
    ],
    defaults: { uv: [0.5, 0.5], colorA: [0.1, 0.3, 0.9], colorB: [0.9, 0.2, 0.6], angle: 0 },
    body: [
      'float a = angle * 6.28318530718;',
      'float g = clamp(dot(uv - 0.5, float2(cos(a), sin(a))) + 0.5, 0.0, 1.0);',
      'return mix(colorA, colorB, g);',
    ].join('\n'),
  },
  {
    kind: 'noise',
    title: 'Noise',
    returns: 'float',
    params: [
      { name: 'uv', type: 'vec2' },
      { name: 'scale', type: 'float' },
    ],
    defaults: { uv: [0.5, 0.5], scale: 4 },
    body: 'return _vnoise(uv * scale);',
  },
  {
    kind: 'checker',
    title: 'Checker',
    returns: 'color',
    params: [
      { name: 'uv', type: 'vec2' },
      { name: 'colorA', type: 'color' },
      { name: 'colorB', type: 'color' },
      { name: 'scale', type: 'float' },
    ],
    defaults: { uv: [0.5, 0.5], colorA: [1, 1, 1], colorB: [0, 0, 0], scale: 8 },
    body: [
      'float2 c = floor(uv * scale);',
      'float k = mod(c.x + c.y, 2.0);',
      'return mix(colorA, colorB, k);',
    ].join('\n'),
  },
  {
    kind: 'mix',
    title: 'Mix',
    returns: 'color',
    params: [
      { name: 'a', type: 'color' },
      { name: 'b', type: 'color' },
      { name: 't', type: 'float' },
    ],
    defaults: { a: [0, 0, 0], b: [1, 1, 1], t: 0.5 },
    // The combiner: this is how two generators become one shader.
    body: 'return mix(a, b, t);',
  },
  {
    kind: 'multiply',
    title: 'Multiply',
    returns: 'color',
    params: [
      { name: 'a', type: 'color' },
      { name: 'b', type: 'color' },
    ],
    defaults: { a: [1, 1, 1], b: [1, 1, 1] },
    body: 'return a * b;',
  },
]

export const NODE_TEMPLATES: ReadonlyArray<NodeTemplate> = TEMPLATES

export const TEMPLATE_BY_KIND: Record<string, NodeTemplate> = Object.fromEntries(
  TEMPLATES.map((t) => [t.kind, t]),
)

/** Instantiate a template as a real node under `parentId`. */
export function instantiate(
  template: NodeTemplate,
  id: string,
  parentId: string,
  pos: string,
  position: { x: number; y: number },
): ShaderNode {
  return {
    id,
    name: template.title,
    parentId,
    pos,
    position,
    returns: template.returns,
    params: template.params.map((p) => ({ ...p })),
    body: template.body,
    values: Object.fromEntries(
      Object.entries(template.defaults ?? {}).map(([k, v]) => [k, { value: v }]),
    ),
  }
}

/** A blank node for "write your own" — the custom case, which is the general one. */
export function blankNode(
  id: string,
  parentId: string,
  pos: string,
  position: { x: number; y: number },
): ShaderNode {
  return {
    id,
    name: 'Function',
    parentId,
    pos,
    position,
    returns: 'color',
    params: [{ name: 'uv', type: 'vec2' }],
    body: 'return half3(uv, 0.0);',
    values: {},
  }
}
