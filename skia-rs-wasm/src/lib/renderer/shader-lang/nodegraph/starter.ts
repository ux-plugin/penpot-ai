/**
 * The graph you get when you start authoring visually: Normalize → Gradient,
 * inside a Material root.
 *
 * Small enough to read at a glance and already renders something, so the first
 * thing an author sees is a working preview to pull apart — the same "fork me"
 * philosophy as the code presets.
 *
 * The shape is worth noticing: there is no `uv` node and no `output` node. The
 * root's parameter *is* the coordinate, and the edge into the root's result port
 * *is* the output. Both used to be nodes whose only job was to mark a boundary
 * the model now expresses directly.
 */

import { OUT, type Edge, type ShaderGraph, type ShaderNode } from './model'
import { TEMPLATE_BY_KIND, instantiate } from './palette'

export const STARTER_ROOT = 'root'

export function starterGraph(): ShaderGraph {
  const root: ShaderNode = {
    id: STARTER_ROOT,
    name: 'Material',
    parentId: undefined,
    pos: 'a',
    position: { x: 0, y: 0 },
    returns: 'vec4',
    params: [{ name: 'p', type: 'vec2' }],
    values: {},
  }
  const norm = instantiate(TEMPLATE_BY_KIND.normalize, 'n1', STARTER_ROOT, 'a', { x: 40, y: 90 })
  const grad = instantiate(TEMPLATE_BY_KIND.gradient, 'n2', STARTER_ROOT, 'b', { x: 300, y: 40 })

  const edges: Edge[] = [
    { id: 'e1', from: { node: STARTER_ROOT, port: 'p' }, to: { node: 'n1', port: 'p' } },
    { id: 'e2', from: { node: 'n1', port: OUT }, to: { node: 'n2', port: 'uv' } },
    { id: 'e3', from: { node: 'n2', port: OUT }, to: { node: STARTER_ROOT, port: OUT } },
  ]

  return {
    root: STARTER_ROOT,
    nodes: Object.fromEntries([root, norm, grad].map((n) => [n.id, n])),
    edges: Object.fromEntries(edges.map((e) => [e.id, e])),
  }
}
