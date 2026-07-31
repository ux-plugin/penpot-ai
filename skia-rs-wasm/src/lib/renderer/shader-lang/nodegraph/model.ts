/**
 * The shader node model — one node type, nested.
 *
 * A shader is a tree of function nodes wired by edges. There is no taxonomy of
 * node kinds: a node is a function. What varies is whether it carries a body or
 * contains other nodes, and that is the only structural distinction in the whole
 * model.
 *
 * - A **leaf** has `body`, the statements of its function. Its signature is data
 *   (`returns` + `params`), generated at compile time, so renaming a parameter
 *   never means rewriting text.
 * - A **group** has children instead. Its body is generated from how those
 *   children are wired, which is precisely "a function that calls the functions
 *   inside it". Expanding a group in the editor is a view, not a second model.
 *
 * `parentId` therefore does two jobs at once: it is the tree the left panel
 * renders, and it is the call structure the compiler walks. Because containment
 * is a tree, recursion cannot be expressed, so codegen needs no cycle detection
 * across levels — only among siblings.
 *
 * ## The boundary is an ordinary edge
 *
 * A group's ports are reached with the same `Edge` as everything else. An edge
 * whose *source* is the group means "this group's parameter"; one whose *target*
 * is the group means "this is the group's result". That keeps one node type —
 * no input-proxy or output nodes — and it is what lets a group compile as a
 * standalone function, which is what makes it reusable.
 *
 * ## Parameters carry two independent flags
 *
 * `exposed` puts a parameter on the material's public interface: it becomes a
 * uniform, it appears outside the stage, and a design token binds to it. It
 * carries its own uniform name, generated once, so renaming a node does not
 * silently rename a uniform and break whatever referenced it.
 *
 * `pinned` only means "show this inline on the node card". The two look alike
 * and are unrelated: you pin a value you are tweaking constantly without
 * exposing it, and expose a knob you never touch while authoring.
 */

/** Value types carried by ports. `color` is a `half3`; `shader` is a child shader. */
export type PortType = 'float' | 'vec2' | 'vec3' | 'vec4' | 'color' | 'shader'

export type ParamValue = number | readonly number[]

/** The port name of any node's result. A group uses its param names as sources. */
export const OUT = 'out'

export interface Param {
  name: string
  type: PortType
}

/** Per-parameter state: its constant, whether it is public, whether it is pinned. */
export interface ParamState {
  /** Used when the parameter is unwired and not exposed. */
  value?: ParamValue
  /**
   * Present when this parameter is a material uniform. `uniform` is generated
   * once at exposure and never derived from the node's name, so renaming the
   * node leaves the public interface alone.
   */
  exposed?: { uniform: string }
  /** Render this inline on the node card as well as in the panel. */
  pinned?: boolean
  /** Design token bound to this parameter; `value` is materialized from it. */
  token?: string
}

export interface ShaderNode {
  id: string
  /** What the left panel shows. Not an identifier — the id is. */
  name: string
  /** Undefined for the root. Doubles as the call structure. */
  parentId: string | undefined
  /** Sibling order — an opaque ordered key, like a shape's. */
  pos: string
  /** Position on the graph canvas. Ignored by codegen. */
  position: { x: number; y: number }
  returns: PortType
  params: Param[]
  /** Leaf only: function statements. Mutually exclusive with having children. */
  body?: string
  values: Record<string, ParamState>
}

export interface Edge {
  id: string
  /** `port` is {@link OUT} for a node's result, or a param name when the source is the enclosing group. */
  from: { node: string; port: string }
  /** `port` is a param name, or {@link OUT} when the target is the enclosing group. */
  to: { node: string; port: string }
}

export interface ShaderGraph {
  root: string
  nodes: Record<string, ShaderNode>
  edges: Record<string, Edge>
}

// ------------------------------------------------------------------ queries

/** Children of `id`, in sibling order. */
export function childrenOf(graph: ShaderGraph, id: string): ShaderNode[] {
  return Object.values(graph.nodes)
    .filter((n) => n.parentId === id)
    .sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0))
}

export function isGroup(graph: ShaderGraph, id: string): boolean {
  return Object.values(graph.nodes).some((n) => n.parentId === id)
}

/** Edges wired inside `parentId` — between its children, or across its boundary. */
export function edgesWithin(graph: ShaderGraph, parentId: string): Edge[] {
  const inside = new Set(childrenOf(graph, parentId).map((n) => n.id))
  return Object.values(graph.edges).filter((e) => {
    const fromOk = inside.has(e.from.node) || e.from.node === parentId
    const toOk = inside.has(e.to.node) || e.to.node === parentId
    return fromOk && toOk
  })
}

/** The edge feeding `node`'s parameter `param`, if any. */
export function incoming(graph: ShaderGraph, node: string, param: string): Edge | undefined {
  return Object.values(graph.edges).find((e) => e.to.node === node && e.to.port === param)
}

// --------------------------------------------------------------- invariants

/**
 * Structural problems, as plain sentences. Empty means the graph is sound.
 *
 * These are checked rather than assumed because each one has a failure that is
 * silent otherwise: a node with both a body and children compiles ambiguously,
 * an edge crossing a boundary makes a group non-extractable, and a cycle among
 * siblings makes codegen non-terminating.
 */
export function validate(graph: ShaderGraph): string[] {
  const problems: string[] = []
  const nodes = Object.values(graph.nodes)

  if (graph.nodes[graph.root] === undefined) problems.push(`root ${graph.root} is not a node`)

  for (const n of nodes) {
    if (n.id === graph.root) {
      if (n.parentId !== undefined) problems.push(`root ${n.id} must have no parent`)
    } else if (n.parentId === undefined || graph.nodes[n.parentId] === undefined) {
      problems.push(`${n.name} has no parent`)
    }
    if (n.body !== undefined && isGroup(graph, n.id)) {
      problems.push(`${n.name} has both a body and children`)
    }
    if (n.body === undefined && !isGroup(graph, n.id)) {
      problems.push(`${n.name} has neither a body nor children`)
    }
  }

  for (const e of Object.values(graph.edges)) {
    const from = graph.nodes[e.from.node]
    const to = graph.nodes[e.to.node]
    if (!from || !to) {
      problems.push(`edge ${e.id} references a missing node`)
      continue
    }
    // Legal only between siblings, or between a group and one of its children.
    const sameParent = from.parentId === to.parentId
    const intoGroup = e.from.node === to.parentId
    const outOfGroup = e.to.node === from.parentId
    if (!sameParent && !intoGroup && !outOfGroup) {
      problems.push(`edge ${e.id} crosses a group boundary`)
    }
  }

  for (const n of nodes) {
    if (isGroup(graph, n.id) && hasCycle(graph, n.id)) {
      problems.push(`${n.name} contains a cycle`)
    }
  }
  return problems
}

/** Depth-first cycle check among one group's children. */
function hasCycle(graph: ShaderGraph, parentId: string): boolean {
  const kids = childrenOf(graph, parentId).map((n) => n.id)
  const deps = new Map<string, string[]>()
  for (const id of kids) {
    deps.set(
      id,
      Object.values(graph.edges)
        .filter((e) => e.to.node === id && e.from.node !== parentId)
        .map((e) => e.from.node),
    )
  }
  const state = new Map<string, 0 | 1 | 2>()
  const walk = (id: string): boolean => {
    const s = state.get(id)
    if (s === 1) return true
    if (s === 2) return false
    state.set(id, 1)
    for (const d of deps.get(id) ?? []) if (walk(d)) return true
    state.set(id, 2)
    return false
  }
  return kids.some((id) => walk(id))
}
