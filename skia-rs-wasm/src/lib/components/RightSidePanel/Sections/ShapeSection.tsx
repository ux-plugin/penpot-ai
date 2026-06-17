/**
 * Shape parameters for path-composition primitives — the param→geometry half of
 * the bidirectional sync. The recognized kind is derived from the node's
 * segments via `recognizeShape` (no stored overlay), and editing a parameter
 * regenerates the outline with `shapeOutline` at the shape's current bbox and
 * commits new `content`/`points`. Only kinds with editable params render here
 * (polygon → sides; star → points + inner ratio).
 */

import { useCallback, useMemo, useState } from 'react'
import { useSnapshot } from 'valtio'
import type { PenpotNode } from 'penpot-exporter/types'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  shapeOutline,
  translateSegments,
  outlineWorldPoints,
  type ParametricShapeKind,
} from '@/lib/renderer/geom/primitives'
import { recognizeShape } from '@/lib/renderer/geom/recognize-shape'
import {
  commitNodePartialUpdate,
  getCommittedNodeOnActivePage,
} from '@/lib/renderer/properties/commit-node-properties'
import type { RectLikeNode } from '@/lib/renderer/properties/panel-utils'
import { docProxy, getActiveOrSinglePageId } from '@/lib/renderer/store/doc-proxy'
import { NumericField } from '../NumericField'

interface ShapeSectionProps {
  nodeId: string
  initialNode: RectLikeNode
  readOnly?: boolean
}

type ParamInput = { sides?: number; points?: number; innerRatio?: number }

/** Build the `{ content, points }` partial for a regenerated outline at the node's bbox. */
function regenPartial(
  node: PenpotNode,
  kind: ParametricShapeKind,
  params: ParamInput,
): Partial<PenpotNode> {
  const sr = node.selrect
  const x = sr?.x ?? 0
  const y = sr?.y ?? 0
  const w = sr?.width ?? 0
  const h = sr?.height ?? 0
  const local = shapeOutline(kind, { width: w, height: h, ...params })
  // Preserve sibling content fields (e.g. cornerRadius) — only the segments change.
  const prevContent = (node as { content?: Record<string, unknown> }).content ?? {}
  return {
    content: { ...prevContent, segments: translateSegments(local, x, y) } as PenpotNode['content'],
    points: outlineWorldPoints(local, x, y),
  }
}

export function ShapeSection({ nodeId, initialNode, readOnly }: ShapeSectionProps) {
  // Subscribe to doc changes so the recognized params track undo/redo/resize.
  useSnapshot(docProxy)
  const live = (getCommittedNodeOnActivePage(nodeId) ?? (initialNode as PenpotNode)) as PenpotNode

  const recognized = useMemo(() => {
    const content = (live as { content?: { segments?: unknown[] } }).content
    if (live.type !== 'path' || !live.selrect || !content?.segments) return null
    return recognizeShape(
      content.segments as Parameters<typeof recognizeShape>[0],
      live.selrect,
    )
  }, [live])

  const [collapsed, setCollapsed] = useState(false)

  const commit = useCallback(
    async (kind: ParametricShapeKind, params: ParamInput) => {
      if (readOnly) return
      const before = getCommittedNodeOnActivePage(nodeId)
      const pid = getActiveOrSinglePageId()
      if (!before || !pid) return
      await commitNodePartialUpdate(nodeId, before, regenPartial(before, kind, params), pid)
    },
    [readOnly, nodeId],
  )

  // Only the parameterized kinds get a panel.
  if (!recognized || (recognized.kind !== 'polygon' && recognized.kind !== 'star')) {
    return null
  }
  const heading = recognized.kind === 'polygon' ? 'Polygon' : 'Star'
  // Controlled by the committed (recognized) params; NumericField owns the edit draft.
  const curSides = recognized.params.sides ?? 6
  const curPoints = recognized.params.points ?? 5
  const curRatio = recognized.params.innerRatio ?? 0.5

  return (
    <>
      <Separator />
      <div className="min-w-0 space-y-2">
        <div className="flex items-center justify-between gap-2 py-0.5">
          <button
            type="button"
            className="flex min-h-8 flex-1 items-center gap-1 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <ChevronRight className="size-3.5 shrink-0" aria-hidden />
            ) : (
              <ChevronDown className="size-3.5 shrink-0" aria-hidden />
            )}
            {heading}
          </button>
        </div>

        {!collapsed && recognized.kind === 'polygon' && (
          <div className="space-y-1">
            <Label htmlFor="rsp-poly-sides">Sides</Label>
            <NumericField
              id="rsp-poly-sides"
              value={curSides}
              min={3}
              max={60}
              step={1}
              precision={0}
              disabled={readOnly}
              onCommit={(n) => void commit('polygon', { sides: n })}
            />
          </div>
        )}

        {!collapsed && recognized.kind === 'star' && (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="rsp-star-points">Points</Label>
              <NumericField
                id="rsp-star-points"
                value={curPoints}
                min={3}
                max={60}
                step={1}
                precision={0}
                disabled={readOnly}
                onCommit={(n) => void commit('star', { points: n, innerRatio: curRatio })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rsp-star-ratio">Inner ratio</Label>
              <NumericField
                id="rsp-star-ratio"
                value={curRatio}
                min={0.05}
                max={0.95}
                step={0.05}
                precision={2}
                disabled={readOnly}
                onCommit={(r) => void commit('star', { points: curPoints, innerRatio: r })}
              />
            </div>
          </div>
        )}
      </div>
    </>
  )
}
