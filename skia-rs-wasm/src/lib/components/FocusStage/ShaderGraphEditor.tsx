/**
 * ShaderGraphEditor — the node canvas over a {@link ShaderGraph}.
 *
 * The model is the single source of truth and no React Flow types reach it or
 * the codegen, so replacing this with our own canvas is a swap of one file.
 *
 * **One level at a time.** A node can contain other nodes, so the canvas shows
 * the children of whichever group you are inside — `viewId`, starting at the
 * root. Double-clicking a group enters it and a breadcrumb walks back out.
 * Rendering every level at once was the alternative; it reads well for two nodes
 * and turns to soup at twenty.
 *
 * **The boundary is drawn, not modelled.** The current group's own parameters
 * appear as an "Inputs" card on the left and its result as an "Output" card on
 * the right. Neither is a node — they are views of the group you are inside, and
 * a wire to one becomes an edge whose endpoint is the group itself. That is what
 * keeps the model at one node type while still giving you something to drag a
 * wire onto.
 *
 * **Transient vs committed state.** React Flow owns the in-flight gesture; the
 * model is updated only at meaningful moments. A node drag costs nothing but
 * React Flow's own render — driving the model per drag frame meant rebuilding
 * the graph, recompiling the SkSL and re-rendering the stage on every mouse
 * move. Positions commit once, on drag stop, flagged `layoutOnly` so they skip
 * codegen entirely. Structural edits go to the model immediately.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge as RFEdge,
  type EdgeChange,
  type Node as RFNode,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ChevronRight, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  OUT,
  childrenOf,
  isGroup,
  type Edge,
  type ParamValue,
  type PortType,
  type ShaderGraph,
  type ShaderNode,
} from '../../renderer/shader-lang/nodegraph/model'
import { ShaderCodeEditor } from '../RightSidePanel/ShaderCodeEditor'
import { skslLanguage } from '../../renderer/shader-lang/sksl'
import {
  NODE_TEMPLATES,
  blankNode,
  instantiate,
  type NodeTemplate,
} from '../../renderer/shader-lang/nodegraph/palette'

/** Synthetic ids for the two boundary cards. Never stored in the model. */
const IN_CARD = '__inputs__'
const OUT_CARD = '__output__'

/** One colour per port type, so a wiring mistake is visible before it compiles. */
const PORT_COLOR: Record<PortType, string> = {
  float: '#9CA3AF',
  vec2: '#38BDF8',
  vec3: '#818CF8',
  vec4: '#A78BFA',
  color: '#F59E0B',
  shader: '#34D399',
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const to255 = (n: number) => Math.round(clamp01(n) * 255)

function rgbToHex(v: ParamValue | undefined): string {
  const c = Array.isArray(v) ? v : [0.5, 0.5, 0.5]
  return `#${[c[0] ?? 0, c[1] ?? 0, c[2] ?? 0].map((n) => to255(n).toString(16).padStart(2, '0')).join('')}`
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex)
  if (!m) return [0.5, 0.5, 0.5]
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255]
}

interface NodeData extends Record<string, unknown> {
  node: ShaderNode
  /** Parameter names already fed by a wire — their inline control is hidden. */
  wired: string[]
  group: boolean
  onParam: (nodeId: string, param: string, value: ParamValue) => void
  onDelete: (nodeId: string) => void
  onEnter: (nodeId: string) => void
}

interface BoundaryData extends Record<string, unknown> {
  kind: 'inputs' | 'output'
  ports: { name: string; type: PortType }[]
}

const NodeView = memo(function NodeView({ data, selected }: NodeProps<RFNode<NodeData>>) {
  const { node, wired, group, onParam, onDelete, onEnter } = data
  const wiredSet = new Set(wired)

  return (
    <div
      className={`min-w-[168px] rounded-lg border bg-background shadow-sm ${
        selected ? 'border-ring ring-1 ring-ring' : 'border-border'
      }`}
      onDoubleClick={group ? () => onEnter(node.id) : undefined}
      title={group ? 'Double-click to open' : undefined}
    >
      <div className="flex items-center justify-between gap-2 rounded-t-lg border-b border-border bg-muted/60 px-2 py-1">
        <span className="flex min-w-0 items-center gap-1 text-[11px] font-medium">
          <span className="truncate">{node.name}</span>
          {group && <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
        </span>
        <button
          type="button"
          className="nodrag rounded p-0.5 text-muted-foreground/70 hover:text-destructive"
          onClick={() => onDelete(node.id)}
          aria-label={`Delete ${node.name}`}
          title="Delete node"
        >
          <Trash2 className="size-3" />
        </button>
      </div>

      <div className="space-y-1 px-2 py-1.5">
        {node.params.map((p) => {
          const state = node.values[p.name]
          const showControl = !wiredSet.has(p.name) && state?.exposed === undefined
          return (
            <div key={p.name} className="relative flex items-center gap-2 py-0.5">
              <Handle
                type="target"
                position={Position.Left}
                id={p.name}
                style={{ background: PORT_COLOR[p.type], width: 8, height: 8, left: -10 }}
              />
              <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                {p.name}
              </span>
              {state?.exposed && (
                <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">
                  {state.exposed.uniform}
                </span>
              )}
              {showControl && (
                <ParamControl
                  type={p.type}
                  value={state?.value}
                  onChange={(v) => onParam(node.id, p.name, v)}
                />
              )}
            </div>
          )
        })}

        <div className="relative flex items-center justify-end py-0.5">
          <span className="truncate text-[10px] text-muted-foreground">{node.returns}</span>
          <Handle
            type="source"
            position={Position.Right}
            id={OUT}
            style={{ background: PORT_COLOR[node.returns], width: 8, height: 8, right: -10 }}
          />
        </div>
      </div>
    </div>
  )
})

/** The group you are inside, drawn as a card so its ports can be wired. */
const BoundaryView = memo(function BoundaryView({ data }: NodeProps<RFNode<BoundaryData>>) {
  const inputs = data.kind === 'inputs'
  return (
    <div className="min-w-[132px] rounded-lg border border-dashed border-border bg-muted/30">
      <div className="border-b border-border px-2 py-1 text-[11px] font-medium text-muted-foreground">
        {inputs ? 'Inputs' : 'Output'}
      </div>
      <div className="space-y-1 px-2 py-1.5">
        {data.ports.map((p) => (
          <div
            key={p.name}
            className={`relative flex items-center py-0.5 ${inputs ? 'justify-end' : ''}`}
          >
            <span className="truncate text-[10px] text-muted-foreground">{p.name}</span>
            <Handle
              type={inputs ? 'source' : 'target'}
              position={inputs ? Position.Right : Position.Left}
              id={p.name}
              style={{
                background: PORT_COLOR[p.type],
                width: 8,
                height: 8,
                [inputs ? 'right' : 'left']: -10,
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
})

function ParamControl({
  type,
  value,
  onChange,
}: {
  type: PortType
  value: ParamValue | undefined
  onChange: (v: ParamValue) => void
}) {
  if (type === 'color' || type === 'vec3') {
    return (
      <input
        type="color"
        className="nodrag h-5 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
        value={rgbToHex(value)}
        onChange={(e) => onChange(hexToRgb(e.target.value))}
      />
    )
  }
  if (type === 'vec2' || type === 'vec4') {
    const n = type === 'vec2' ? 2 : 4
    const v = Array.isArray(value) ? value : Array.from({ length: n }, () => 0)
    return (
      <div className="flex gap-1">
        {Array.from({ length: n }, (_, i) => (
          <input
            key={i}
            type="number"
            step={0.1}
            className="nodrag h-5 w-11 rounded border border-border bg-background px-1 text-[10px]"
            value={v[i] ?? 0}
            onChange={(e) => {
              const next = Array.from({ length: n }, (_, k) => Number(v[k] ?? 0))
              next[i] = Number(e.target.value)
              onChange(next)
            }}
          />
        ))}
      </div>
    )
  }
  if (type === 'shader') return <span className="text-[10px] text-muted-foreground/60">shader</span>
  return (
    <input
      type="number"
      step={0.1}
      className="nodrag h-5 w-14 rounded border border-border bg-background px-1 text-[10px]"
      value={typeof value === 'number' ? value : 0}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}

const nodeTypes = { shaderNode: NodeView, boundary: BoundaryView }

/** First unused `n<k>` id, so ids stay short and stable-looking. */
function newNodeId(graph: ShaderGraph): string {
  for (let i = 1; ; i++) {
    const id = `n${i}`
    if (graph.nodes[id] === undefined) return id
  }
}

/**
 * Turn a leaf into a group so a sibling can be added beside its content.
 *
 * A leaf has a body and no children; adding a node under it would give it both,
 * which the model forbids. So its body moves into a new child (its name kept, or
 * "Main"), wired from the group's inputs through to its output, and the node
 * itself becomes an empty-bodied group. Returns the graph unchanged when `id` is
 * already a group.
 */
function groupifyLeaf(graph: ShaderGraph, id: string): ShaderGraph {
  const leaf = graph.nodes[id]
  if (!leaf || leaf.body === undefined) return graph

  const childId = `${id}_main`
  const child: ShaderNode = {
    ...leaf,
    id: childId,
    name: leaf.id === graph.root ? 'Main' : leaf.name,
    parentId: id,
    pos: 'a',
    position: { x: 220, y: 60 },
  }
  const group: ShaderNode = { ...leaf, body: undefined, values: {} }

  const edges: Record<string, Edge> = { ...graph.edges }
  for (const p of leaf.params) {
    const e: Edge = {
      id: `${id}.${p.name}->${childId}.${p.name}`,
      from: { node: id, port: p.name },
      to: { node: childId, port: p.name },
    }
    edges[e.id] = e
  }
  const out: Edge = {
    id: `${childId}.${OUT}->${id}.${OUT}`,
    from: { node: childId, port: OUT },
    to: { node: id, port: OUT },
  }
  edges[out.id] = out

  return { ...graph, nodes: { ...graph.nodes, [id]: group, [childId]: child }, edges }
}

/** Every node beneath `id`, inclusive — what a delete has to take with it. */
function subtree(graph: ShaderGraph, id: string): Set<string> {
  const out = new Set([id])
  const walk = (parent: string): void => {
    for (const child of childrenOf(graph, parent)) {
      out.add(child.id)
      walk(child.id)
    }
  }
  walk(id)
  return out
}

export interface GraphChangeOptions {
  /** Positions only — the shader is unchanged, so skip codegen. */
  layoutOnly?: boolean
}

export interface ShaderGraphEditorProps {
  graph: ShaderGraph
  onChange: (next: ShaderGraph, opts?: GraphChangeOptions) => void
}

type AnyRFNode = RFNode<NodeData> | RFNode<BoundaryData>

function toRfNodes(
  graph: ShaderGraph,
  viewId: string,
  handlers: Pick<NodeData, 'onParam' | 'onDelete' | 'onEnter'>,
): AnyRFNode[] {
  const view = graph.nodes[viewId]

  // A leaf view (a shader that is a single function — e.g. any imported code)
  // has no children to draw. Show the node itself, flanked by its Inputs and
  // Output cards so the boundary is visible here exactly as it is inside a
  // group: Inputs → node → Output. The params are drawn as wired (fed by the
  // Inputs card), so their meaningless inline controls stay hidden.
  if (view && view.body !== undefined) {
    const nodePos = view.position
    const node: AnyRFNode = {
      id: view.id,
      type: 'shaderNode',
      position: nodePos,
      data: {
        node: view,
        wired: view.params.map((p) => p.name),
        group: false,
        ...handlers,
      },
    }
    const out: AnyRFNode = {
      id: OUT_CARD,
      type: 'boundary',
      position: { x: nodePos.x + 240, y: nodePos.y },
      deletable: false,
      data: { kind: 'output', ports: [{ name: OUT, type: view.returns }] },
    }
    if (view.params.length === 0) return [node, out]
    const inputs: AnyRFNode = {
      id: IN_CARD,
      type: 'boundary',
      position: { x: nodePos.x - 200, y: nodePos.y },
      deletable: false,
      data: { kind: 'inputs', ports: view.params },
    }
    return [inputs, node, out]
  }

  const kids = childrenOf(graph, viewId)
  const xs = kids.map((k) => k.position.x)
  const ys = kids.map((k) => k.position.y)
  const left = (xs.length > 0 ? Math.min(...xs) : 200) - 220
  const right = (xs.length > 0 ? Math.max(...xs) : 200) + 260
  const mid = ys.length > 0 ? Math.min(...ys) : 60

  const boundary: AnyRFNode[] = []
  if (view) {
    if (view.params.length > 0) {
      boundary.push({
        id: IN_CARD,
        type: 'boundary',
        position: { x: left, y: mid },
        deletable: false,
        data: { kind: 'inputs', ports: view.params },
      })
    }
    boundary.push({
      id: OUT_CARD,
      type: 'boundary',
      position: { x: right, y: mid },
      deletable: false,
      data: { kind: 'output', ports: [{ name: OUT, type: view.returns }] },
    })
  }

  const nodes: AnyRFNode[] = kids.map((node) => ({
    id: node.id,
    type: 'shaderNode',
    position: node.position,
    data: {
      node,
      wired: Object.values(graph.edges)
        .filter((e) => e.to.node === node.id)
        .map((e) => e.to.port),
      group: isGroup(graph, node.id),
      ...handlers,
    },
  }))
  return [...boundary, ...nodes]
}

/** Edges visible at this level, with the group's own endpoints mapped to cards. */
function toRfEdges(graph: ShaderGraph, viewId: string): RFEdge[] {
  const view = graph.nodes[viewId]

  // A leaf view has no model edges — its wires to the boundary cards are drawn
  // synthetically, matching the synthetic Inputs/Output cards in toRfNodes. They
  // are not deletable: they are the boundary, not a connection you made.
  if (view && view.body !== undefined) {
    const wires: RFEdge[] = view.params.map((p) => ({
      id: `__b__in.${p.name}`,
      source: IN_CARD,
      sourceHandle: p.name,
      target: view.id,
      targetHandle: p.name,
      deletable: false,
    }))
    wires.push({
      id: '__b__out',
      source: view.id,
      sourceHandle: OUT,
      target: OUT_CARD,
      targetHandle: OUT,
      deletable: false,
    })
    return wires
  }

  const inside = new Set(childrenOf(graph, viewId).map((n) => n.id))
  return Object.values(graph.edges)
    .filter(
      (e) =>
        (inside.has(e.from.node) || e.from.node === viewId) &&
        (inside.has(e.to.node) || e.to.node === viewId),
    )
    .map((e) => ({
      id: e.id,
      source: e.from.node === viewId ? IN_CARD : e.from.node,
      sourceHandle: e.from.port,
      target: e.to.node === viewId ? OUT_CARD : e.to.node,
      targetHandle: e.to.port,
    }))
}

export function ShaderGraphEditor({ graph, onChange }: ShaderGraphEditorProps) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [viewId, setViewId] = useState(graph.root)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showPreamble, setShowPreamble] = useState(false)
  const rfRef = useRef<ReactFlowInstance<AnyRFNode, RFEdge> | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Read the live graph/callback through refs so every handler below can have an
  // EMPTY dep array. That keeps the handlers identity-stable, which is what lets
  // the memoized node view skip re-rendering siblings. Synced in an effect, not
  // during render — handlers only fire after commit, so they observe current
  // values.
  const graphRef = useRef(graph)
  const onChangeRef = useRef(onChange)
  const viewRef = useRef(viewId)
  useEffect(() => {
    graphRef.current = graph
    onChangeRef.current = onChange
    viewRef.current = viewId
  })

  // A deleted group takes its children with it, so the level you are inside can
  // vanish underneath you. Fall back to the root rather than showing nothing.
  useEffect(() => {
    if (graph.nodes[viewId] === undefined) setViewId(graph.root)
  }, [graph, viewId])

  const setParam = useCallback((nodeId: string, param: string, value: ParamValue) => {
    const g = graphRef.current
    const node = g.nodes[nodeId]
    if (!node) return
    onChangeRef.current({
      ...g,
      nodes: {
        ...g.nodes,
        [nodeId]: { ...node, values: { ...node.values, [param]: { ...node.values[param], value } } },
      },
    })
  }, [])

  const deleteNode = useCallback((nodeId: string) => {
    const g = graphRef.current
    const gone = subtree(g, nodeId)
    onChangeRef.current({
      ...g,
      nodes: Object.fromEntries(Object.entries(g.nodes).filter(([id]) => !gone.has(id))),
      edges: Object.fromEntries(
        Object.entries(g.edges).filter(([, e]) => !gone.has(e.from.node) && !gone.has(e.to.node)),
      ),
    })
  }, [])

  const enterGroup = useCallback((nodeId: string) => setViewId(nodeId), [])

  const handlers = useMemo(
    () => ({ onParam: setParam, onDelete: deleteNode, onEnter: enterGroup }),
    [setParam, deleteNode, enterGroup],
  )

  // React Flow owns the in-flight gesture. Seeded from the model and re-seeded
  // whenever it actually changes (our own commits, undo, external edits).
  const [rfNodes, setRfNodes, onNodesChangeInternal] = useNodesState<AnyRFNode>(
    // eslint-disable-next-line react-hooks/refs
    toRfNodes(graph, graph.root, handlers),
  )
  const [rfEdges, setRfEdges, onEdgesChangeInternal] = useEdgesState<RFEdge>(
    toRfEdges(graph, graph.root),
  )

  useEffect(() => {
    setRfNodes(toRfNodes(graph, viewId, handlers))
    setRfEdges(toRfEdges(graph, viewId))
  }, [graph, viewId, handlers, setRfNodes, setRfEdges])

  const onNodesChange = useCallback(
    (changes: NodeChange<AnyRFNode>[]) => {
      // The boundary cards are views of the group, not nodes — never removable.
      const allowed = changes.filter(
        (c) => !(c.type === 'remove' && (c.id === IN_CARD || c.id === OUT_CARD)),
      )
      onNodesChangeInternal(allowed)

      const removed = allowed.filter((c) => c.type === 'remove').map((c) => c.id)
      if (removed.length === 0) return
      const g = graphRef.current
      const gone = new Set(removed.flatMap((id) => [...subtree(g, id)]))
      onChangeRef.current({
        ...g,
        nodes: Object.fromEntries(Object.entries(g.nodes).filter(([id]) => !gone.has(id))),
        edges: Object.fromEntries(
          Object.entries(g.edges).filter(([, e]) => !gone.has(e.from.node) && !gone.has(e.to.node)),
        ),
      })
    },
    [onNodesChangeInternal],
  )

  const rfNodesRef = useRef(rfNodes)
  useEffect(() => {
    rfNodesRef.current = rfNodes
  })

  /** Commit the moved node(s) once, and flag it so codegen is skipped. */
  const onNodeDragStop = useCallback(() => {
    const g = graphRef.current
    const moved = new Map(rfNodesRef.current.map((n) => [n.id, n.position]))
    let changed = false
    const nodes = { ...g.nodes }
    for (const [id, node] of Object.entries(g.nodes)) {
      const p = moved.get(id)
      if (!p || (p.x === node.position.x && p.y === node.position.y)) continue
      changed = true
      nodes[id] = { ...node, position: { x: p.x, y: p.y } }
    }
    if (changed) onChangeRef.current({ ...g, nodes }, { layoutOnly: true })
  }, [])

  const onEdgesChange = useCallback(
    (changes: EdgeChange<RFEdge>[]) => {
      onEdgesChangeInternal(changes)
      const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id))
      if (removed.size === 0) return
      const g = graphRef.current
      onChangeRef.current({
        ...g,
        edges: Object.fromEntries(Object.entries(g.edges).filter(([id]) => !removed.has(id))),
      })
    },
    [onEdgesChangeInternal],
  )

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return
    const view = viewRef.current
    // A wire onto a boundary card is a wire onto the group you are inside.
    const from = { node: c.source === IN_CARD ? view : c.source, port: c.sourceHandle }
    const to = { node: c.target === OUT_CARD ? view : c.target, port: c.targetHandle }
    const next: Edge = { id: `${from.node}.${from.port}->${to.node}.${to.port}`, from, to }

    const g = graphRef.current
    // An input port takes at most one wire — reconnecting replaces it.
    const edges = Object.fromEntries(
      Object.entries(g.edges).filter(([, e]) => !(e.to.node === to.node && e.to.port === to.port)),
    )
    onChangeRef.current({ ...g, edges: { ...edges, [next.id]: next } })
  }, [])

  /** Where a new node lands: the centre of what you're looking at. */
  const dropPosition = useCallback((count: number) => {
    const stagger = (count % 5) * 18
    const rf = rfRef.current
    const pane = wrapperRef.current
    if (!rf || !pane) return { x: 40 + stagger, y: 40 + stagger }
    const r = pane.getBoundingClientRect()
    const c = rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
    return { x: c.x - 84 + stagger, y: c.y - 40 + stagger }
  }, [])

  const addNode = useCallback(
    (template: NodeTemplate | 'blank' | 'group') => {
      // Adding beside a single-function shader first splits that function into a
      // child, so the view becomes a group that can hold siblings.
      const g = groupifyLeaf(graphRef.current, viewRef.current)
      const view = viewRef.current
      const id = newNodeId(g)
      const pos = String.fromCharCode(97 + childrenOf(g, view).length)
      const position = dropPosition(Object.keys(g.nodes).length)

      if (template === 'group') {
        // A group with no children fails the model's own invariant, so it comes
        // with one function inside, already wired through to its result.
        const inner = `${id}_1`
        const groupNode: ShaderNode = {
          id,
          name: 'Group',
          parentId: view,
          pos,
          position,
          returns: 'color',
          params: [{ name: 'uv', type: 'vec2' }],
          values: {},
        }
        const child = blankNode(inner, id, 'a', { x: 160, y: 80 })
        const wireIn: Edge = {
          id: `${id}.uv->${inner}.uv`,
          from: { node: id, port: 'uv' },
          to: { node: inner, port: 'uv' },
        }
        const wireOut: Edge = {
          id: `${inner}.${OUT}->${id}.${OUT}`,
          from: { node: inner, port: OUT },
          to: { node: id, port: OUT },
        }
        onChangeRef.current({
          ...g,
          nodes: { ...g.nodes, [id]: groupNode, [inner]: child },
          edges: { ...g.edges, [wireIn.id]: wireIn, [wireOut.id]: wireOut },
        })
        return
      }

      const node =
        template === 'blank'
          ? blankNode(id, view, pos, position)
          : instantiate(template, id, view, pos, position)
      onChangeRef.current({ ...g, nodes: { ...g.nodes, [id]: node } })
    },
    [dropPosition],
  )

  /** The leaf whose code is open below the canvas, if any. */
  const selected = selectedId ? graph.nodes[selectedId] : undefined
  const editing = selected && selected.body !== undefined ? selected : undefined

  const setPreamble = useCallback((text: string) => {
    const g = graphRef.current
    onChangeRef.current({ ...g, preamble: text })
  }, [])

  const setBody = useCallback((nodeId: string, body: string) => {
    const g = graphRef.current
    const n = g.nodes[nodeId]
    if (!n) return
    onChangeRef.current({ ...g, nodes: { ...g.nodes, [nodeId]: { ...n, body } } })
  }, [])

  /** Root → … → current, for the breadcrumb. */
  const trail = useMemo(() => {
    const out: ShaderNode[] = []
    let cur: ShaderNode | undefined = graph.nodes[viewId]
    while (cur) {
      out.unshift(cur)
      cur = cur.parentId ? graph.nodes[cur.parentId] : undefined
    }
    return out
  }, [graph, viewId])

  return (
    <div ref={wrapperRef} className="relative flex h-full w-full flex-col">
      <div className="relative min-h-0 flex-1">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onInit={(inst) => (rfRef.current = inst)}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, n) => setSelectedId(n.id)}
          onPaneClick={() => setSelectedId(null)}
          fitView
          minZoom={0.2}
          maxZoom={2}
          deleteKeyCode={['Backspace', 'Delete']}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {/* A node IS a function, so selecting one opens its body. This is what
          makes "a custom node holding any SkSL" real rather than a node type
          with a body nobody can reach. The signature above it is generated from
          `params`/`returns`, so the code here is statements only. */}
      {(editing || showPreamble) && (
        <div className="flex h-[42%] min-h-[140px] shrink-0 flex-col border-t border-border">
          <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-2 py-1">
            <span className="truncate font-mono text-[11px]">
              {editing
                ? `${editing.returns} ${editing.name}(${editing.params
                    .map((p) => `${p.type} ${p.name}`)
                    .join(', ')})`
                : 'declarations — emitted above every function'}
            </span>
            <button
              type="button"
              className="rounded px-1 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => {
                setSelectedId(null)
                setShowPreamble(false)
              }}
            >
              Close
            </button>
          </div>
          <ShaderCodeEditor
            language={skslLanguage}
            value={editing ? (editing.body ?? '') : (graph.preamble ?? '')}
            onChange={(v) => (editing ? setBody(editing.id, v) : setPreamble(v))}
            diagnostics={[]}
            className="min-h-0 flex-1"
          />
        </div>
      )}

      <div className="absolute left-2 top-2 z-10 flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-7 gap-1 px-2 text-[11px]"
          onClick={() => setPaletteOpen((o) => !o)}
        >
          <Plus className="size-3" /> Add node
        </Button>

        {/* Not everything in a shader is a function. Uniforms, constants and
            hand-written helpers live here, and without an editor the only way to
            reach them was to leave the graph entirely. */}
        <Button
          type="button"
          size="sm"
          variant={showPreamble ? 'default' : 'secondary'}
          className="h-7 px-2 text-[11px]"
          onClick={() => {
            setShowPreamble((v) => !v)
            setSelectedId(null)
          }}
        >
          Declarations
        </Button>

        {trail.length > 1 && (
          <div className="flex items-center gap-0.5 rounded-md border border-border bg-background/90 px-1.5 py-1 text-[11px]">
            {trail.map((n, i) => (
              <span key={n.id} className="flex items-center gap-0.5">
                {i > 0 && <ChevronRight className="size-3 text-muted-foreground" />}
                <button
                  type="button"
                  className={
                    i === trail.length - 1
                      ? 'font-medium'
                      : 'text-muted-foreground hover:text-foreground'
                  }
                  onClick={() => setViewId(n.id)}
                >
                  {n.name}
                </button>
              </span>
            ))}
          </div>
        )}

        {paletteOpen && (
          <>
            {/* Click-away catcher — keeps the palette a plain popover, no menu dep. */}
            <div className="fixed inset-0 z-10" onClick={() => setPaletteOpen(false)} />
            <div className="absolute left-0 top-8 z-20 min-w-[150px] rounded-md border border-border bg-popover p-1 shadow-md">
              {NODE_TEMPLATES.map((t) => (
                <button
                  key={t.kind}
                  type="button"
                  className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    addNode(t)
                    setPaletteOpen(false)
                  }}
                >
                  {t.title}
                </button>
              ))}
              <div className="my-1 border-t border-border" />
              <button
                type="button"
                className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  addNode('blank')
                  setPaletteOpen(false)
                }}
              >
                Function…
              </button>
              <button
                type="button"
                className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  addNode('group')
                  setPaletteOpen(false)
                }}
              >
                Group
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
