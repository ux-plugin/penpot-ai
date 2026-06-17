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
  segmentsToAnchors,
  segmentsToSvgPath,
  toggleAnchorSmooth,
  type Anchor,
  type Pt,
} from '../../renderer/geom/anchors'
import type { PathSegment } from '../../renderer/types'
import { HANDLE_FILL, SELECTION_STROKE } from './constants'

type DragKind = 'anchor' | 'in' | 'out'

/** Screen-px reach for the add-anchor hit band and hover ghost (half the band). */
const ADD_HIT_PX = 8

const cloneAnchor = (a: Anchor): Anchor => ({
  point: { x: a.point.x, y: a.point.y },
  ...(a.handleIn ? { handleIn: { x: a.handleIn.x, y: a.handleIn.y } } : {}),
  ...(a.handleOut ? { handleOut: { x: a.handleOut.x, y: a.handleOut.y } } : {}),
})

/** Full node-geometry partial for a set of edited anchors (segments + the AABB
 * that depends on them). Shared by the live render and the final commit. */
function geometryPartial(node: PenpotNode, anchors: Anchor[], closed: boolean): Partial<PenpotNode> {
  const b = anchorsBounds(anchors)
  // Preserve sibling content fields (e.g. cornerRadius) — only the segments change.
  const prevContent = (node as { content?: Record<string, unknown> }).content ?? {}
  return {
    ...node,
    content: { ...prevContent, segments: anchorsToSegments(anchors, closed) } as PenpotNode['content'],
    points: anchors.map((a) => ({ x: a.point.x, y: a.point.y })),
    selrect: { x: b.x, y: b.y, width: b.width, height: b.height, x1: b.x, y1: b.y, x2: b.x + b.width, y2: b.y + b.height },
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
  }
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

  // Live drag anchors belong to one shape+session; clear any leftover when the
  // edited shape changes or editing starts/stops.
  useEffect(() => {
    pathEditAnchors.value = null
    return () => {
      dragCleanupRef.current?.()
      pathEditAnchors.value = null
    }
  }, [shapeId, isPathEditing])

  const node = shapeId ? getCommittedNodeOnActivePage(shapeId) : null
  const segments =
    (node as { content?: { segments?: PathSegment[] } } | null)?.content?.segments ?? null
  const base = useMemo(
    () => (segments ? segmentsToAnchors(segments) : { anchors: [] as Anchor[], closed: false }),
    [segments],
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
      const { content, points, selrect, x, y, width, height } = geometryPartial(before, finalAnchors, closed)
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
    [shapeId],
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
        void renderer.updateShape(geometryPartial(node0, next, closed) as PenpotNode)
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
        if (moved) commit(apply(toWorld(ev), ev.altKey), closed)
        else pathEditAnchors.value = null
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
    [shapeId, base, commit],
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

  if (
    !isPathEditing ||
    !shapeId ||
    !viewport ||
    !node ||
    (node as { type?: string }).type !== 'path' ||
    !segments
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

  // Hover ghost: the point on the outline a click would split (hidden mid-drag).
  let ghost: { x: number; y: number } | null = null
  if (liveAnchors == null && pointer) {
    const hit = nearestPointOnPath(anchors, closed, screenToWorld(viewport, pointer.x, pointer.y))
    if (hit && hit.dist * (viewport.zoom ?? 1) <= ADD_HIT_PX) ghost = toScreen(hit.point)
  }

  return (
    <svg
      ref={svgRef}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}
    >
      <path
        d={hitPathD}
        fill="none"
        stroke="transparent"
        strokeWidth={ADD_HIT_PX * 2}
        style={{ pointerEvents: 'stroke', cursor: 'copy' }}
        onPointerMove={onHitMove}
        onPointerDown={onAddAnchor}
      />
      {anchors.map((a, i) => {
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
              r={i === selectedAnchor ? 6 : 5}
              fill={i === selectedAnchor ? SELECTION_STROKE : HANDLE_FILL}
              stroke={SELECTION_STROKE}
              strokeWidth={1.5}
              style={{ pointerEvents: 'auto', cursor: 'move' }}
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
  )
}
