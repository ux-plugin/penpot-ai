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
import { useHistoryStore } from '../../history/history-store'
import { PEN_CREATE_TX } from '../../renderer/handlers/draw-path'
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
import { buildArcTable, fractionOfHit, sampleFraction, type ArcTable } from '../../renderer/geom/path-arc'
import {
  WIDTH_MODE_COLOR,
  WIDTH_MODE_NUM,
  widthEditActions,
  widthEditState,
  widthModeFromNum,
  type WidthMode,
} from './width-edit-bridge'
import type { StrokeWithSettings } from '../../renderer/stroke-settings'
import { cloneNet, vnFromContent } from '../../renderer/geom/vn-from-content'
import {
  networkContent,
  vnAddNode,
  vnConnectNodes,
  vnTightBounds,
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

/** Node-geometry partial from a network: content (network + sharp mirror) and a
 *  tight curve bbox (hugs the path, not the handle hull — see vnTightBounds). */
function networkPartial(node: PenpotNode, vn: VectorNetwork): Partial<PenpotNode> {
  const b = vnTightBounds(vn)
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

// ── Width tool ──────────────────────────────────────────────────────────────
const WIDTH_MIN_BASE = 4 // mirrors Rust MIN_WIDTH so handles match the render
const WIDTH_SEED_FRACTIONS = [0, 0.25, 0.5, 0.75, 1]

/** A hand-authored width point: arc-fraction, per-side half-width multipliers,
 *  and the interpolation mode of the segment *leaving* it. */
interface WPoint {
  t: number
  l: number
  r: number
  mode: WidthMode
}

/** The ordered anchor chain of a *single* contour (open or closed), or `null` if
 *  the network isn't a simple sequential chain (multi-contour / branched). */
function chainAnchors(vn: VectorNetwork): { anchors: Anchor[]; closed: boolean } | null {
  const edges = vn.edges
  if (!edges || edges.length === 0) return null
  for (let i = 0; i < edges.length - 1; i++) {
    if (edges[i].b !== edges[i + 1].a) return null // not sequential
  }
  const closed = edges[edges.length - 1].b === edges[0].a
  const anchors: Anchor[] = []
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
    const A = vn.nodes[e.a]
    const B = vn.nodes[e.b]
    if (i === 0) {
      anchors.push({ point: { x: A.x, y: A.y }, ...(e.ha ? { handleOut: { x: e.ha.x, y: e.ha.y } } : {}) })
    } else if (e.ha) {
      anchors[anchors.length - 1].handleOut = { x: e.ha.x, y: e.ha.y }
    }
    if (closed && i === edges.length - 1) {
      // Closing edge returns to anchor 0 — set its handleIn, don't duplicate the node.
      if (e.hb) anchors[0].handleIn = { x: e.hb.x, y: e.hb.y }
    } else {
      anchors.push({ point: { x: B.x, y: B.y }, ...(e.hb ? { handleIn: { x: e.hb.x, y: e.hb.y } } : {}) })
    }
  }
  return { anchors, closed }
}

/** Width multiplier of a preset at fraction `t` — mirrors Rust `profile_factor`,
 *  used to seed handles on the current visible width before the first edit. */
function presetFactor(profile: string, t: number): number {
  switch (profile) {
    case 'taper-both':
      return Math.max(0, Math.sin(t * Math.PI))
    case 'taper-start':
      return Math.max(0, Math.min(1, t))
    case 'taper-end':
      return Math.max(0, Math.min(1, 1 - t))
    case 'bulge':
      return 0.35 + 0.65 * Math.max(0, Math.sin(t * Math.PI))
    default:
      return 1 // uniform / custom-empty
  }
}

/** Catmull-Rom through `p1..p2` at `u`, `p0`/`p3` are the surrounding points —
 *  mirrors the Rust `catmull` so the overlay preview matches the render. */
function catmull(p0: number, p1: number, p2: number, p3: number, u: number): number {
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u)
  )
}

/** Interpolate `(l, r)` at fraction `f` from sorted width points. The segment
 *  leaving point `i` follows its `mode` (smooth / corner / stepped) — mirrors the
 *  Rust `custom_factors`. */
function interpWidth(points: WPoint[], f: number): { l: number; r: number } {
  if (points.length === 0) return { l: 1, r: 1 }
  if (f <= points[0].t) return { l: points[0].l, r: points[0].r }
  const last = points[points.length - 1]
  if (f >= last.t) return { l: last.l, r: last.r }
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (f >= a.t && f <= b.t) {
      if (a.mode === 'stepped') return { l: a.l, r: a.r }
      const u = (f - a.t) / Math.max(1e-6, b.t - a.t)
      if (a.mode === 'corner') return { l: a.l + (b.l - a.l) * u, r: a.r + (b.r - a.r) * u }
      const p0 = i > 0 ? points[i - 1] : a
      const p3 = i + 2 < points.length ? points[i + 2] : b
      return {
        l: Math.max(0, catmull(p0.l, a.l, b.l, p3.l, u)),
        r: Math.max(0, catmull(p0.r, a.r, b.r, p3.r, u)),
      }
    }
  }
  return { l: last.l, r: last.r }
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
    // Abandoned before any edge: drop the open create transaction so the dot's
    // add-obj leaves no orphan undo frame (the shape is being deleted anyway).
    // No-op when no transaction is open (e.g. emptying an existing path).
    useHistoryStore.getState().discardTransactions()
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
          // Close the create transaction: the dot + this first edge become one
          // undo entry. No-op for every later edit (the transaction is already
          // committed, and existing paths never opened it).
          useHistoryStore.getState().commitTransaction(PEN_CREATE_TX)
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
        if (subTool === 'width') return // Width mode deletes width points, not path nodes
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
  }, [isPathEditing, inPen, subTool, selectedNode, deleteSelected, canvasActor])

  // Drop stray isolated nodes (a pen point placed but never connected) once we're
  // no longer drawing — but only when real edges remain. A fully degenerate
  // (0-edge) result is left for the `pathEditing` exit action, the one
  // authoritative "a path with no edges must not persist" point (it fires on
  // every way of leaving — done / escape / tool-switch / click-away).
  useEffect(() => {
    if (!isPathEditing || inPen || !shapeId) return
    const pruned = vnPruneIsolatedNodes(committedVN)
    if (pruned.edges.length > 0 && pruned.nodes.length < committedVN.nodes.length) {
      commitVN(pruned)
    }
  }, [isPathEditing, inPen, shapeId, committedVN, commitVN])

  const onTrackMove = useCallback((e: React.PointerEvent) => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    pointerPos.value = { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }, [])

  // ── Width tool: sculpt the stroke's variable-width profile. v1 = a single open
  //    chain; multi-contour / closed paths fall back to preset profiles. Width
  //    points live on the stroke (not the path network), committed on release. ──
  const inWidthTool = subTool === 'width'
  const widthStroke = ((node as { strokes?: StrokeWithSettings[] } | null)?.strokes ?? [])[0] as
    | StrokeWithSettings
    | undefined
  const widthBase = Math.max(WIDTH_MIN_BASE, widthStroke?.strokeWidth ?? 1)
  // Variable width is a stroke property any stroke can hold. Needs a stroke to sculpt.
  const widthCapable = !!widthStroke
  const widthChain = useMemo(() => (inWidthTool ? chainAnchors(vn) : null), [inWidthTool, vn])
  const widthArc = useMemo<ArcTable | null>(
    () => (widthChain ? buildArcTable(widthChain.anchors, widthChain.closed) : null),
    [widthChain],
  )
  const committedWidthPts = useMemo<WPoint[]>(() => {
    const flat = widthStroke?.strokeWidthPoints
    if (Array.isArray(flat) && flat.length >= 4) {
      const out: WPoint[] = []
      for (let i = 0; i + 3 < flat.length; i += 4)
        out.push({ t: flat[i], l: flat[i + 1], r: flat[i + 2], mode: widthModeFromNum(flat[i + 3]) })
      return out.sort((a, b) => a.t - b.t)
    }
    // No custom points yet — seed a width dot on each of the path's OWN anchor
    // nodes (so they sit on the path-definition overlay, not at arbitrary
    // fractions), on the current preset's visible width. Distinct nodes → no
    // stacked seam dot on closed shapes. Falls back to even fractions if the arc
    // table isn't ready. Smooth by default; the Point menu drops to corner/stepped.
    const prof =
      typeof widthStroke?.strokeBrush?.params?.profile === 'string'
        ? (widthStroke.strokeBrush.params.profile as string)
        : 'uniform'
    let fractions: number[] = WIDTH_SEED_FRACTIONS
    if (widthArc && widthChain && widthArc.total > 0) {
      const { anchors, closed } = widthChain
      const edges = closed ? anchors.length : anchors.length - 1
      const raw = anchors.map((_, i) =>
        i < edges ? widthArc.cum[widthArc.edgeStart[i]] / widthArc.total : 1,
      )
      const uniq = Array.from(new Set(raw.map((v) => Math.round(v * 1000) / 1000))).sort((a, b) => a - b)
      if (uniq.length >= 2) fractions = uniq
    }
    return fractions.map((t) => {
      const f = presetFactor(prof, t)
      return { t, l: f, r: f, mode: 'smooth' as WidthMode }
    })
  }, [widthStroke, widthArc, widthChain])
  const [widthDraft, setWidthDraft] = useState<WPoint[] | null>(null)
  // Which width point is selected (drives the toolbar mode control), or -1.
  const [selectedWidthIdx, setSelectedWidthIdx] = useState<number>(-1)
  // Drop the working draft and selection when the shape or the tool changes.
  // Adjusting state during render (guarded by a changed key) rather than in an
  // effect avoids the extra cascading render — see react.dev "you might not need
  // an effect".
  const widthResetKey = `${shapeId ?? ''}:${inWidthTool}`
  const [prevWidthResetKey, setPrevWidthResetKey] = useState(widthResetKey)
  if (widthResetKey !== prevWidthResetKey) {
    setPrevWidthResetKey(widthResetKey)
    setWidthDraft(null)
    setSelectedWidthIdx(-1)
  }

  const commitWidth = useCallback(
    async (pts: WPoint[]) => {
      if (!shapeId) return
      const before = getCommittedNodeOnActivePage(shapeId)
      const pid = getActiveOrSinglePageId()
      if (!before || !pid) return
      const beforeStrokes = (before as { strokes?: StrokeWithSettings[] }).strokes ?? []
      const prev = beforeStrokes[0]
      if (!prev) return // nothing to sculpt
      const flat: number[] = []
      for (const p of [...pts].sort((a, b) => a.t - b.t)) flat.push(p.t, p.l, p.r, WIDTH_MODE_NUM[p.mode])
      // Width is a stroke property — set it, keep the brush exactly as-is.
      const s0: StrokeWithSettings = { ...prev, strokeWidthPoints: flat }
      await commitNodePartialUpdate(shapeId, before, { strokes: [s0, ...beforeStrokes.slice(1)] }, pid)
    },
    [shapeId],
  )

  const startWidthDrag = useCallback(
    (pts: WPoint[], idx: number, side: 'l' | 'r', alt: boolean, e: React.PointerEvent) => {
      const arc = widthArc
      const pt = pts[idx]
      if (!arc || !pt) return
      setSelectedWidthIdx(idx) // grabbing a handle selects its point
      const samp = sampleFraction(arc, pt.t)
      if (!samp) return
      const nx = -samp.tangent.y
      const ny = samp.tangent.x
      const halfBase = widthBase / 2
      let latest = pts.map((p) => ({ ...p }))
      runDrag(e, {
        onMove: (world) => {
          const dist = Math.abs((world.x - samp.point.x) * nx + (world.y - samp.point.y) * ny)
          const mult = Math.max(0, dist / halfBase)
          latest = latest.map((p, i) =>
            i === idx ? { ...p, ...(alt ? { [side]: mult } : { l: mult, r: mult }) } : p,
          )
          setWidthDraft(latest)
        },
        onUp: (moved) => {
          if (moved) void commitWidth(latest)
        },
      })
    },
    [widthArc, widthBase, runDrag, commitWidth],
  )

  const beginWidthHandleDrag = useCallback(
    (idx: number, side: 'l' | 'r') => (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      startWidthDrag(widthDraft ?? committedWidthPts, idx, side, e.altKey, e)
    },
    [startWidthDrag, widthDraft, committedWidthPts],
  )

  const onWidthBandDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const arc = widthArc
      const chain = widthChain
      const svg = svgRef.current
      const vp = viewportSignal.value
      if (!arc || !chain || !svg || !vp) return
      const rect = svg.getBoundingClientRect()
      const world = screenToWorld(vp, e.clientX - rect.left, e.clientY - rect.top)
      const hit = nearestPointOnPath(chain.anchors, chain.closed, world)
      if (!hit) return
      const f = fractionOfHit(arc, hit)
      const base = (widthDraft ?? committedWidthPts).map((p) => ({ ...p }))
      // Close to an existing point → drag it rather than stacking a new one.
      const near = base.findIndex((p) => Math.abs(p.t - f) < 0.02)
      if (near >= 0) {
        startWidthDrag(base, near, 'l', e.altKey, e)
        return
      }
      const seed = interpWidth(base, f)
      const next = [...base, { t: f, l: seed.l, r: seed.r, mode: 'smooth' as WidthMode }].sort((a, b) => a.t - b.t)
      const idx = next.findIndex((p) => p.t === f)
      setWidthDraft(next)
      startWidthDrag(next, idx, 'l', e.altKey, e)
    },
    [widthArc, widthChain, widthDraft, committedWidthPts, startWidthDrag],
  )

  // Change the selected width point's interpolation mode (driven by the toolbar
  // dropdown). Operates on the current draft-or-committed points and commits.
  const setWidthPointMode = useCallback(
    (mode: WidthMode) => {
      const base = (widthDraft ?? committedWidthPts).map((p) => ({ ...p }))
      if (selectedWidthIdx < 0 || selectedWidthIdx >= base.length) return
      base[selectedWidthIdx] = { ...base[selectedWidthIdx], mode }
      setWidthDraft(base)
      void commitWidth(base)
    },
    [widthDraft, committedWidthPts, selectedWidthIdx, commitWidth],
  )

  // Delete a width point (Delete/Backspace on the selected one, or double-click a
  // dot). Removing every point reverts the stroke to uniform width.
  const deleteWidthPoint = useCallback(
    (idx: number) => {
      const base = (widthDraft ?? committedWidthPts).map((p) => ({ ...p }))
      if (idx < 0 || idx >= base.length) return
      base.splice(idx, 1)
      setSelectedWidthIdx(-1)
      setWidthDraft(base)
      void commitWidth(base)
    },
    [widthDraft, committedWidthPts, commitWidth],
  )
  const deleteSelectedWidthPoint = useCallback(
    () => deleteWidthPoint(selectedWidthIdx),
    [deleteWidthPoint, selectedWidthIdx],
  )

  // Publish selection to the toolbar bridge, and register the mode setter so the
  // dropdown can drive a change through our commit path. Cleared on unmount.
  useEffect(() => {
    const active = isPathEditing && inWidthTool && widthCapable
    const pts = widthDraft ?? committedWidthPts
    const sel = active && selectedWidthIdx >= 0 && selectedWidthIdx < pts.length ? selectedWidthIdx : -1
    widthEditState.active = active
    widthEditState.selectedIdx = sel
    widthEditState.mode = sel >= 0 ? pts[sel].mode : null
    widthEditActions.setMode = setWidthPointMode
    return () => {
      widthEditState.active = false
      widthEditState.selectedIdx = -1
      widthEditState.mode = null
      widthEditActions.setMode = null
    }
  }, [isPathEditing, inWidthTool, widthCapable, widthDraft, committedWidthPts, selectedWidthIdx, setWidthPointMode])

  // Width mode: Delete/Backspace removes the selected width point (the node-delete
  // handler above bails while in Width mode).
  useEffect(() => {
    if (!isPathEditing || !inWidthTool) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedWidthIdx >= 0) {
        e.preventDefault()
        e.stopPropagation()
        deleteSelectedWidthPoint()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isPathEditing, inWidthTool, selectedWidthIdx, deleteSelectedWidthPoint])

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

        {/* Edges: visible skeleton + (Add sub-tool) invisible add-point hit band.
            Shown in every mode incl. Width — the width dots just recolour the
            nodes on this same path overlay. */}
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
            select mode — in pen mode the caps don't capture clicks. Hidden in
            Width mode (not editable there). */}
        {!inWidthTool &&
          vn.edges.map((e, ei) =>
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
            selection / draft / pen-target filled. Hidden in Width mode so the
            width handles are the only overlay (and nodes aren't drag-editable). */}
        {!inWidthTool &&
          vn.nodes.map((n, i) => {
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

        {/* Width tool: perpendicular handles along the stroke + an add-anywhere
            hit band. Only for a single open chain (else falls back to presets). */}
        {inWidthTool &&
          widthCapable &&
          widthArc &&
          widthStroke &&
          widthChain &&
          (() => {
            const pts = widthDraft ?? committedWidthPts
            const halfBase = widthBase / 2
            const bandAnchors = widthChain.anchors.map((a) => ({
              point: toScreen(a.point),
              ...(a.handleIn ? { handleIn: toScreen(a.handleIn) } : {}),
              ...(a.handleOut ? { handleOut: toScreen(a.handleOut) } : {}),
            }))
            const bandD = segmentsToSvgPath(anchorsToSegments(bandAnchors, widthChain.closed))
            // Per-point width dot — a round anchor dot filled with the mode colour
            // (the mode is picked from the Point menu). Click to select it.
            const dot = (mode: WidthMode, cx: number, cy: number, idx: number) => (
              <circle
                cx={cx}
                cy={cy}
                r={5}
                fill={WIDTH_MODE_COLOR[mode]}
                stroke={HANDLE_FILL}
                strokeWidth={1.5}
                style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                onPointerDown={(e: React.PointerEvent) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setSelectedWidthIdx(idx)
                }}
                onDoubleClick={(e: React.MouseEvent) => {
                  e.preventDefault()
                  e.stopPropagation()
                  deleteWidthPoint(idx)
                }}
              />
            )
            return (
              <g>
                <path
                  d={bandD}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={16}
                  style={{ pointerEvents: 'stroke', cursor: 'crosshair' }}
                  onPointerDown={onWidthBandDown}
                />
                {pts.map((p, idx) => {
                  const samp = sampleFraction(widthArc, p.t)
                  if (!samp) return null
                  const nx = -samp.tangent.y
                  const ny = samp.tangent.x
                  const sc = toScreen(samp.point)
                  const sl = toScreen({ x: samp.point.x + nx * halfBase * p.l, y: samp.point.y + ny * halfBase * p.l })
                  const sr = toScreen({ x: samp.point.x - nx * halfBase * p.r, y: samp.point.y - ny * halfBase * p.r })
                  const col = WIDTH_MODE_COLOR[p.mode]
                  return (
                    <g key={`w${idx}`}>
                      <line x1={sl.x} y1={sl.y} x2={sr.x} y2={sr.y} stroke={col} strokeWidth={1} opacity={0.6} />
                      {idx === selectedWidthIdx && (
                        <circle
                          cx={sc.x}
                          cy={sc.y}
                          r={10}
                          fill="none"
                          stroke={SELECTION_STROKE}
                          strokeWidth={1.5}
                          strokeDasharray="2 3"
                          style={{ pointerEvents: 'none' }}
                        />
                      )}
                      {dot(p.mode, sc.x, sc.y, idx)}
                      <circle
                        cx={sl.x}
                        cy={sl.y}
                        r={4.5}
                        fill={HANDLE_FILL}
                        stroke={col}
                        strokeWidth={1.5}
                        style={{ pointerEvents: 'auto', cursor: 'grab' }}
                        onPointerDown={beginWidthHandleDrag(idx, 'l')}
                      />
                      <circle
                        cx={sr.x}
                        cy={sr.y}
                        r={4.5}
                        fill={HANDLE_FILL}
                        stroke={col}
                        strokeWidth={1.5}
                        style={{ pointerEvents: 'auto', cursor: 'grab' }}
                        onPointerDown={beginWidthHandleDrag(idx, 'r')}
                      />
                    </g>
                  )
                })}
              </g>
            )
          })()}
      </svg>
      {it.hint && pointer && <CursorHintChip x={pointer.x} y={pointer.y} icon={it.hint} />}
    </>
  )
}
