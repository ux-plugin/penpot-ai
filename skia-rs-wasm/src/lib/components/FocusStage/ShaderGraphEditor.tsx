/**
 * ShaderGraphEditor — the node-canvas view over a {@link ShaderGraph}.
 *
 * The IR is the single source of truth and no React Flow types reach the model or
 * the codegen, so replacing this with our own canvas later is a swap of this one
 * file.
 *
 * **Transient vs committed state.** React Flow owns the in-flight gesture in local
 * state; the IR is updated only at meaningful moments. A node drag therefore costs
 * nothing but React Flow's own render — driving the IR on every drag frame meant
 * rebuilding the graph, RECOMPILING the SkSL and re-rendering the whole stage per
 * mouse-move. Positions are committed once, on drag stop, and flagged
 * `layoutOnly` so they skip codegen entirely (position is view state — the
 * compiler ignores it). Structural edits (connect, delete, add, param) go to the
 * IR immediately, since those genuinely change the shader.
 *
 * Ports are typed (float / vec2 / color) and colour-coded; an input port with a
 * same-named param shows an inline control while it's UNWIRED, and hides it once
 * a wire supplies the value (the wire wins — see `compile.ts`'s resolution order).
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react'
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
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NODE_PALETTE, NODE_SPECS, OUTPUT_KIND, type NodeSpec } from '../../renderer/shader-lang/graph/nodes'
import type { Edge, GraphNode, ParamValue, PortType, ShaderGraph } from '../../renderer/shader-lang/graph/types'

/** One colour per port type, so a wiring mistake is visible before it compiles. */
const PORT_COLOR: Record<PortType, string> = {
  float: '#9CA3AF',
  vec2: '#38BDF8',
  color: '#F59E0B',
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const to255 = (n: number) => Math.round(clamp01(n) * 255)

function rgbToHex(v: ParamValue | undefined): string {
  const c = Array.isArray(v) ? v : [0.5, 0.5, 0.5]
  return `#${[c[0] ?? 0, c[1] ?? 0, c[2] ?? 0].map((n) => to255(n).toString(16).padStart(2, '0')).join('')}`
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0.5, 0.5, 0.5]
  const int = parseInt(m[1], 16)
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255]
}

interface ShaderNodeData extends Record<string, unknown> {
  node: GraphNode
  spec: NodeSpec
  /** Input port names currently fed by a wire — their inline controls are hidden. */
  wired: string[]
  onParam: (nodeId: string, param: string, value: ParamValue) => void
  onDelete: (nodeId: string) => void
}

/**
 * A single node: title bar, typed port rows, and inline controls for unwired
 * params. Memoized, and its `data` callbacks are identity-stable, so dragging one
 * node doesn't re-render the rest of the graph.
 */
const ShaderNodeView = memo(function ShaderNodeView({ data, selected }: NodeProps<RFNode<ShaderNodeData>>) {
  const { node, spec, wired, onParam, onDelete } = data
  const params = spec.params
  const wiredSet = new Set(wired)
  const isOutput = spec.kind === OUTPUT_KIND

  return (
    <div
      className={`min-w-[168px] rounded-lg border bg-background shadow-sm ${
        selected ? 'border-ring ring-1 ring-ring' : 'border-border'
      }`}
    >
      <div className="flex items-center justify-between gap-2 rounded-t-lg border-b border-border bg-muted/60 px-2 py-1">
        <span className="text-[11px] font-medium">{spec.title}</span>
        {!isOutput && (
          <button
            type="button"
            className="nodrag rounded p-0.5 text-muted-foreground/70 hover:text-destructive"
            onClick={() => onDelete(node.id)}
            aria-label={`Delete ${spec.title}`}
            title="Delete node"
          >
            <Trash2 className="size-3" />
          </button>
        )}
      </div>

      <div className="space-y-1 px-2 py-1.5">
        {spec.inputs.map((port) => {
          const param = params.find((p) => p.name === port.name)
          const showControl = param != null && !wiredSet.has(port.name)
          return (
            <div key={port.name} className="relative flex items-center gap-2 py-0.5">
              <Handle
                type="target"
                position={Position.Left}
                id={port.name}
                style={{ background: PORT_COLOR[port.type], width: 8, height: 8, left: -10 }}
              />
              <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                {port.label ?? port.name}
              </span>
              {showControl && (
                <ParamControl
                  type={param.type}
                  value={node.params?.[param.name] ?? param.default}
                  onChange={(v) => onParam(node.id, param.name, v)}
                />
              )}
            </div>
          )
        })}

        {/* Params with no matching input port (pure constants, e.g. angle/scale). */}
        {params
          .filter((p) => !spec.inputs.some((i) => i.name === p.name))
          .map((p) => (
            <div key={p.name} className="flex items-center gap-2 py-0.5">
              <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                {p.label ?? p.name}
              </span>
              <ParamControl
                type={p.type}
                value={node.params?.[p.name] ?? p.default}
                onChange={(v) => onParam(node.id, p.name, v)}
              />
            </div>
          ))}

        {spec.outputs.map((port) => (
          <div key={port.name} className="relative flex items-center justify-end py-0.5">
            <span className="truncate text-[10px] text-muted-foreground">{port.label ?? port.name}</span>
            <Handle
              type="source"
              position={Position.Right}
              id={port.name}
              style={{ background: PORT_COLOR[port.type], width: 8, height: 8, right: -10 }}
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
  value: ParamValue
  onChange: (v: ParamValue) => void
}) {
  if (type === 'color') {
    return (
      <input
        type="color"
        className="nodrag h-5 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
        value={rgbToHex(value)}
        onChange={(e) => onChange(hexToRgb(e.target.value))}
      />
    )
  }
  if (type === 'vec2') {
    const v = Array.isArray(value) ? value : [0, 0]
    return (
      <div className="flex gap-1">
        {[0, 1].map((i) => (
          <input
            key={i}
            type="number"
            step={0.1}
            className="nodrag h-5 w-11 rounded border border-border bg-background px-1 text-[10px]"
            value={v[i] ?? 0}
            onChange={(e) => {
              const next: [number, number] = [Number(v[0] ?? 0), Number(v[1] ?? 0)]
              next[i] = Number(e.target.value)
              onChange(next)
            }}
          />
        ))}
      </div>
    )
  }
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

const nodeTypes = { shaderNode: ShaderNodeView }

/** First unused `n<k>` id, so ids stay short and stable-looking. */
function newNodeId(graph: ShaderGraph): string {
  const used = new Set(graph.nodes.map((n) => n.id))
  for (let i = 1; ; i++) {
    const id = `n${i}`
    if (!used.has(id)) return id
  }
}

/** How an IR edit should be treated downstream. */
export interface GraphChangeOptions {
  /** Positions only — the shader is unchanged, so skip codegen. */
  layoutOnly?: boolean
}

export interface ShaderGraphEditorProps {
  graph: ShaderGraph
  onChange: (next: ShaderGraph, opts?: GraphChangeOptions) => void
}

function toRfNodes(
  graph: ShaderGraph,
  onParam: ShaderNodeData['onParam'],
  onDelete: ShaderNodeData['onDelete'],
): RFNode<ShaderNodeData>[] {
  return graph.nodes.flatMap((node) => {
    const spec = NODE_SPECS[node.kind]
    if (!spec) return []
    const wired = graph.edges.filter((e) => e.to.node === node.id).map((e) => e.to.port)
    return [
      {
        id: node.id,
        type: 'shaderNode',
        position: node.position,
        data: { node, spec, wired, onParam, onDelete },
      },
    ]
  })
}

function toRfEdges(graph: ShaderGraph): RFEdge[] {
  return graph.edges.map((e) => ({
    id: e.id,
    source: e.from.node,
    sourceHandle: e.from.port,
    target: e.to.node,
    targetHandle: e.to.port,
  }))
}

export function ShaderGraphEditor({ graph, onChange }: ShaderGraphEditorProps) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  // The React Flow instance (for screen↔flow conversion) and the pane element,
  // so a new node can be dropped at the centre of what's currently visible.
  const rfRef = useRef<ReactFlowInstance<RFNode<ShaderNodeData>, RFEdge> | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Read the live graph/callback through refs so every handler below can have an
  // EMPTY dep array. That keeps `data.onParam`/`onDelete` identity-stable, which
  // is what lets the memoized node view skip re-rendering siblings.
  const graphRef = useRef(graph)
  graphRef.current = graph
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const setParam = useCallback((nodeId: string, param: string, value: ParamValue) => {
    const g = graphRef.current
    onChangeRef.current({
      ...g,
      nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, params: { ...n.params, [param]: value } } : n)),
    })
  }, [])

  const deleteNode = useCallback((nodeId: string) => {
    const g = graphRef.current
    onChangeRef.current({
      nodes: g.nodes.filter((n) => n.id !== nodeId),
      edges: g.edges.filter((e) => e.from.node !== nodeId && e.to.node !== nodeId),
    })
  }, [])

  // React Flow owns the in-flight gesture. Seeded from the IR and re-seeded
  // whenever the IR actually changes (our own commits, undo, external edits).
  const [rfNodes, setRfNodes, onNodesChangeInternal] = useNodesState<RFNode<ShaderNodeData>>(
    toRfNodes(graph, setParam, deleteNode),
  )
  const [rfEdges, setRfEdges, onEdgesChangeInternal] = useEdgesState<RFEdge>(toRfEdges(graph))

  useEffect(() => {
    setRfNodes(toRfNodes(graph, setParam, deleteNode))
    setRfEdges(toRfEdges(graph))
  }, [graph, setParam, deleteNode, setRfNodes, setRfEdges])

  const onNodesChange = useCallback(
    (changes: NodeChange<RFNode<ShaderNodeData>>[]) => {
      const g = graphRef.current
      // The output node is the graph's terminal — never removable.
      const allowed = changes.filter(
        (c) => !(c.type === 'remove' && g.nodes.find((n) => n.id === c.id)?.kind === OUTPUT_KIND),
      )
      // Positions land in React Flow's state only; the IR hears about them on
      // drag stop. Everything here is view state until then.
      onNodesChangeInternal(allowed)

      const removed = allowed.filter((c) => c.type === 'remove').map((c) => c.id)
      if (removed.length === 0) return
      const gone = new Set(removed)
      onChangeRef.current({
        nodes: g.nodes.filter((n) => !gone.has(n.id)),
        edges: g.edges.filter((e) => !gone.has(e.from.node) && !gone.has(e.to.node)),
      })
    },
    [onNodesChangeInternal],
  )

  // Latest rendered positions, for the drag-stop commit below.
  const rfNodesRef = useRef(rfNodes)
  rfNodesRef.current = rfNodes

  /** Commit the moved node(s) once, and flag it so codegen is skipped. */
  const onNodeDragStop = useCallback(() => {
    const g = graphRef.current
    const moved = new Map(rfNodesRef.current.map((n) => [n.id, n.position]))
    let changed = false
    const nodes = g.nodes.map((n) => {
      const p = moved.get(n.id)
      if (!p || (p.x === n.position.x && p.y === n.position.y)) return n
      changed = true
      return { ...n, position: { x: p.x, y: p.y } }
    })
    if (changed) onChangeRef.current({ ...g, nodes }, { layoutOnly: true })
  }, [])

  const onEdgesChange = useCallback(
    (changes: EdgeChange<RFEdge>[]) => {
      onEdgesChangeInternal(changes)
      const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id))
      if (removed.size === 0) return
      const g = graphRef.current
      onChangeRef.current({ ...g, edges: g.edges.filter((e) => !removed.has(e.id)) })
    },
    [onEdgesChangeInternal],
  )

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return
    const next: Edge = {
      id: `${c.source}.${c.sourceHandle}->${c.target}.${c.targetHandle}`,
      from: { node: c.source, port: c.sourceHandle },
      to: { node: c.target, port: c.targetHandle },
    }
    const g = graphRef.current
    // An input port takes at most one wire — reconnecting replaces it.
    const edges = g.edges.filter((e) => !(e.to.node === next.to.node && e.to.port === next.to.port))
    onChangeRef.current({ ...g, edges: [...edges, next] })
  }, [])

  const addNode = useCallback((spec: NodeSpec) => {
    const g = graphRef.current
    const id = newNodeId(g)
    // Drop it where you're looking: the centre of the visible pane, converted
    // from screen to flow space so it lands correctly at any pan/zoom. A small
    // stagger keeps successive adds from stacking perfectly.
    const stagger = (g.nodes.length % 5) * 18
    let position = { x: 40 + stagger, y: 40 + stagger }
    const rf = rfRef.current
    const pane = wrapperRef.current
    if (rf && pane) {
      const r = pane.getBoundingClientRect()
      const c = rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
      // Offset by roughly half a node so the node is centred, not its corner.
      position = { x: c.x - 84 + stagger, y: c.y - 40 + stagger }
    }
    onChangeRef.current({ ...g, nodes: [...g.nodes, { id, kind: spec.kind, position }] })
  }, [])

  const hasOutput = graph.nodes.some((n) => n.kind === OUTPUT_KIND)

  return (
    <div ref={wrapperRef} className="relative h-full w-full">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onInit={(inst) => (rfRef.current = inst)}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        fitView
        minZoom={0.2}
        maxZoom={2}
        deleteKeyCode={['Backspace', 'Delete']}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>

      <div className="absolute left-2 top-2 z-10">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-7 gap-1 px-2 text-[11px]"
          onClick={() => setPaletteOpen((o) => !o)}
        >
          <Plus className="size-3" /> Add node
        </Button>
        {paletteOpen && (
          <>
            {/* Click-away catcher — keeps the palette a plain popover, no menu dep. */}
            <div className="fixed inset-0 z-10" onClick={() => setPaletteOpen(false)} />
            <div className="absolute left-0 top-8 z-20 min-w-[150px] rounded-md border border-border bg-popover p-1 shadow-md">
              {NODE_PALETTE.filter((s) => !(s.kind === OUTPUT_KIND && hasOutput)).map((s) => (
                <button
                  key={s.kind}
                  type="button"
                  className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    addNode(s)
                    setPaletteOpen(false)
                  }}
                >
                  {s.title}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
