/**
 * Shader node graph — authoring model + codegen. The graph compiles to a single
 * SkSL `main()` that feeds `Material.source`; see `compile.ts` for the walk.
 */

export type { Edge, GraphNode, ParamValue, PortType, ShaderGraph } from './types'
export type {
  EmitContext,
  EngineUniform,
  HelperId,
  NodeSpec,
  ParamSpec,
  PortSpec,
} from './nodes'
export { NODE_PALETTE, NODE_SPECS, OUTPUT_KIND } from './nodes'
export { compileGraphToSksl, type GraphCompileResult } from './compile'
