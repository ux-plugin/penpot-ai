/**
 * The graph you get when you start authoring visually: UV → Gradient → Output.
 * Small enough to read at a glance, but already renders something, so the first
 * thing an author sees is a working preview they can pull apart — the same
 * "fork-me" philosophy as the code presets.
 */

import type { ShaderGraph } from './types'

export function starterGraph(): ShaderGraph {
  return {
    nodes: [
      { id: 'n1', kind: 'uv', position: { x: 0, y: 80 } },
      { id: 'n2', kind: 'gradient', position: { x: 210, y: 20 } },
      { id: 'n3', kind: 'output', position: { x: 470, y: 90 } },
    ],
    edges: [
      { id: 'n1.uv->n2.uv', from: { node: 'n1', port: 'uv' }, to: { node: 'n2', port: 'uv' } },
      { id: 'n2.out->n3.color', from: { node: 'n2', port: 'out' }, to: { node: 'n3', port: 'color' } },
    ],
  }
}
