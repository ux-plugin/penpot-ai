import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSelector } from '@xstate/react'
import { useSnapshot } from 'valtio'
import type { GridCell, GridTrack, PenpotNode } from 'penpot-exporter/types'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  ChevronDown,
  ChevronRight,
  Pin,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { applyTransformToNode } from '@/lib/renderer/geom/apply-transform-to-node'
import { rotationMatrixAroundPoint } from '@/lib/renderer/geom/matrix'
import { useCanvasActor } from '@/lib/renderer/machine/canvas-actor-context'
import {
  commitNodePartialUpdate,
  commitNodeGeometry,
  getCommittedNodeOnActivePage,
} from '@/lib/renderer/properties/commit-node-properties'
import { docProxy, getActiveOrSinglePageId } from '@/lib/renderer/store/doc-proxy'
import type { RectLikeNode } from '@/lib/renderer/properties/panel-utils'
import { rotatePreviewDeltaDeg as rotatePreviewDeltaDegSignal } from '@/lib/renderer/signals/pointer'
import { useSignalCoalesced } from '@/lib/renderer/signals/use-signal-coalesced'
import { getLayoutMode, type LayoutMode } from './layout-mode'
import { GridPlacementPicker, type Placement } from './GridPlacementPicker'
import { NumericField } from '../NumericField'

type Axis3 = 'start' | 'center' | 'end'

const VERTICAL_OPTIONS: ReadonlyArray<{
  value: Axis3
  Icon: typeof AlignStartHorizontal
  label: string
}> = [
  { value: 'start', Icon: AlignStartHorizontal, label: 'Top' },
  { value: 'center', Icon: AlignCenterHorizontal, label: 'Middle' },
  { value: 'end', Icon: AlignEndHorizontal, label: 'Bottom' },
]

const HORIZONTAL_OPTIONS: ReadonlyArray<{
  value: Axis3
  Icon: typeof AlignStartVertical
  label: string
}> = [
  { value: 'start', Icon: AlignStartVertical, label: 'Left' },
  { value: 'center', Icon: AlignCenterVertical, label: 'Center' },
  { value: 'end', Icon: AlignEndVertical, label: 'Right' },
]

export interface PositionSectionProps {
  nodeId: string
  initialNode: RectLikeNode
  readOnly: boolean
}

function findCellForChild(
  cells: Record<string, GridCell> | undefined,
  childId: string,
): { cellId: string; cell: GridCell } | null {
  if (!cells) return null
  for (const [cellId, cell] of Object.entries(cells)) {
    if (cell.shapes?.includes(childId)) return { cellId, cell }
  }
  return null
}

function generateCellId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36)
}

export function PositionSection({ nodeId, initialNode, readOnly }: PositionSectionProps) {
  const [collapsed, setCollapsed] = useState(false)

  const node = initialNode as RectLikeNode & { x?: number; y?: number }

  // NumericField owns each field's editing draft; we feed it committed values
  // and commit one axis at a time (commitGeomAxis) on Enter/blur/step.
  const x = node.x ?? 0
  const y = node.y ?? 0
  const rotation = initialNode.rotation ?? 0

  const canvasActor = useCanvasActor()
  const isMoving = useSelector(canvasActor, (s) => s.matches('moving'))
  const isRotating = useSelector(canvasActor, (s) => s.matches('rotating'))
  const rotatePreviewDeltaDeg = useSignalCoalesced(rotatePreviewDeltaDegSignal)

  const liveRotationPartial = useMemo((): Partial<PenpotNode> | null => {
    if (readOnly || !isRotating) return null
    const n = initialNode as PenpotNode
    const sr = n.selrect as
      | { x?: number; y?: number; width?: number; height?: number }
      | undefined
    if (!sr) return null
    const w0 = sr.width ?? 0
    const h0 = sr.height ?? 0
    if (w0 <= 0 || h0 <= 0) return null
    const cx = (sr.x ?? 0) + w0 / 2
    const cy = (sr.y ?? 0) + h0 / 2
    return applyTransformToNode(n, rotationMatrixAroundPoint(cx, cy, rotatePreviewDeltaDeg))
  }, [readOnly, initialNode, isRotating, rotatePreviewDeltaDeg])

  const rotationDisplay =
    liveRotationPartial != null && typeof liveRotationPartial.rotation === 'number'
      ? liveRotationPartial.rotation
      : rotation

  const fieldsDisabled = readOnly || isMoving || isRotating

  // Commit a single edited axis through the shared geometry pipeline. The other
  // axes are omitted from the target, so they hold at the committed value and
  // only the touched axis moves/rotates — emitted as a world-space transform so
  // a rotated shape's body, points and caret stay consistent (no drift).
  const commitGeomAxis = useCallback(
    async (axis: 'x' | 'y' | 'rotation', value: number) => {
      if (readOnly) return
      const before = getCommittedNodeOnActivePage(nodeId)
      const pid = getActiveOrSinglePageId()
      if (!before || !pid) return
      const target = axis === 'x' ? { x: value } : axis === 'y' ? { y: value } : { rotation: value }
      await commitNodeGeometry(nodeId, before, target, pid)
    },
    [readOnly, nodeId],
  )

  // Parent layout state — drives optional grid-placement + align-self UI.
  const doc = useSnapshot(docProxy)
  const parentId = (initialNode as { parentId?: string }).parentId
  const parentNode =
    parentId && doc.currentPageId
      ? (doc.pageMap.get(doc.currentPageId)?.objects[parentId] as PenpotNode | undefined)
      : undefined
  const parentMode: LayoutMode | null = parentNode
    ? getLayoutMode(parentNode as RectLikeNode)
    : null

  const parentGridCols =
    (parentNode as { layoutGridColumns?: GridTrack[] } | undefined)?.layoutGridColumns?.length ?? 1
  const parentGridRows =
    (parentNode as { layoutGridRows?: GridTrack[] } | undefined)?.layoutGridRows?.length ?? 1
  const parentCells =
    parentMode === 'grid'
      ? (parentNode as { layoutGridCells?: Record<string, GridCell> } | undefined)
          ?.layoutGridCells
      : undefined
  const cellEntry = findCellForChild(parentCells as Record<string, GridCell> | undefined, nodeId)
  const cell = cellEntry?.cell

  const placement: Placement = {
    fc: cell?.column ?? 1,
    fr: cell?.row ?? 1,
    tc: (cell?.column ?? 1) + Math.max(1, cell?.columnSpan ?? 1) - 1,
    tr: (cell?.row ?? 1) + Math.max(1, cell?.rowSpan ?? 1) - 1,
  }

  const commitGridCell = useCallback(
    async (patch: Partial<GridCell>) => {
      if (readOnly || !parentId || parentMode !== 'grid') return
      const parentBefore = getCommittedNodeOnActivePage(parentId)
      const pid = getActiveOrSinglePageId()
      if (!parentBefore || !pid) return
      const parentRec = parentBefore as { layoutGridCells?: Record<string, GridCell> }
      const cells: Record<string, GridCell> = { ...(parentRec.layoutGridCells ?? {}) }
      const existing = findCellForChild(cells, nodeId)
      const baseCell: GridCell = existing?.cell ?? {
        row: 1,
        rowSpan: 1,
        column: 1,
        columnSpan: 1,
        shapes: [nodeId],
      }
      const cellId = existing?.cellId ?? generateCellId()
      cells[cellId] = {
        ...baseCell,
        ...patch,
        shapes: baseCell.shapes ?? [nodeId],
      }
      await commitNodePartialUpdate(
        parentId,
        parentBefore,
        { layoutGridCells: cells } as Partial<PenpotNode>,
        pid,
      )
    },
    [readOnly, parentId, parentMode, nodeId],
  )

  const onPlacementChange = (next: Placement) => {
    void commitGridCell({
      column: next.fc,
      row: next.fr,
      columnSpan: next.tc - next.fc + 1,
      rowSpan: next.tr - next.fr + 1,
    })
  }

  // Flex parents have a single per-item axis (`layoutItemAlignSelf`, the cross
  // axis). Grid parents have two: cell.alignSelf (vertical) and cell.justifySelf
  // (horizontal). We expose start/center/end only — Penpot's `auto` and
  // `stretch` both visually fall back to start, so we drop them.
  const rawFlex = (initialNode as { layoutItemAlignSelf?: string }).layoutItemAlignSelf
  const flexAlign: Axis3 =
    rawFlex === 'center' || rawFlex === 'end' ? rawFlex : 'start'
  const rawCellV = cell?.alignSelf
  const cellAlign: Axis3 =
    rawCellV === 'center' || rawCellV === 'end' ? rawCellV : 'start'
  const rawCellH = cell?.justifySelf
  const cellJustify: Axis3 =
    rawCellH === 'center' || rawCellH === 'end' ? rawCellH : 'start'

  const [verticalDraft, setVerticalDraft] = useState<Axis3>(
    parentMode === 'grid' ? cellAlign : flexAlign,
  )
  const [horizontalDraft, setHorizontalDraft] = useState<Axis3>(cellJustify)

  useEffect(() => {
    setVerticalDraft(parentMode === 'grid' ? cellAlign : flexAlign)
    setHorizontalDraft(cellJustify)
  }, [parentMode, cellAlign, flexAlign, cellJustify])

  const commitVertical = useCallback(
    async (v: Axis3) => {
      if (readOnly || parentMode == null) return
      if (parentMode === 'grid') {
        await commitGridCell({ alignSelf: v as GridCell['alignSelf'] })
        return
      }
      const before = getCommittedNodeOnActivePage(nodeId)
      const pid = getActiveOrSinglePageId()
      if (!before || !pid) return
      await commitNodePartialUpdate(
        nodeId,
        before,
        { layoutItemAlignSelf: v } as unknown as Partial<PenpotNode>,
        pid,
      )
    },
    [readOnly, parentMode, nodeId, commitGridCell],
  )

  const commitHorizontal = useCallback(
    async (v: Axis3) => {
      if (readOnly || parentMode !== 'grid') return
      await commitGridCell({ justifySelf: v as GridCell['justifySelf'] })
    },
    [readOnly, parentMode, commitGridCell],
  )

  const onVertical = (v: Axis3) => {
    setVerticalDraft(v)
    void commitVertical(v)
  }
  const onHorizontal = (v: Axis3) => {
    setHorizontalDraft(v)
    void commitHorizontal(v)
  }

  const itemAbsolute =
    !!(initialNode as { layoutItemAbsolute?: boolean }).layoutItemAbsolute
  const [absoluteDraft, setAbsoluteDraft] = useState<boolean>(itemAbsolute)

  useEffect(() => {
    setAbsoluteDraft(itemAbsolute)
  }, [itemAbsolute])

  const onToggleAbsolute = useCallback(async () => {
    if (readOnly || parentMode == null) return
    const next = !absoluteDraft
    setAbsoluteDraft(next)
    const before = getCommittedNodeOnActivePage(nodeId)
    const pid = getActiveOrSinglePageId()
    if (!before || !pid) return
    await commitNodePartialUpdate(
      nodeId,
      before,
      { layoutItemAbsolute: next } as Partial<PenpotNode>,
      pid,
    )
  }, [readOnly, parentMode, nodeId, absoluteDraft])

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
            Position
          </button>
        </div>

        {!collapsed && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="rsp-x">X</Label>
                <NumericField
                  id="rsp-x"
                  disabled={fieldsDisabled}
                  value={Number.isFinite(x) ? x : 0}
                  onCommit={(n) => void commitGeomAxis('x', n)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rsp-y">Y</Label>
                <NumericField
                  id="rsp-y"
                  disabled={fieldsDisabled}
                  value={Number.isFinite(y) ? y : 0}
                  onCommit={(n) => void commitGeomAxis('y', n)}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="rsp-rot">Rotation (°)</Label>
              <NumericField
                id="rsp-rot"
                disabled={fieldsDisabled}
                value={Number.isFinite(rotationDisplay) ? rotationDisplay : 0}
                onCommit={(n) => void commitGeomAxis('rotation', n)}
              />
            </div>

            {parentMode != null && (
              <Button
                type="button"
                variant={absoluteDraft ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={absoluteDraft}
                aria-label={absoluteDraft ? 'Disable absolute position' : 'Enable absolute position'}
                title={absoluteDraft ? 'Disable absolute position' : 'Absolute position'}
                disabled={readOnly}
                onClick={() => void onToggleAbsolute()}
                className="w-full justify-center gap-1.5"
              >
                <Pin className="size-3.5" aria-hidden />
                Absolute position
              </Button>
            )}

            {parentMode === 'grid' && (
              <GridPlacementPicker
                cols={parentGridCols}
                rows={parentGridRows}
                value={placement}
                onChange={onPlacementChange}
                disabled={readOnly}
              />
            )}

            {parentMode != null && (
              <AxisRow
                label="Align self (vertical)"
                options={VERTICAL_OPTIONS}
                value={verticalDraft}
                onChange={onVertical}
                disabled={readOnly}
              />
            )}

            {parentMode === 'grid' && (
              <AxisRow
                label="Justify self (horizontal)"
                options={HORIZONTAL_OPTIONS}
                value={horizontalDraft}
                onChange={onHorizontal}
                disabled={readOnly}
              />
            )}
          </div>
        )}
      </div>
    </>
  )
}

function AxisRow({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string
  options: ReadonlyArray<{ value: Axis3; Icon: typeof AlignStartHorizontal; label: string }>
  value: Axis3
  onChange: (v: Axis3) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <div
        className="grid w-full gap-1 rounded-md bg-muted/60 p-1"
        style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}
      >
        {options.map(({ value: v, Icon, label: optLabel }) => {
          const active = v === value
          return (
            <Button
              key={v}
              type="button"
              variant={active ? 'secondary' : 'ghost'}
              size="icon-sm"
              aria-pressed={active}
              aria-label={optLabel}
              title={optLabel}
              disabled={disabled}
              onClick={() => onChange(v)}
              className="w-full"
            >
              <Icon className="size-3.5" aria-hidden />
            </Button>
          )
        })}
      </div>
    </div>
  )
}
