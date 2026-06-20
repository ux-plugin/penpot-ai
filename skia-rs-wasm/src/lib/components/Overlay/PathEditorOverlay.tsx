/**
 * Vector-edit overlay (R4). Active while the canvas machine is in `pathEditing`.
 * A THIN VIEW over the editable VECTOR NETWORK (`content.network`): it draws the
 * network's nodes + edges and translates pointer gestures into network ops (R1)
 * and machine events (R3). Nodes have a stable identity, so "branch", "close" and
 * "join" are all the same op — `vnConnectNodes(a, b)` — and a shared node is one
 * node, never a coincident duplicate.
 *
 *   selecting mode (the default):
 *     - drag a node      → vnMoveNode (its incident edges follow rigidly)
 *     - drag a handle cap → reshapes that one edge (handles are independent)
 *     - click an edge     → vnSplitEdge (adds a point)
 *     - double-click node → vnToggleSmoothNode (round / sharpen)
 *     - select node + Del → vnDeleteNode (+ prune isolated)
 *   pen mode (toolbar Pen):
 *     - click empty   → vnAddNode (+ connect from the draft node); drag pulls a handle
 *     - click a node  → vnConnectNodes(draft, node) — branch / close / join, no dup
 *     - Esc           → cancel the pen draft
 *
 * During a drag the working network lives in `pathEditNetwork` and the shape is
 * repainted live via `renderer.updateShape`; on release one `commitNodePartialUpdate`
 * records an undoable edit (`networkContent` writes the network + its sharp mirror).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSelector } from '@xstate/react'
import { useSnapshot } from 'valtio'
import type { PenpotNode } from 'penpot-exporter/types'
import { useCanvasActor } from '../../renderer/machine/canvas-actor-context'
import { useSignalCoalesced } from '../../renderer/signals/use-signal-coalesced'
import { modAlt, modCtrl, modMeta, modShift, pointerPos, viewport as viewportSignal } from '../../renderer/signals/pointer'
import { useViewportShortcutsStore } from '../../renderer/store/shortcuts-store'
import { pathEditNetwork } from '../../renderer/signals/selection'
import { docProxy, getActiveOrSinglePageId } from '../../renderer/store/doc-proxy'
import { getSelectedIdsSet, setSelectedIds } from '../../renderer/store/document-selection'
import { applyChanges } from '../../page-crud'
import type { Change } from 'penpot-exporter/types'
import { useWorkspaceStore } from '../../renderer/store/workspace-store'
import {
  commitNodePartialUpdate,
  getCommittedNodeOnActivePage,
} from '../../renderer/properties/commit-node-properties'
import { screenToWorld, worldToScreen } from '../../renderer/viewport'
import {
  anchorsToSegments,
  nearestPointOnPath,
  segmentsToSvgPath,
  type Anchor,
  type Pt,
} from '../../renderer/geom/anchors'
import { getSubpaths } from '../../renderer/geom/subpaths'
import {
  networkContent,
  subpathsToVN,
  vnAddNode,
  vnBounds,
  vnConnectNodes,
  vnDeleteNode,
  vnMoveNode,
  vnPruneIsolatedNodes,
  vnPullHandles,
  vnSplitEdge,
  vnToggleSmoothNode,
  type VectorNetwork,
} from '../../renderer/geom/vector-network'
import { HANDLE_FILL, SELECTION_STROKE } from './constants'
import { CursorHintChip } from '../CursorHint'
import { resolvePathInteraction, type PathHover } from './path-interaction'

/** Screen-px reach for the add-point hit band / hover ghost. */
const ADD_HIT_PX = 8
/** Screen-px radius to snap onto an existing node (close / connect / grab). */
const NODE_HIT_PX = 12

type XY = { x: number; y: number }

const cloneNet = (vn: VectorNetwork): VectorNetwork => ({
  nodes: vn.nodes.map((n) => ({ x: n.x, y: n.y })),
  edges: vn.edges.map((e) => ({
    a: e.a,
    b: e.b,
    ...(e.ha ? { ha: { x: e.ha.x, y: e.ha.y } } : {}),
    ...(e.hb ? { hb: { x: e.hb.x, y: e.hb.y } } : {}),
  })),
})

/** The network a node carries: explicit `content.network`, else built (with merge,
 *  so coincident endpoints heal into shared nodes) from its sub-paths. */
function vnFromContent(content: unknown): VectorNetwork {
  const net = (content as { network?: VectorNetwork } | null | undefined)?.network
  if (net && Array.isArray(net.nodes) && net.nodes.length > 0) return cloneNet(net)
  return subpathsToVN(getSubpaths(content as Parameters<typeof getSubpaths>[0]), true)
}

/** Node-geometry partial from a network: content (network + sharp mirror) and a
 *  bbox spanning every node and handle. */
function networkPartial(node: PenpotNode, vn: VectorNetwork): Partial<PenpotNode> {
  const b = vnBounds(vn)
  const prev = (node as { content?: Record<string, unknown> }).content ?? {}
  const nc = networkContent(vn)
  return {
    ...node,
    content: {
      ...prev,
      vertices: undefined,
      closed: undefined,
      ...nc,
    } as PenpotNode['content'],
    points: [
      { x: b.x, y: b.y },
      { x: b.x + b.width, y: b.y },
      { x: b.x + b.width, y: b.y + b.height },
      { x: b.x, y: b.y + b.height },
    ],
    selrect: { x: b.x, y: b.y, width: b.width, height: b.height, x1: b.x, y1: b.y, x2: b.x + b.width, y2: b.y + b.height },
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
  }
}

/** A single edge as a 2-anchor path (for nearest-point / SVG rendering). */
function edgeAnchors(vn: VectorNetwork, ei: number): Anchor[] {
  const e = vn.edges[ei]
  const A = vn.nodes[e.a]
  const B = vn.nodes[e.b]
  return [
    { point: { x: A.x, y: A.y }, ...(e.ha ? { handleOut: { x: e.ha.x, y: e.ha.y } } : {}) },
    { point: { x: B.x, y: B.y }, ...(e.hb ? { handleIn: { x: e.hb.x, y: e.hb.y } } : {}) },
  ]
}

export function PathEditorOverlay() {
  const canvasActor = useCanvasActor()
  const isPathEditing = useSelector(canvasActor, (s) => s.matches('pathEditing'))
  // The sub-tool is a context value now (one flat activity tree). Add pulls handles
  // out via the pen; Bend pulls them out on a plain node drag.
  const subTool = useSelector(canvasActor, (s) => s.context.pathSubTool)
  const inPen = subTool === 'add'
  const inBend = subTool === 'bend'
  const draftFrom = useSelector(canvasActor, (s) => s.context.pathDraftFromNode)
  const shapeId = useSelector(canvasActor, (s) => s.context.pathEditingShapeId)
  // Re-render whenever the document changes so committed edits refresh the markers.
  useSnapshot(docProxy)
  const viewport = useSignalCoalesced(viewportSignal)
  const liveNet = useSignalCoalesced(pathEditNetwork)
  const pointer = useSignalCoalesced(pointerPos)
  // Reactive Alt state so the hint flips to "bend" the moment Option is held.
  const altDown = useSignalCoalesced(modAlt)
  // Effective Add: Alt transiently flips the pen into the Bend quasimode, so EVERY
  // add-only affordance gates on this, never raw `inPen` (cursor/hint/ghost/skeleton/
  // hit-test/handle-caps/dbl-click all honor Alt through this one derived flag).
  const effAdd = inPen && !altDown
  // While the pan modifier is held, the Add tool's full-canvas capture must go
  // transparent so a (default: Shift) drag reaches the surface below and pans
  // instead of dropping a point.
  const shiftDown = useSignalCoalesced(modShift)
  const ctrlDown = useSignalCoalesced(modCtrl)
  const metaDown = useSignalCoalesced(modMeta)
  const panMod = useViewportShortcutsStore((s) => s.viewportShortcuts.panWithModifier)
  const panHeld =
    panMod === 'shift'
      ? !!shiftDown
      : panMod === 'alt'
        ? !!altDown
        : panMod === 'ctrl'
          ? !!ctrlDown
          : panMod === 'meta'
            ? !!metaDown
            : false
  const svgRef = useRef<SVGSVGElement>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  // Add sub-tool: the out-handle a dragged node leaves behind, applied as the next
  // segment's start handle on the following click (gives a smooth curve OUT of the
  // node — the network stores handles per edge, so it can't be set until the next
  // edge exists). Null between clicks / after a corner click.
  const pendingOutRef = useRef<{ node: number; handle: XY } | null>(null)
  // The node selected by a click (the Delete target), scoped to its shape.
  const [selected, setSelected] = useState<{ shapeId: string; index: number } | null>(null)
  const selectedNode = selected && selected.shapeId === shapeId ? selected.index : null

  // Clear live state when the edited shape changes or editing stops.
  useEffect(() => {
    pathEditNetwork.value = null
    return () => {
      dragCleanupRef.current?.()
      pathEditNetwork.value = null
    }
  }, [shapeId, isPathEditing])

  const node = shapeId ? getCommittedNodeOnActivePage(shapeId) : null
  const content = (node as { content?: unknown } | null)?.content
  const committedVN = useMemo(() => vnFromContent(content), [content])
  const vn = (liveNet as VectorNetwork | null) ?? committedVN

  // Remove the shape entirely and leave edit mode — a network with no edges
  // renders nothing, so a degenerate single/isolated-node shape must not persist
  // (matches Penpot/Figma deleting an empty text box). Mirrors text-edit cleanup.
  const deleteSelfShape = useCallback(() => {
    if (!shapeId) return
    const pid = getActiveOrSinglePageId()
    if (!pid) return
    pathEditNetwork.value = null
    canvasActor.send({ type: 'STOP_PATH_EDIT' })
    const sel = getSelectedIdsSet()
    if (sel.has(shapeId)) {
      const next = new Set(sel)
      next.delete(shapeId)
      setSelectedIds(next)
    }
    void applyChanges([{ type: 'del-obj', id: shapeId, pageId: pid } as unknown as Change])
  }, [shapeId, canvasActor])

  // Commit the whole network as one undoable edit.
  const commitVN = useCallback(
    (next: VectorNetwork) => {
      if (!shapeId) return
      // No edges ⇒ no renderable geometry ⇒ delete the shape rather than keep a
      // stray single/isolated-node shape. This is the one choke point all edits
      // flow through, so it eliminates the possibility everywhere at once.
      if (next.edges.length === 0) {
        deleteSelfShape()
        return
      }
      const before = getCommittedNodeOnActivePage(shapeId)
      const pid = getActiveOrSinglePageId()
      if (!before || !pid) {
        pathEditNetwork.value = null
        return
      }
      const { content: c, points, selrect, x, y, width, height } = networkPartial(before, next)
      void commitNodePartialUpdate(shapeId, before, { content: c, points, selrect, x, y, width, height }, pid).then(
        () => {
          pathEditNetwork.value = null
        },
      )
    },
    [shapeId, deleteSelfShape],
  )

  const renderLiveVN = useCallback((node0: PenpotNode, next: VectorNetwork) => {
    const renderer = useWorkspaceStore.getState().renderer
    if (renderer) void renderer.updateShape(networkPartial(node0, next) as PenpotNode)
  }, [])

  // Generic pointer-capture drag. `onMove`/`onUp` receive the world point; `moved`
  // is true once the pointer has travelled past a small threshold.
  const runDrag = useCallback(
    (
      e: React.PointerEvent,
      handlers: { onMove: (world: Pt) => void; onUp: (moved: boolean, world: Pt) => void },
    ) => {
      const svg = svgRef.current
      const vp = viewportSignal.value
      if (!svg || !vp) return
      dragCleanupRef.current?.()
      const rect = svg.getBoundingClientRect()
      const pid = e.pointerId
      const startX = e.clientX
      const startY = e.clientY
      let moved = false
      try {
        svg.setPointerCapture(pid)
      } catch {
        /* best effort */
      }
      const toWorld = (ev: { clientX: number; clientY: number }) =>
        screenToWorld(vp, ev.clientX - rect.left, ev.clientY - rect.top)
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 3) moved = true
        if (moved) handlers.onMove(toWorld(ev))
      }
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return
        cleanup()
        handlers.onUp(moved, toWorld(ev))
      }
      const cleanup = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        try {
          svg.releasePointerCapture(pid)
        } catch {
          /* already released */
        }
        dragCleanupRef.current = null
      }
      dragCleanupRef.current = cleanup
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [],
  )

  // ── Select mode: drag a node (rigid — incident edges follow). ───────────────
  const beginNodeDrag = useCallback(
    (i: number) => (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!shapeId) return
      const node0 = getCommittedNodeOnActivePage(shapeId)
      if (!node0) return
      canvasActor.send({ type: 'PATH_GRAB_NODE', node: i })
      setSelected({ shapeId, index: i })
      const startVN = cloneNet(vn)
      const P = { x: startVN.nodes[i].x, y: startVN.nodes[i].y }
      // Alt-drag pulls a symmetric handle pair out of the node (corner → smooth)
      // instead of moving it. Decided on the first move from the tracked Alt state
      // (so pressing the dot, then holding Alt, then dragging works).
      const altStart = e.altKey
      let bend = false
      let bendDecided = false
      const at = (w: Pt) =>
        bend ? vnPullHandles(startVN, i, w) : vnMoveNode(startVN, i, { x: w.x - P.x, y: w.y - P.y })
      runDrag(e, {
        onMove: (w) => {
          if (!bendDecided) {
            // The Bend sub-tool makes every node drag a bend; Alt is the same
            // thing as a one-off modifier while in Move.
            bend = inBend || altStart || modAlt.value
            bendDecided = true
          }
          const next = at(w)
          pathEditNetwork.value = next
          renderLiveVN(node0, next)
        },
        onUp: (moved, w) => {
          canvasActor.send({ type: 'PATH_POINTER_UP' })
          if (moved) commitVN(at(w))
          else pathEditNetwork.value = null
        },
      })
    },
    [shapeId, vn, canvasActor, runDrag, renderLiveVN, commitVN, inBend],
  )

  // ── Select mode: drag a handle cap (reshapes one edge; independent). ────────
  const beginHandleDrag = useCallback(
    (edgeIdx: number, end: 'a' | 'b') => (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!shapeId) return
      const node0 = getCommittedNodeOnActivePage(shapeId)
      if (!node0) return
      const edge = vn.edges[edgeIdx]
      canvasActor.send({ type: 'PATH_GRAB_HANDLE', node: end === 'a' ? edge.a : edge.b, side: end === 'a' ? 'out' : 'in' })
      const startVN = cloneNet(vn)
      const key = end === 'a' ? 'ha' : 'hb'
      const at = (w: Pt) => {
        const next = cloneNet(startVN)
        next.edges[edgeIdx][key] = { x: w.x, y: w.y }
        return next
      }
      runDrag(e, {
        onMove: (w) => {
          const next = at(w)
          pathEditNetwork.value = next
          renderLiveVN(node0, next)
        },
        onUp: (moved, w) => {
          canvasActor.send({ type: 'PATH_POINTER_UP' })
          if (moved) commitVN(at(w))
          else pathEditNetwork.value = null
        },
      })
    },
    [shapeId, vn, canvasActor, runDrag, renderLiveVN, commitVN],
  )

  // ── Select mode: double-click a node → round / sharpen. ─────────────────────
  const onToggleSmooth = useCallback(
    (i: number) => (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      commitVN(vnToggleSmoothNode(vn, i))
    },
    [vn, commitVN],
  )

  // ── Select mode: click an edge → add a point (split). ───────────────────────
  const onAddPoint = useCallback(
    (edgeIdx: number) => (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const vp = viewportSignal.value
      const svg = svgRef.current
      if (!vp || !svg) return
      const rect = svg.getBoundingClientRect()
      const world = screenToWorld(vp, e.clientX - rect.left, e.clientY - rect.top)
      const hit = nearestPointOnPath(edgeAnchors(vn, edgeIdx), false, world)
      if (!hit) return
      const { network: next } = vnSplitEdge(vn, edgeIdx, hit.t)
      setSelected(null)
      commitVN(next)
    },
    [vn, commitVN],
  )

  // ── Pen mode: click a node → connect from the draft (branch / close / join). ─
  const onPenNode = useCallback(
    (i: number) => (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (draftFrom == null) {
        canvasActor.send({ type: 'PATH_SET_DRAFT_FROM', node: i })
        return
      }
      if (draftFrom !== i) commitVN(vnConnectNodes(vn, draftFrom, i))
      canvasActor.send({ type: 'PATH_SET_DRAFT_FROM', node: i })
    },
    [draftFrom, vn, canvasActor, commitVN],
  )

  // ── Pen mode: click empty canvas → add a node (+ connect); drag pulls a handle.
  const onPenCanvas = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      if (!shapeId) return
      const node0 = getCommittedNodeOnActivePage(shapeId)
      const vp = viewportSignal.value
      const svg = svgRef.current
      if (!node0 || !vp || !svg) return
      const rect = svg.getBoundingClientRect()
      const world = screenToWorld(vp, e.clientX - rect.left, e.clientY - rect.top)
      const added = vnAddNode(vn, world)
      let base = added.network
      const newIdx = added.node
      let edgeIdx = -1
      if (draftFrom != null && draftFrom < vn.nodes.length) {
        base = vnConnectNodes(base, draftFrom, newIdx)
        edgeIdx = base.edges.length - 1 // the connecting edge a=draft, b=new
        // If the previous node was dragged out, its out-handle starts this segment
        // smoothly (ha = handle at the a=draft end).
        if (pendingOutRef.current && pendingOutRef.current.node === draftFrom) {
          base.edges[edgeIdx].ha = { ...pendingOutRef.current.handle }
        }
      }
      pendingOutRef.current = null
      canvasActor.send({ type: 'PATH_PEN_DOWN' })
      pathEditNetwork.value = base
      renderLiveVN(node0, base)
      // Drag pulls the new node's OUT handle toward the cursor; for a smooth node
      // the IN handle (hb of the arriving edge) mirrors it. Alt breaks the mirror →
      // a corner with only an out-handle (asymmetric), matching the pen tool.
      const altStart = e.altKey
      const at = (w: Pt) => {
        if (edgeIdx < 0) return base
        const next = cloneNet(base)
        if (!(altStart || modAlt.value)) {
          next.edges[edgeIdx].hb = { x: 2 * world.x - w.x, y: 2 * world.y - w.y }
        }
        return next
      }
      runDrag(e, {
        onMove: (w) => {
          pendingOutRef.current = { node: newIdx, handle: { x: w.x, y: w.y } }
          const next = at(w)
          pathEditNetwork.value = next
          renderLiveVN(node0, next)
        },
        onUp: (moved, w) => {
          canvasActor.send({ type: 'PATH_POINTER_UP' })
          canvasActor.send({ type: 'PATH_SET_DRAFT_FROM', node: newIdx })
          pendingOutRef.current = moved ? { node: newIdx, handle: { x: w.x, y: w.y } } : null
          commitVN(moved ? at(w) : base)
        },
      })
    },
    [shapeId, vn, draftFrom, canvasActor, runDrag, renderLiveVN, commitVN],
  )

  // Delete the selected node (and any node it strands); Esc cancels the pen draft.
  const deleteSelected = useCallback(() => {
    if (selectedNode == null) return
    if (selectedNode >= vn.nodes.length) {
      setSelected(null)
      return
    }
    const next = vnPruneIsolatedNodes(vnDeleteNode(vn, selectedNode))
    setSelected(null)
    commitVN(next) // deletes the shape if this empties it (no edges left)
  }, [selectedNode, vn, commitVN])

  useEffect(() => {
    if (!isPathEditing) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedNode == null) return
        e.preventDefault()
        deleteSelected()
      } else if (e.key === 'Escape' && inPen) {
        // Cancel the pen draft but stay in edit mode (beat the surface's exit).
        e.preventDefault()
        e.stopPropagation()
        canvasActor.send({ type: 'PATH_CANCEL' })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isPathEditing, inPen, selectedNode, deleteSelected, canvasActor])

  // Drop stray isolated nodes (a pen point placed but never connected) once we're
  // no longer drawing — so an abandoned draft can't leave a "non-connected" dot.
  useEffect(() => {
    if (!isPathEditing || inPen || !shapeId) return
    const pruned = vnPruneIsolatedNodes(committedVN)
    // No edges (all isolated) ⇒ commitVN deletes the shape; otherwise drop strays.
    if (pruned.edges.length === 0 || pruned.nodes.length < committedVN.nodes.length) {
      commitVN(pruned)
    }
  }, [isPathEditing, inPen, shapeId, committedVN, commitVN])

  const onTrackMove = useCallback((e: React.PointerEvent) => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    pointerPos.value = { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }, [])

  if (
    !isPathEditing ||
    !shapeId ||
    !viewport ||
    !node ||
    (node as { type?: string }).type !== 'path' ||
    vn.nodes.length === 0
  ) {
    return null
  }

  const toScreen = (p: XY) => worldToScreen(viewport, p.x, p.y)
  const zoom = viewport.zoom ?? 1
  const cursorWorld = pointer ? screenToWorld(viewport, pointer.x, pointer.y) : null

  const degree = vn.nodes.map(() => 0)
  for (const e of vn.edges) {
    if (e.a !== e.b) {
      degree[e.a]++
      degree[e.b]++
    }
  }

  // Node under the cursor (snap target for pen close / connect, or grab).
  let hoverNode = -1
  if (cursorWorld) {
    let best = NODE_HIT_PX
    vn.nodes.forEach((n, i) => {
      const s = toScreen(n)
      const d = Math.hypot((pointer?.x ?? 0) - s.x, (pointer?.y ?? 0) - s.y)
      if (d <= best) {
        best = d
        hoverNode = i
      }
    })
  }

  // Nearest edge point (Add only). It's also the ghost dot's position: snap onto
  // the edge when close, else float at the cursor (a new free node).
  let ghostPos: XY | null = null
  let nearEdge = false
  if (effAdd && !liveNet && cursorWorld && hoverNode < 0) {
    let bestD = Infinity
    let bestPt: XY | null = null
    vn.edges.forEach((_, ei) => {
      const hit = nearestPointOnPath(edgeAnchors(vn, ei), false, cursorWorld)
      if (hit && hit.dist < bestD) {
        bestD = hit.dist
        bestPt = hit.point
      }
    })
    nearEdge = bestPt != null && bestD * zoom <= ADD_HIT_PX
    ghostPos = toScreen(nearEdge && bestPt ? bestPt : cursorWorld)
  }

  // Pen connect target: a node (other than the draft) under the cursor.
  const penTarget = effAdd && hoverNode >= 0 && hoverNode !== draftFrom ? hoverNode : -1

  // One resolved interaction drives cursor / hint / ghost / capture (see
  // path-interaction.ts), so they can never disagree — pan suppresses all of them.
  // `subTool` is the machine context value read at the top.
  const hover: PathHover = effAdd
    ? penTarget >= 0
      ? 'node-target'
      : nearEdge
        ? 'edge'
        : 'empty'
    : hoverNode >= 0
      ? 'node'
      : 'empty'
  const it = resolvePathInteraction({ subTool, panHeld, altHeld: !!altDown, hover, dragging: !!liveNet })
  const nodeCursor = it.cursor

  return (
    <>
      <svg
        ref={svgRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}
      >
        {/* Pen mode: full-area capture for placing a new node on empty canvas. */}
        {inPen && (
          <rect
            x={0}
            y={0}
            width="100%"
            height="100%"
            fill="transparent"
            style={{ pointerEvents: it.capture ? 'auto' : 'none', cursor: it.cursor }}
            onPointerMove={onTrackMove}
            onPointerDown={onPenCanvas}
          />
        )}

        {/* Edges: visible skeleton + (Add sub-tool) invisible add-point hit band. */}
        {vn.edges.map((_, ei) => {
          const sa = edgeAnchors(vn, ei).map((a) => ({
            point: toScreen(a.point),
            ...(a.handleIn ? { handleIn: toScreen(a.handleIn) } : {}),
            ...(a.handleOut ? { handleOut: toScreen(a.handleOut) } : {}),
          }))
          const d = segmentsToSvgPath(anchorsToSegments(sa, false))
          return (
            <g key={`e${ei}`}>
              {inPen && (
                <path
                  d={d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={ADD_HIT_PX * 2}
                  style={{ pointerEvents: it.capture ? 'stroke' : 'none', cursor: it.cursor }}
                  onPointerMove={onTrackMove}
                  onPointerDown={onAddPoint(ei)}
                />
              )}
              <path
                d={d}
                fill="none"
                stroke={SELECTION_STROKE}
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={0.9}
                style={{ pointerEvents: 'none' }}
              />
            </g>
          )
        })}

        {/* Pen preview: from the draft node to the cursor (snaps to a target node). */}
        {effAdd && draftFrom != null && draftFrom < vn.nodes.length && cursorWorld && (() => {
          const a = toScreen(vn.nodes[draftFrom])
          const c = penTarget >= 0 ? toScreen(vn.nodes[penTarget]) : toScreen(cursorWorld)
          return (
            <line x1={a.x} y1={a.y} x2={c.x} y2={c.y} stroke={SELECTION_STROKE} strokeWidth={1.5} strokeDasharray="4 3" />
          )
        })()}

        {/* Handles: one cap + leader per edge end that has one. Shown in both modes
            (so a curve pulled out while drawing is visible); draggable only in
            select mode — in pen mode the caps don't capture clicks. */}
        {vn.edges.map((e, ei) =>
          (['a', 'b'] as const).map((end) => {
            const h = end === 'a' ? e.ha : e.hb
            if (!h) return null
            const np = toScreen(vn.nodes[end === 'a' ? e.a : e.b])
            const hs = toScreen(h)
            return (
              <g key={`h${ei}${end}`}>
                <line x1={np.x} y1={np.y} x2={hs.x} y2={hs.y} stroke={SELECTION_STROKE} strokeWidth={1} />
                <circle
                  cx={hs.x}
                  cy={hs.y}
                  r={4}
                  fill={HANDLE_FILL}
                  stroke={SELECTION_STROKE}
                  strokeWidth={1.5}
                  style={{ pointerEvents: effAdd ? 'none' : 'auto', cursor: 'grab' }}
                  onPointerDown={effAdd ? undefined : beginHandleDrag(ei, end)}
                />
              </g>
            )
          }),
        )}

        {/* Nodes. Junctions (degree ≥3) are larger; open ends (degree 1) ringed;
            selection / draft / pen-target filled. */}
        {vn.nodes.map((n, i) => {
          const ps = toScreen(n)
          const isJunction = degree[i] >= 3
          const isOpenEnd = degree[i] === 1
          const isSelected = !inPen && i === selectedNode // no lingering selected-anchor fill while placing/connecting (Add)
          const isDraft = inPen && i === draftFrom
          const isTarget = i === penTarget
          const filled = isSelected || isDraft || isTarget
          return (
            <g key={`n${i}`}>
              <circle
                cx={ps.x}
                cy={ps.y}
                r={10}
                fill="transparent"
                style={{ pointerEvents: 'auto', cursor: nodeCursor }}
                onPointerDown={effAdd ? onPenNode(i) : beginNodeDrag(i)}
                onDoubleClick={effAdd ? undefined : onToggleSmooth(i)}
              />
              <circle
                cx={ps.x}
                cy={ps.y}
                r={isTarget ? 7 : isJunction ? 6 : filled ? 6 : 5}
                fill={filled ? SELECTION_STROKE : HANDLE_FILL}
                stroke={SELECTION_STROKE}
                strokeWidth={isOpenEnd || isJunction ? 2.25 : 1.5}
                style={{ pointerEvents: 'auto', cursor: nodeCursor }}
                onPointerDown={effAdd ? onPenNode(i) : beginNodeDrag(i)}
                onDoubleClick={effAdd ? undefined : onToggleSmooth(i)}
              />
            </g>
          )
        })}

        {it.ghost && ghostPos && (
          <circle
            cx={ghostPos.x}
            cy={ghostPos.y}
            r={5}
            fill="none"
            stroke={SELECTION_STROKE}
            strokeWidth={1.5}
            strokeDasharray="3 2"
            style={{ pointerEvents: 'none' }}
          />
        )}
      </svg>
      {it.hint && pointer && <CursorHintChip x={pointer.x} y={pointer.y} icon={it.hint} />}
    </>
  )
}
