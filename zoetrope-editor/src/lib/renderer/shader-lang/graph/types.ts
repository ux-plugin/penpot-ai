/**
 * ShaderGraph — the node-graph authoring model for shader materials. A graph is a
 * set of nodes (generators, math, color, output) wired by edges; it COMPILES to a
 * single SkSL `main()` (see `compile.ts`) that drops straight into
 * `Material.source`, so the renderer pipeline is unchanged — the graph is purely an
 * authoring representation. Deliberately UI-agnostic (no React Flow types): React
 * Flow is a thin view over this IR today, and a custom canvas can replace it later
 * without touching the model or codegen.
 */

/** The value types that flow along ports. `color` is a `half3` in SkSL. */
export type PortType = 'float' | 'vec2' | 'color'

/** A constant value carried by a node param (and inlined when an input is unwired). */
export type ParamValue =
  | number
  | readonly [number, number]
  | readonly [number, number, number]

export interface GraphNode {
  id: string
  /** Registry key (see `NODE_SPECS`): 'uv' | 'gradient' | 'mix' | 'output' | … */
  kind: string
  /** Editor position (ignored by codegen). */
  position: { x: number; y: number }
  /** Constant params, keyed by name. An input port with a same-named param uses it when unwired. */
  params?: Record<string, ParamValue>
}

export interface Edge {
  id: string
  /** Upstream output port. */
  from: { node: string; port: string }
  /** Downstream input port. */
  to: { node: string; port: string }
}

export interface ShaderGraph {
  nodes: GraphNode[]
  edges: Edge[]
}
