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

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useSelector } from '@xstate/react'
import { useSnapshot } from 'valtio'
import type { PenpotNode } from 'penpot-exporter/types'
import { useCanvasActor } from '../../renderer/machine/canvas-actor-context'
import { useSignalCoalesced } from '../../renderer/signals/use-signal-coalesced'
import { viewport as viewportSignal } from '../../renderer/signals/pointer'
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
  reflect,
  segmentsToAnchors,
  type Anchor,
  type Pt,
} from '../../renderer/geom/anchors'
import type { PathSegment } from '../../renderer/types'
import { HANDLE_FILL, SELECTION_STROKE } from './constants'

type DragKind = 'anchor' | 'in' | 'out'

const cloneAnchor = (a: Anchor): Anchor => ({
  point: { x: a.point.x, y: a.point.y },
  ...(a.handleIn ? { handleIn: { x: a.handleIn.x, y: a.handleIn.y } } : {}),
  ...(a.handleOut ? { handleOut: { x: a.handleOut.x, y: a.handleOut.y } } : {}),
})

/** Full node-geometry partial for a set of edited anchors (segments + the AABB
 * that depends on them). Shared by the live render and the final commit. */
function geometryPartial(node: PenpotNode, anchors: Anchor[], closed: boolean): Partial<PenpotNode> {
  const b = anchorsBounds(anchors)
  return {
    ...node,
    content: { segments: anchorsToSegments(anchors, closed) } as PenpotNode['content'],
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
  const svgRef = useRef<SVGSVGElement>(null)

  // Live drag anchors belong to one shape+session; clear any leftover when the
  // edited shape changes or the overlay (un)mounts, so a new session starts clean.
  useEffect(() => {
    pathEditAnchors.value = null
    return () => {
      pathEditAnchors.value = null
    }
  }, [shapeId])

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
      const svg = svgRef.current
      const vp = viewportSignal.value
      if (!svg || !vp || !shapeId) return
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

      const toWorld = (ev: { clientX: number; clientY: number }): Pt =>
        screenToWorld(vp, ev.clientX - rect.left, ev.clientY - rect.top)

      const apply = (world: Pt, alt: boolean): Anchor[] => {
        const next = start.map(cloneAnchor)
        const a = next[index]
        if (kind === 'anchor') {
          const dx = world.x - basePoint.x
          const dy = world.y - basePoint.y
          a.point = { x: world.x, y: world.y }
          if (baseIn) a.handleIn = { x: baseIn.x + dx, y: baseIn.y + dy }
          if (baseOut) a.handleOut = { x: baseOut.x + dx, y: baseOut.y + dy }
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

      const onMove = (ev: MouseEvent) => {
        const next = apply(toWorld(ev), ev.altKey)
        pathEditAnchors.value = next
        renderLive(next)
      }
      const onUp = (ev: MouseEvent) => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        commit(apply(toWorld(ev), ev.altKey), closed)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [shapeId, base, commit],
  )

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
  const toScreen = (p: Pt) => worldToScreen(viewport, p.x, p.y)

  return (
    <svg
      ref={svgRef}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}
    >
      {anchors.map((a, i) => {
        const ps = toScreen(a.point)
        return (
          <g key={i}>
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
            <rect
              x={ps.x - 4}
              y={ps.y - 4}
              width={8}
              height={8}
              fill={HANDLE_FILL}
              stroke={SELECTION_STROKE}
              strokeWidth={1.5}
              style={{ pointerEvents: 'auto', cursor: 'move' }}
              onPointerDown={beginDrag('anchor', i)}
            />
          </g>
        )
      })}
    </svg>
  )
}
