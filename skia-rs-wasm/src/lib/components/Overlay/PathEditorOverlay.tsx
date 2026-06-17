/**
 * Vector-edit overlay (C). Active while the canvas machine is in `pathEditing`
 * (entered by double-clicking a path node). Draws the editable anchors and their
 * bézier handles in screen space over the live WASM shape and lets you drag them:
 *
 *   - drag an anchor square → moves the point, carrying its handles rigidly;
 *   - drag a handle cap → reshapes the curve (the opposite handle mirrors, unless
 *     Alt is held for an asymmetric corner).
 *
 * During a drag the working anchors live in the `pathEditAnchors` signal and the
 * shape is repainted live via `renderer.updateShape` (no history frame); on
 * release a single `commitNodePartialUpdate` records one undoable edit. The shape
 * keeps its `path` type, so `recognizeShape` re-derives (or drops) the polygon/
 * star overlay from the committed geometry automatically — no stored type to sync.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSelector } from '@xstate/react'
import { useSnapshot } from 'valtio'
import { Link2, Move, Plus, Spline } from 'lucide-react'
import type { PenpotNode } from 'penpot-exporter/types'
import { useCanvasActor } from '../../renderer/machine/canvas-actor-context'
import { useSignalCoalesced } from '../../renderer/signals/use-signal-coalesced'
import { modAlt, pointerPos, viewport as viewportSignal } from '../../renderer/signals/pointer'
import { pathEditAnchors } from '../../renderer/signals/selection'
import { docProxy, getActiveOrSinglePageId } from '../../renderer/store/doc-proxy'
import { useWorkspaceStore } from '../../renderer/store/workspace-store'
import {
  commitNodePartialUpdate,
  getCommittedNodeOnActivePage,
} from '../../renderer/properties/commit-node-properties'
import { screenToWorld, worldToScreen } from '../../renderer/viewport'
import {
  anchorsBounds,
  anchorsToSegments,
  deleteAnchor,
  insertAnchorOnEdge,
  nearestPointOnPath,
  reflect,
  segmentsToSvgPath,
  toggleAnchorSmooth,
  type Anchor,
  type Pt,
} from '../../renderer/geom/anchors'
import { getSubpaths, compoundContent, type Subpath } from '../../renderer/geom/subpaths'
import { HANDLE_FILL, SELECTION_STROKE } from './constants'
import { CursorHintChip, type HintIcon } from '../CursorHint'
import { PEN_CURSOR } from '../cursors'

type DragKind = 'anchor' | 'in' | 'out'

/** Screen-px reach for the add-anchor hit band and hover ghost (half the band). */
const ADD_HIT_PX = 8
/** Screen-px radius around the opposite open end that closes the path. */
const CLOSE_HIT_PX = 12
/** UI chrome whose clicks must not be treated as canvas extend clicks. */
const UI_CHROME =
  'aside, button, input, textarea, select, [contenteditable], [role="dialog"], [role="menu"], [role="toolbar"]'

const cloneAnchor = (a: Anchor): Anchor => ({
  point: { x: a.point.x, y: a.point.y },
  ...(a.handleIn ? { handleIn: { x: a.handleIn.x, y: a.handleIn.y } } : {}),
  ...(a.handleOut ? { handleOut: { x: a.handleOut.x, y: a.handleOut.y } } : {}),
})

/** Node-geometry partial for the full set of sub-paths (compound). The bbox spans
 * every sub-path; content holds the sub-paths + their derived sharp segments. */
function recompose(node: PenpotNode, subpaths: Subpath[]): Partial<PenpotNode> {
  const allVerts = subpaths.flatMap((s) => s.vertices)
  const b = anchorsBounds(allVerts)
  // Preserve sibling content fields (e.g. cornerRadius); clear the single-path
  // mirror so a stale `vertices` can't shadow a multi-sub-path shape.
  const prevContent = (node as { content?: Record<string, unknown> }).content ?? {}
  return {
    ...node,
    content: {
      ...prevContent,
      vertices: undefined,
      closed: undefined,
      ...compoundContent(subpaths),
    } as PenpotNode['content'],
    points: allVerts.map((a) => ({ x: a.point.x, y: a.point.y })),
    selrect: { x: b.x, y: b.y, width: b.width, height: b.height, x1: b.x, y1: b.y, x2: b.x + b.width, y2: b.y + b.height },
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
  }
}

/** Build the node partial after editing one sub-path: replace sub-path `activeIdx`
 * with the edited anchors and recompose with the others (read from `node`). */
function partialForActive(
  node: PenpotNode,
  activeAnchors: Anchor[],
  activeClosed: boolean,
  activeIdx: number,
): Partial<PenpotNode> {
  const subs = getSubpaths((node as { content?: unknown }).content as Parameters<typeof getSubpaths>[0])
  const edited: Subpath = { vertices: activeAnchors, closed: activeClosed }
  if (subs.length === 0) subs.push(edited)
  else subs[Math.min(activeIdx, subs.length - 1)] = edited
  return recompose(node, subs)
}

/** Icon for what clicking / dragging will do at the current pointer, shown
 *  as an icon badge near the cursor (the per-element cursor styles agree). */
type PathIntent = 'add-vertex' | 'move-vertex' | 'move-handle' | 'close-path'
const PATH_INTENT_ICONS: Record<PathIntent, HintIcon> = {
  'add-vertex': Plus,
  'move-vertex': Move,
  'move-handle': Spline,
  'close-path': Link2,
}

export function PathEditorOverlay() {
  const canvasActor = useCanvasActor()
  const isPathEditing = useSelector(canvasActor, (s) => s.matches('pathEditing'))
  const shapeId = useSelector(canvasActor, (s) => s.context.pathEditingShapeId)
  // Re-render whenever the document changes so committed edits refresh the markers.
  useSnapshot(docProxy)
  const viewport = useSignalCoalesced(viewportSignal)
  const liveAnchors = useSignalCoalesced(pathEditAnchors)
  // Cursor (surface-relative px) drives the hover ghost showing where a click
  // would insert an anchor.
  const pointer = useSignalCoalesced(pointerPos)
  const svgRef = useRef<SVGSVGElement>(null)
  // Tear-down for the in-flight drag's window listeners + pointer capture. Held in
  // a ref so an exit (Esc / click-away → unmount) can release a stuck drag.
  const dragCleanupRef = useRef<(() => void) | null>(null)
  // The anchor selected by a click (the Delete/Backspace target), scoped to its
  // shape so a stale selection from another path is ignored — no effect reset
  // needed. `selectedAnchor` is the active index for the current shape.
  const [selected, setSelected] = useState<{ shapeId: string; index: number } | null>(null)
  const selectedAnchor = selected && selected.shapeId === shapeId ? selected.index : null

  // The active sub-path index (compound paths), scoped to its shape.
  const [activeSub, setActiveSub] = useState<{ shapeId: string; index: number } | null>(null)
  // Which open end (if any) we're continuing to draw from, scoped to its shape.
  const [extend, setExtend] = useState<{ shapeId: string; end: 'start' | 'end' } | null>(null)
  const extendFrom = isPathEditing && extend && extend.shapeId === shapeId ? extend.end : null
  // Cursor world point while extending (drives the trailing preview segment).
  const [extendCursor, setExtendCursor] = useState<Pt | null>(null)

  // Live drag anchors belong to one shape+session; clear any leftover (and any
  // extend session) when the edited shape changes or editing starts/stops.
  useEffect(() => {
    pathEditAnchors.value = null
    /* eslint-disable react-hooks/set-state-in-effect -- reset on shape/mode change */
    setExtend(null)
    setActiveSub(null)
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => {
      dragCleanupRef.current?.()
      pathEditAnchors.value = null
    }
  }, [shapeId, isPathEditing])

  const node = shapeId ? getCommittedNodeOnActivePage(shapeId) : null
  // Compound paths: read all sub-paths; edit the active one. Most ops keep
  // working on a single ring (`base`), and commit recomposes with the others.
  const content = (node as { content?: unknown } | null)?.content
  const allSubpaths = useMemo(
    () => getSubpaths(content as Parameters<typeof getSubpaths>[0]),
    [content],
  )
  const activeIdx =
    allSubpaths.length === 0
      ? 0
      : Math.min(activeSub?.shapeId === shapeId ? activeSub.index : 0, allSubpaths.length - 1)
  const base = useMemo(
    () => ({
      anchors: (allSubpaths[activeIdx]?.vertices ?? []) as Anchor[],
      closed: allSubpaths[activeIdx]?.closed ?? false,
    }),
    [allSubpaths, activeIdx],
  )

  const commit = useCallback(
    (finalAnchors: Anchor[], closed: boolean) => {
      if (!shapeId || finalAnchors.length === 0) {
        pathEditAnchors.value = null
        return
      }
      const before = getCommittedNodeOnActivePage(shapeId)
      const pid = getActiveOrSinglePageId()
      if (!before || !pid) {
        pathEditAnchors.value = null
        return
      }
      const { content, points, selrect, x, y, width, height } = partialForActive(before, finalAnchors, closed, activeIdx)
      // Keep the dragged anchors on screen until the commit lands, then clear the
      // live signal — the re-render then reads the just-committed geometry, which
      // matches, so the markers don't flash back to their pre-drag positions.
      void commitNodePartialUpdate(
        shapeId,
        before,
        { content, points, selrect, x, y, width, height },
        pid,
      ).then(() => {
        pathEditAnchors.value = null
      })
    },
    [shapeId, activeIdx],
  )

  const beginDrag = useCallback(
    (kind: DragKind, index: number) => (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (kind === 'anchor' && shapeId) setSelected({ shapeId, index })
      const svg = svgRef.current
      const vp = viewportSignal.value
      if (!svg || !vp || !shapeId) return
      // Defensively end any previous drag whose pointer-up we somehow missed.
      dragCleanupRef.current?.()
      const rect = svg.getBoundingClientRect()
      const node0 = getCommittedNodeOnActivePage(shapeId)
      if (!node0) return
      const closed = base.closed
      const start = (pathEditAnchors.value ?? base.anchors).map(cloneAnchor)
      const grabbed = start[index]
      if (!grabbed) return
      const basePoint = { ...grabbed.point }
      const baseIn = grabbed.handleIn ? { ...grabbed.handleIn } : null
      const baseOut = grabbed.handleOut ? { ...grabbed.handleOut } : null
      // Alt-drag a point pulls a fresh symmetric handle pair out of it instead of
      // moving it (corner → smooth) — the way to bend a segment that has none.
      // Decided on the first move (not pointerdown) and from both the event and
      // the app's tracked Alt state, so pressing the dot then holding Alt works.
      let bend = false
      let bendDecided = false
      // A pure click (e.g. one half of a double-click) produces no move; skip its
      // commit so it doesn't push a no-op undo frame.
      let moved = false
      const pointerId = e.pointerId
      // Capture on the stable svg root (not the marker, which re-renders mid-drag)
      // so pointermove/up land reliably even when the cursor leaves the marker.
      try {
        svg.setPointerCapture(pointerId)
      } catch {
        /* capture is best-effort */
      }

      const toWorld = (ev: { clientX: number; clientY: number }): Pt =>
        screenToWorld(vp, ev.clientX - rect.left, ev.clientY - rect.top)

      const apply = (world: Pt, alt: boolean): Anchor[] => {
        const next = start.map(cloneAnchor)
        const a = next[index]
        if (kind === 'anchor') {
          if (bend) {
            // Point stays put; pull a symmetric handle pair toward the cursor.
            a.handleOut = { x: world.x, y: world.y }
            a.handleIn = reflect(basePoint, a.handleOut)
          } else {
            const dx = world.x - basePoint.x
            const dy = world.y - basePoint.y
            a.point = { x: world.x, y: world.y }
            if (baseIn) a.handleIn = { x: baseIn.x + dx, y: baseIn.y + dy }
            if (baseOut) a.handleOut = { x: baseOut.x + dx, y: baseOut.y + dy }
          }
        } else if (kind === 'out') {
          a.handleOut = { x: world.x, y: world.y }
          if (!alt && a.handleIn) a.handleIn = reflect(a.point, a.handleOut)
        } else {
          a.handleIn = { x: world.x, y: world.y }
          if (!alt && a.handleOut) a.handleOut = reflect(a.point, a.handleIn)
        }
        return next
      }

      const renderLive = (next: Anchor[]) => {
        const renderer = useWorkspaceStore.getState().renderer
        if (!renderer) return
        void renderer.updateShape(partialForActive(node0, next, closed, activeIdx) as PenpotNode)
      }

      function onMove(ev: PointerEvent) {
        if (ev.pointerId !== pointerId) return
        if (!bendDecided) {
          bend = kind === 'anchor' && (ev.altKey || modAlt.value)
          bendDecided = true
        }
        moved = true
        const next = apply(toWorld(ev), ev.altKey)
        pathEditAnchors.value = next
        renderLive(next)
      }
      function onUp(ev: PointerEvent) {
        if (ev.pointerId !== pointerId) return
        cleanup()
        if (moved) {
          commit(apply(toWorld(ev), ev.altKey), closed)
          return
        }
        pathEditAnchors.value = null
        // A plain click on an OPEN end starts (or toggles off) continuing the
        // path from it — the pen-style "click an open end to keep drawing".
        if (kind === 'anchor' && !closed && shapeId && (index === 0 || index === start.length - 1)) {
          const end: 'start' | 'end' = index === 0 ? 'start' : 'end'
          setExtend((prev) =>
            prev && prev.end === end && prev.shapeId === shapeId ? null : { shapeId, end },
          )
          setExtendCursor(null)
        }
      }
      function cleanup() {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        try {
          svg.releasePointerCapture(pointerId)
        } catch {
          /* already released */
        }
        dragCleanupRef.current = null
      }

      // Pointer (not mouse) events: pointerup fires reliably under capture, and
      // preventDefault on pointerdown doesn't suppress it the way it does the
      // compatibility mouseup. cleanup() removes them, so nothing leaks.
      dragCleanupRef.current = cleanup
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [shapeId, base, commit, activeIdx],
  )

  // Keep the cursor signal fresh while over the (pointer-events) hit band so the
  // hover ghost tracks even there — the surface below can't see those moves.
  const onHitMove = useCallback((e: React.PointerEvent) => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    pointerPos.value = { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }, [])

  // Insert an anchor where the cursor meets the outline (the spot the ghost
  // previews). stopPropagation keeps the surface from treating this as click-away.
  const onAddAnchor = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const svg = svgRef.current
      const vp = viewportSignal.value
      if (!svg || !vp || !shapeId) return
      const rect = svg.getBoundingClientRect()
      const world = screenToWorld(vp, e.clientX - rect.left, e.clientY - rect.top)
      const cur = pathEditAnchors.value ?? base.anchors
      const hit = nearestPointOnPath(cur, base.closed, world)
      if (!hit || hit.dist * (vp.zoom ?? 1) > ADD_HIT_PX) return
      const nextAnchors = insertAnchorOnEdge(cur, base.closed, hit.edge, hit.t)
      // Show the new dot immediately (the outline itself is unchanged by the
      // split); commit clears the live signal once the doc holds the new anchor.
      pathEditAnchors.value = nextAnchors
      setSelected(null) // indices shifted by the insert
      commit(nextAnchors, base.closed)
    },
    [shapeId, base, commit],
  )

  // Double-click a point to toggle corner ↔ smooth — the modifier-free way to
  // bend a corner (round it) or sharpen a smooth point.
  const onToggleSmooth = useCallback(
    (index: number) => (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const cur = pathEditAnchors.value ?? base.anchors
      const next = toggleAnchorSmooth(cur, base.closed, index)
      pathEditAnchors.value = next
      commit(next, base.closed)
    },
    [base, commit],
  )

  // Delete the selected anchor (rejoining its neighbours). Refused — and thus a
  // no-op — when it would drop the path below a viable point count.
  const deleteSelected = useCallback(() => {
    if (selectedAnchor == null || !shapeId) return
    const cur = pathEditAnchors.value ?? base.anchors
    if (selectedAnchor >= cur.length) {
      setSelected(null)
      return
    }
    const next = deleteAnchor(cur, base.closed, selectedAnchor)
    setSelected(null)
    if (next.length === cur.length) return
    pathEditAnchors.value = next
    commit(next, base.closed)
  }, [selectedAnchor, shapeId, base, commit])

  // Delete / Backspace removes the selected anchor while editing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (selectedAnchor == null || !isPathEditing) return
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) return
      e.preventDefault()
      deleteSelected()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedAnchor, isPathEditing, deleteSelected])

  // Extend mode: continue the open path from one end. A canvas click appends a
  // vertex to that end; clicking the OTHER open end closes the path; Esc/Enter
  // stops extending (without leaving edit mode).
  useEffect(() => {
    if (!extendFrom || !shapeId) return
    const screenOf = (e: MouseEvent, svg: SVGSVGElement) => {
      const r = svg.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const onMove = (e: MouseEvent) => {
      const svg = svgRef.current
      const vp = viewportSignal.value
      if (!svg || !vp) return
      const s = screenOf(e, svg)
      setExtendCursor(screenToWorld(vp, s.x, s.y))
    }
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      if ((e.target as Element | null)?.closest(UI_CHROME)) return // panel/buttons
      const svg = svgRef.current
      const vp = viewportSignal.value
      if (!svg || !vp) return
      // pointerdown (capture) beats the overlay's React handlers; stopPropagation
      // keeps the click from the add-band / markers and the surface click-away.
      e.preventDefault()
      e.stopPropagation()
      const s = screenOf(e, svg)
      const src = (pathEditAnchors.value ?? base.anchors) as Anchor[]
      if (src.length === 0) return
      const otherI = extendFrom === 'end' ? 0 : src.length - 1

      // If the click lands on an existing vertex, snap to it instead of dropping
      // a new node on top: the OTHER open end closes the path; any other vertex
      // (the active end or an interior point) is a no-op.
      let nearestI = -1
      let nearestD = Infinity
      for (let i = 0; i < src.length; i++) {
        const sp = worldToScreen(vp, src[i].point.x, src[i].point.y)
        const d = Math.hypot(s.x - sp.x, s.y - sp.y)
        if (d < nearestD) {
          nearestD = d
          nearestI = i
        }
      }
      if (nearestD <= CLOSE_HIT_PX) {
        if (nearestI === otherI && src.length >= 2) {
          setExtend(null)
          setExtendCursor(null)
          setSelected(null)
          commit(src, true) // link the two open ends → close
        }
        return
      }

      // Otherwise place a new vertex at the click; a click-drag pulls a symmetric
      // bézier handle out of it (the pen-tool gesture), a plain click is a corner.
      const world = screenToWorld(vp, s.x, s.y)
      const node0 = getCommittedNodeOnActivePage(shapeId)
      let working: Anchor[] = extendFrom === 'end' ? [...src, { point: { ...world } }] : [{ point: { ...world } }, ...src]
      const newIdx = extendFrom === 'end' ? working.length - 1 : 0
      pathEditAnchors.value = working
      setSelected(null)

      const pid = e.pointerId
      let dragging = false
      try {
        svg.setPointerCapture(pid)
      } catch {
        /* best effort */
      }
      const dragMove = (me: PointerEvent) => {
        if (me.pointerId !== pid) return
        const ms = screenOf(me, svg)
        if (!dragging && Math.hypot(ms.x - s.x, ms.y - s.y) > 4) dragging = true
        if (!dragging) return
        const w = screenToWorld(viewportSignal.value ?? vp, ms.x, ms.y)
        const pt = working[newIdx].point
        const nv = working.map(cloneAnchor)
        nv[newIdx] = { point: { x: pt.x, y: pt.y }, handleOut: { x: w.x, y: w.y }, handleIn: reflect(pt, w) }
        working = nv
        pathEditAnchors.value = working
        const r = useWorkspaceStore.getState().renderer
        if (r && node0) void r.updateShape(partialForActive(node0, working, false, activeIdx) as PenpotNode)
      }
      const dragUp = (ue: PointerEvent) => {
        if (ue.pointerId !== pid) return
        window.removeEventListener('pointermove', dragMove)
        window.removeEventListener('pointerup', dragUp)
        try {
          svg.releasePointerCapture(pid)
        } catch {
          /* already released */
        }
        commit(working, false)
      }
      window.addEventListener('pointermove', dragMove)
      window.addEventListener('pointerup', dragUp)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === 'NumpadEnter') {
        e.preventDefault()
        e.stopPropagation()
        setExtend(null)
        setExtendCursor(null)
      }
    }
    // pointerdown fires before mousedown; the surface's click-away listens on
    // mousedown, so also block that (capture) to stay in edit mode.
    const blockSurface = (e: MouseEvent) => {
      if (e.button !== 0) return
      if ((e.target as Element | null)?.closest(UI_CHROME)) return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('mousedown', blockSurface, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('mousedown', blockSurface, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [extendFrom, shapeId, base, commit, activeIdx])

  if (
    !isPathEditing ||
    !shapeId ||
    !viewport ||
    !node ||
    (node as { type?: string }).type !== 'path' ||
    allSubpaths.length === 0
  ) {
    return null
  }

  const anchors = liveAnchors ?? base.anchors
  const closed = base.closed
  const toScreen = (p: Pt) => worldToScreen(viewport, p.x, p.y)

  // Screen-space `d` for the invisible hit band along the outline (catches near-
  // outline clicks to add an anchor; clicks elsewhere fall through to exit).
  const screenAnchors: Anchor[] = anchors.map((a) => ({
    point: toScreen(a.point),
    ...(a.handleIn ? { handleIn: toScreen(a.handleIn) } : {}),
    ...(a.handleOut ? { handleOut: toScreen(a.handleOut) } : {}),
  }))
  const hitPathD = segmentsToSvgPath(anchorsToSegments(screenAnchors, closed))

  // Hover ghost: the point on the outline a click would split (hidden mid-drag
  // and while extending).
  let ghost: { x: number; y: number } | null = null
  if (liveAnchors == null && pointer && !extendFrom) {
    const hit = nearestPointOnPath(anchors, closed, screenToWorld(viewport, pointer.x, pointer.y))
    if (hit && hit.dist * (viewport.zoom ?? 1) <= ADD_HIT_PX) ghost = toScreen(hit.point)
  }

  // Open-end / extend roles for the markers.
  const nVerts = anchors.length
  const openEnds = closed || nVerts === 0 ? [] : nVerts === 1 ? [0] : [0, nVerts - 1]
  const activeEndIdx = extendFrom === 'end' ? nVerts - 1 : extendFrom === 'start' ? 0 : -1
  let closeTargetIdx = -1
  if (extendFrom && extendCursor && nVerts >= 2) {
    const otherIdx = extendFrom === 'end' ? 0 : nVerts - 1
    const o = toScreen(anchors[otherIdx].point)
    const c = toScreen(extendCursor)
    if (Math.hypot(c.x - o.x, c.y - o.y) <= CLOSE_HIT_PX) closeTargetIdx = otherIdx
  }

  // Current pointer intention -> hint chip near the cursor.
  let intent: PathIntent | null = null
  if (pointer) {
    if (extendFrom) {
      intent = closeTargetIdx >= 0 ? 'close-path' : 'add-vertex'
    } else {
      let nearHandle = Infinity
      let nearAnchor = Infinity
      for (const a of screenAnchors) {
        nearAnchor = Math.min(nearAnchor, Math.hypot(pointer.x - a.point.x, pointer.y - a.point.y))
        if (a.handleIn) nearHandle = Math.min(nearHandle, Math.hypot(pointer.x - a.handleIn.x, pointer.y - a.handleIn.y))
        if (a.handleOut) nearHandle = Math.min(nearHandle, Math.hypot(pointer.x - a.handleOut.x, pointer.y - a.handleOut.y))
      }
      if (nearHandle <= 7) intent = 'move-handle'
      else if (nearAnchor <= 10) intent = 'move-vertex'
      else if (ghost) intent = 'add-vertex'
    }
  }

  return (
    <>
    <svg
      ref={svgRef}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}
    >
      <path
        d={hitPathD}
        fill="none"
        stroke="transparent"
        strokeWidth={ADD_HIT_PX * 2}
        style={{ pointerEvents: 'stroke', cursor: PEN_CURSOR }}
        onPointerMove={onHitMove}
        onPointerDown={onAddAnchor}
      />
      {/* The editable skeleton: links the vertices (sharp, pre-fillet) so the
          structure stays visible on top of the rounded rendered shape. */}
      <path
        d={hitPathD}
        fill="none"
        stroke={SELECTION_STROKE}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.85}
        style={{ pointerEvents: 'none' }}
      />
      {/* Other sub-paths: dimmed skeletons with clickable dots to activate one. */}
      {allSubpaths.map((sp, si) => {
        if (si === activeIdx || sp.vertices.length === 0) return null
        const sa: Anchor[] = sp.vertices.map((a) => ({
          point: toScreen(a.point),
          ...(a.handleIn ? { handleIn: toScreen(a.handleIn) } : {}),
          ...(a.handleOut ? { handleOut: toScreen(a.handleOut) } : {}),
        }))
        const d = segmentsToSvgPath(anchorsToSegments(sa, sp.closed))
        return (
          <g key={`sub${si}`} opacity={0.45}>
            <path
              d={d}
              fill="none"
              stroke={SELECTION_STROKE}
              strokeWidth={1.25}
              strokeLinejoin="round"
              strokeLinecap="round"
              style={{ pointerEvents: 'none' }}
            />
            {sp.vertices.map((a, vi) => {
              const ps = toScreen(a.point)
              return (
                <circle
                  key={vi}
                  cx={ps.x}
                  cy={ps.y}
                  r={4}
                  fill={HANDLE_FILL}
                  stroke={SELECTION_STROKE}
                  strokeWidth={1.25}
                  style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                  onPointerDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    if (shapeId) setActiveSub({ shapeId, index: si })
                  }}
                />
              )
            })}
          </g>
        )
      })}
      {extendFrom && extendCursor && activeEndIdx >= 0 && (() => {
        const a = toScreen(anchors[activeEndIdx].point)
        const c = toScreen(extendCursor)
        return (
          <g>
            <line
              x1={a.x}
              y1={a.y}
              x2={c.x}
              y2={c.y}
              stroke={SELECTION_STROKE}
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
            {closeTargetIdx < 0 && (
              <circle cx={c.x} cy={c.y} r={4} fill={HANDLE_FILL} stroke={SELECTION_STROKE} strokeWidth={1.25} />
            )}
          </g>
        )
      })()}
      {anchors.map((a, i) => {
        const isOpenEnd = openEnds.includes(i)
        const isActiveEnd = i === activeEndIdx
        const isCloseTarget = i === closeTargetIdx
        const ps = toScreen(a.point)
        return (
          <g key={i}>
            {/* Invisible larger grab area (kept below the handle caps so short
                handles stay grabbable) so a near-miss grabs the anchor instead of
                the add-anchor band that runs along the same outline. */}
            <circle
              cx={ps.x}
              cy={ps.y}
              r={10}
              fill="transparent"
              style={{ pointerEvents: 'auto', cursor: 'move' }}
              onPointerDown={beginDrag('anchor', i)}
              onDoubleClick={onToggleSmooth(i)}
            />
            {(['handleIn', 'handleOut'] as const).map((side) => {
              const h = a[side]
              if (!h) return null
              const hs = toScreen(h)
              return (
                <g key={side}>
                  <line x1={ps.x} y1={ps.y} x2={hs.x} y2={hs.y} stroke={SELECTION_STROKE} strokeWidth={1} />
                  <circle
                    cx={hs.x}
                    cy={hs.y}
                    r={4}
                    fill={HANDLE_FILL}
                    stroke={SELECTION_STROKE}
                    strokeWidth={1.5}
                    style={{ pointerEvents: 'auto', cursor: 'grab' }}
                    onPointerDown={beginDrag(side === 'handleIn' ? 'in' : 'out', i)}
                  />
                </g>
              )
            })}
            <circle
              cx={ps.x}
              cy={ps.y}
              r={isCloseTarget ? 7 : i === selectedAnchor || isActiveEnd ? 6 : 5}
              // Active end / close target / selection fill in; open ends get a
              // thicker ring (continue-from-here cue).
              fill={isCloseTarget || isActiveEnd || i === selectedAnchor ? SELECTION_STROKE : HANDLE_FILL}
              stroke={SELECTION_STROKE}
              strokeWidth={isOpenEnd ? 2.25 : 1.5}
              style={{ pointerEvents: 'auto', cursor: isOpenEnd ? 'crosshair' : 'move' }}
              onPointerDown={beginDrag('anchor', i)}
              onDoubleClick={onToggleSmooth(i)}
            />
          </g>
        )
      })}
      {ghost && (
        <circle
          cx={ghost.x}
          cy={ghost.y}
          r={5}
          fill="none"
          stroke={SELECTION_STROKE}
          strokeWidth={1.5}
          strokeDasharray="3 2"
          style={{ pointerEvents: 'none' }}
        />
      )}
    </svg>
      {intent && pointer && (
        <CursorHintChip x={pointer.x} y={pointer.y} icon={PATH_INTENT_ICONS[intent]} />
      )}
    </>
  )
}
