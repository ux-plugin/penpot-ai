import { useCallback, useEffect, useState } from 'react'
import { useSelector } from '@xstate/react'
import { useSnapshot } from 'valtio'
import type { PenpotNode } from 'penpot-exporter/types'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { useCanvasActor } from '@/lib/renderer/machine/canvas-actor-context'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  commitNodePartialUpdate,
  commitNodeGeometry,
  commitTextGrowType,
  getCommittedNodeOnActivePage,
} from '@/lib/renderer/properties/commit-node-properties'
import type { RectLikeNode } from '@/lib/renderer/properties/panel-utils'
import { docProxy, getActiveOrSinglePageId } from '@/lib/renderer/store/doc-proxy'
import { getLayoutMode, type LayoutMode } from './layout-mode'
import { isTextNode, pinGrowAxis } from './text-typography'
import { NumericField } from '../NumericField'

type GrowType = 'fixed' | 'auto-width' | 'auto-height'

const GROW_MODES: ReadonlyArray<{ value: GrowType; label: string }> = [
  { value: 'fixed', label: 'Fixed' },
  { value: 'auto-width', label: 'Auto width' },
  { value: 'auto-height', label: 'Auto height' },
]

type Corners = { r1: number; r2: number; r3: number; r4: number }
type Margin = { m1: number; m2: number; m3: number; m4: number }

export interface AppearanceSectionProps {
  nodeId: string
  initialNode: RectLikeNode
  readOnly: boolean
}

function isMultiCorners(c: Corners): boolean {
  return !(c.r1 === c.r2 && c.r2 === c.r3 && c.r3 === c.r4)
}

function isMultiMargin(m: Margin): boolean {
  return !(m.m1 === m.m2 && m.m2 === m.m3 && m.m3 === m.m4)
}

export function AppearanceSection({ nodeId, initialNode, readOnly }: AppearanceSectionProps) {
  const [collapsed, setCollapsed] = useState(false)

  const node = initialNode as RectLikeNode & {
    r1?: number
    r2?: number
    r3?: number
    r4?: number
    layoutItemMargin?: Partial<Margin>
  }

  // NumericField owns each field's editing draft; we only feed it the committed
  // values and receive clean numbers back on commit.
  const width = initialNode.width ?? 100
  const height = initialNode.height ?? 100

  const initialCorners: Corners = {
    r1: node.r1 ?? 0,
    r2: node.r2 ?? 0,
    r3: node.r3 ?? 0,
    r4: node.r4 ?? 0,
  }
  const [corners, setCorners] = useState<Corners>(initialCorners)
  const [cornersMulti, setCornersMulti] = useState<boolean>(isMultiCorners(initialCorners))

  // Opacity — stored 0..1 on the node, edited as 0–100 % (same
  // convention as fill opacity in FillRow).
  const committedOpacityPct = Math.round(
    (((initialNode as { opacity?: number }).opacity ?? 1) * 100),
  )

  const initialMargin: Margin = {
    m1: node.layoutItemMargin?.m1 ?? 0,
    m2: node.layoutItemMargin?.m2 ?? 0,
    m3: node.layoutItemMargin?.m3 ?? 0,
    m4: node.layoutItemMargin?.m4 ?? 0,
  }
  const [margin, setMargin] = useState<Margin>(initialMargin)
  const [marginMulti, setMarginMulti] = useState<boolean>(isMultiMargin(initialMargin))

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- mirror external snapshots */
    const c: Corners = {
      r1: node.r1 ?? 0,
      r2: node.r2 ?? 0,
      r3: node.r3 ?? 0,
      r4: node.r4 ?? 0,
    }
    setCorners(c)
    setCornersMulti(isMultiCorners(c))
    const m: Margin = {
      m1: node.layoutItemMargin?.m1 ?? 0,
      m2: node.layoutItemMargin?.m2 ?? 0,
      m3: node.layoutItemMargin?.m3 ?? 0,
      m4: node.layoutItemMargin?.m4 ?? 0,
    }
    setMargin(m)
    setMarginMulti(isMultiMargin(m))
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [node.r1, node.r2, node.r3, node.r4, node.layoutItemMargin])

  const canvasActor = useCanvasActor()
  const isMoving = useSelector(canvasActor, (s) => s.matches('moving'))
  const isRotating = useSelector(canvasActor, (s) => s.matches('rotating'))
  const fieldsDisabled = readOnly || isMoving || isRotating

  // Text auto-size (set in the "Auto resize" section near Position) decides
  // which W/H fields are renderer-controlled: auto-width computes both,
  // auto-height computes height (width stays the wrap width), fixed computes
  // neither. A computed dimension is shown read-only here.
  const isText = isTextNode(initialNode)

  // Corner radius is exposed only on frame-backed containers (`frame`, plus
  // `instance`/`component` which serialize as frames). In the path-composition
  // model a rectangle is just a closed path, so its corners are rounded as a
  // per-vertex fillet (P4) rather than via the `r1–r4` parameter; `image` and
  // the rect path both drop the dedicated control.
  const nodeType = (initialNode as { type?: string }).type
  const showRadius =
    nodeType === 'frame' ||
    nodeType === 'instance' ||
    nodeType === 'component'

  // Non-frame path nodes (triangle/polygon/star/pen) get a single shape-wide
  // corner radius (P4) — a per-vertex fillet applied to every corner. Hidden for
  // open lines with nothing to round (< 3 points).
  const pathContent = (initialNode as { content?: { cornerRadius?: number } }).content
  const pathPointCount = ((initialNode as { points?: unknown[] }).points ?? []).length
  const showPathRadius = nodeType === 'path' && pathPointCount >= 3
  const pathCornerRadius = pathContent?.cornerRadius ?? 0

  const growType = (initialNode as { growType?: string }).growType
  const mode = (growType as GrowType | undefined) ?? 'fixed'
  const widthComputed = isText && growType === 'auto-width'
  const heightComputed = isText && (growType === 'auto-width' || growType === 'auto-height')

  const commitGrow = useCallback(
    async (next: string) => {
      if (readOnly || next === mode) return
      const before = getCommittedNodeOnActivePage(nodeId)
      const pid = getActiveOrSinglePageId()
      if (!before || !pid) return
      await commitTextGrowType(nodeId, before, next as GrowType, pid)
    },
    [nodeId, readOnly, mode],
  )

  const commitSizeAxis = useCallback(
    async (axis: 'w' | 'h', value: number) => {
      if (readOnly) return
      const before = getCommittedNodeOnActivePage(nodeId)
      const pid = getActiveOrSinglePageId()
      if (!before || !pid) return
      const target = axis === 'w' ? { width: value } : { height: value }
      // Typing a dimension pins that text axis — it's no longer content-driven.
      const extra = isText
        ? ({ growType: pinGrowAxis((before as { growType?: string }).growType, axis) } as Partial<PenpotNode>)
        : undefined
      await commitNodeGeometry(nodeId, before, target, pid, extra)
    },
    [readOnly, nodeId, isText],
  )

  const commitCorners = useCallback(
    async (next: Corners) => {
      if (readOnly) return
      const before = getCommittedNodeOnActivePage(nodeId)
      const pid = getActiveOrSinglePageId()
      if (!before || !pid) return
      await commitNodePartialUpdate(
        nodeId,
        before,
        next as Partial<PenpotNode>,
        pid,
      )
    },
    [readOnly, nodeId],
  )

  const commitRadiusSingle = (n: number) => {
    const next: Corners = { r1: n, r2: n, r3: n, r4: n }
    setCorners(next)
    void commitCorners(next)
  }

  // Path corner radius: update the single `content.cornerRadius` overlay, keeping
  // the sharp `content.segments` intact. The renderer fillets at serialize time.
  const commitPathCornerRadius = useCallback(
    async (n: number) => {
      if (readOnly) return
      const before = getCommittedNodeOnActivePage(nodeId)
      const pid = getActiveOrSinglePageId()
      if (!before || !pid) return
      const prevContent = (before as { content?: Record<string, unknown> }).content ?? {}
      await commitNodePartialUpdate(
        nodeId,
        before,
        { content: { ...prevContent, cornerRadius: Math.max(0, n) } } as Partial<PenpotNode>,
        pid,
      )
    },
    [readOnly, nodeId],
  )
  const commitCornerSide = (key: keyof Corners, n: number) => {
    const next: Corners = { ...corners, [key]: n }
    setCorners(next)
    void commitCorners(next)
  }
  const onToggleCornersMulti = () => {
    setCornersMulti((prev) => {
      const next = !prev
      if (!next) {
        const v = corners.r1
        const c: Corners = { r1: v, r2: v, r3: v, r4: v }
        setCorners(c)
        void commitCorners(c)
      }
      return next
    })
  }

  const commitOpacity = useCallback(
    async (pct: number) => {
      if (readOnly) return
      const before = getCommittedNodeOnActivePage(nodeId)
      const pid = getActiveOrSinglePageId()
      if (!before || !pid) return
      await commitNodePartialUpdate(
        nodeId,
        before,
        { opacity: pct / 100 } as Partial<PenpotNode>,
        pid,
      )
    },
    [readOnly, nodeId],
  )

  // Margin — gated on parent layout.
  const doc = useSnapshot(docProxy)
  const parentId = (initialNode as { parentId?: string }).parentId
  const parentNode =
    parentId && doc.currentPageId
      ? (doc.pageMap.get(doc.currentPageId)?.objects[parentId] as PenpotNode | undefined)
      : undefined
  const parentMode: LayoutMode | null = parentNode
    ? getLayoutMode(parentNode as RectLikeNode)
    : null
  const showMargin = parentMode != null

  const commitMargin = useCallback(
    async (next: Margin) => {
      if (readOnly) return
      const before = getCommittedNodeOnActivePage(nodeId)
      const pid = getActiveOrSinglePageId()
      if (!before || !pid) return
      await commitNodePartialUpdate(
        nodeId,
        before,
        { layoutItemMargin: next } as Partial<PenpotNode>,
        pid,
      )
    },
    [readOnly, nodeId],
  )

  const commitMarginSingle = (n: number) => {
    const next: Margin = { m1: n, m2: n, m3: n, m4: n }
    setMargin(next)
    void commitMargin(next)
  }
  const commitMarginSide = (key: keyof Margin, n: number) => {
    const next: Margin = { ...margin, [key]: n }
    setMargin(next)
    void commitMargin(next)
  }
  const onToggleMarginMulti = () => {
    setMarginMulti((prev) => {
      const next = !prev
      if (!next) {
        const v = margin.m1
        const m: Margin = { m1: v, m2: v, m3: v, m4: v }
        setMargin(m)
        void commitMargin(m)
      }
      return next
    })
  }

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
            Appearance
          </button>
        </div>

        {!collapsed && (
          <div className="space-y-3">
            {isText && (
              <div className="space-y-1">
                <Label htmlFor="rsp-autosize">Auto resize</Label>
                <Select value={mode} onValueChange={commitGrow} disabled={readOnly}>
                  <SelectTrigger
                    id="rsp-autosize"
                    size="sm"
                    className="w-full min-w-0"
                    aria-label="Auto resize"
                  >
                    <SelectValue placeholder="Fixed" />
                  </SelectTrigger>
                  <SelectContent>
                    {GROW_MODES.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="rsp-w">W</Label>
                <NumericField
                  id="rsp-w"
                  value={Number.isFinite(width) ? width : 0}
                  min={1}
                  disabled={fieldsDisabled || widthComputed}
                  title={widthComputed ? 'Width is auto-sized (see Auto resize)' : undefined}
                  onCommit={(n) => void commitSizeAxis('w', n)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rsp-h">H</Label>
                <NumericField
                  id="rsp-h"
                  value={Number.isFinite(height) ? height : 0}
                  min={1}
                  disabled={fieldsDisabled || heightComputed}
                  title={heightComputed ? 'Height is auto-sized (see Auto resize)' : undefined}
                  onCommit={(n) => void commitSizeAxis('h', n)}
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="rsp-opacity">Opacity</Label>
              <NumericField
                id="rsp-opacity"
                value={committedOpacityPct}
                min={0}
                max={100}
                suffix="%"
                disabled={readOnly}
                onCommit={(n) => void commitOpacity(n)}
              />
            </div>

            {showRadius && (
              <SectionWithMultiToggle
                label="Radius"
                multi={cornersMulti}
                onToggleMulti={onToggleCornersMulti}
                toggleTitle="Independent corners"
                disabled={readOnly}
              >
                {cornersMulti ? (
                  <div className="grid grid-cols-2 gap-2">
                    <NumericField
                      id="rsp-r1"
                      prefix="⌜"
                      value={corners.r1}
                      min={0}
                      disabled={readOnly}
                      onCommit={(n) => commitCornerSide('r1', n)}
                    />
                    <NumericField
                      id="rsp-r2"
                      prefix="⌝"
                      value={corners.r2}
                      min={0}
                      disabled={readOnly}
                      onCommit={(n) => commitCornerSide('r2', n)}
                    />
                    <NumericField
                      id="rsp-r4"
                      prefix="⌞"
                      value={corners.r4}
                      min={0}
                      disabled={readOnly}
                      onCommit={(n) => commitCornerSide('r4', n)}
                    />
                    <NumericField
                      id="rsp-r3"
                      prefix="⌟"
                      value={corners.r3}
                      min={0}
                      disabled={readOnly}
                      onCommit={(n) => commitCornerSide('r3', n)}
                    />
                  </div>
                ) : (
                  <NumericField
                    id="rsp-radius"
                    value={corners.r1}
                    min={0}
                    suffix="px"
                    disabled={readOnly}
                    onCommit={(n) => commitRadiusSingle(n)}
                  />
                )}
              </SectionWithMultiToggle>
            )}

            {showPathRadius && (
              <div className="space-y-1">
                <Label htmlFor="rsp-corner-radius">Corner radius</Label>
                <NumericField
                  id="rsp-corner-radius"
                  value={pathCornerRadius}
                  min={0}
                  suffix="px"
                  disabled={readOnly}
                  onCommit={(n) => void commitPathCornerRadius(n)}
                />
              </div>
            )}

            {showMargin && (
              <SectionWithMultiToggle
                label="Margin"
                multi={marginMulti}
                onToggleMulti={onToggleMarginMulti}
                toggleTitle="Independent sides"
                disabled={readOnly}
              >
                {marginMulti ? (
                  <div className="grid grid-cols-2 gap-2">
                    <NumericField
                      id="rsp-m-t"
                      prefix="T"
                      value={margin.m1}
                      min={0}
                      disabled={readOnly}
                      onCommit={(n) => commitMarginSide('m1', n)}
                    />
                    <NumericField
                      id="rsp-m-r"
                      prefix="R"
                      value={margin.m2}
                      min={0}
                      disabled={readOnly}
                      onCommit={(n) => commitMarginSide('m2', n)}
                    />
                    <NumericField
                      id="rsp-m-b"
                      prefix="B"
                      value={margin.m3}
                      min={0}
                      disabled={readOnly}
                      onCommit={(n) => commitMarginSide('m3', n)}
                    />
                    <NumericField
                      id="rsp-m-l"
                      prefix="L"
                      value={margin.m4}
                      min={0}
                      disabled={readOnly}
                      onCommit={(n) => commitMarginSide('m4', n)}
                    />
                  </div>
                ) : (
                  <NumericField
                    id="rsp-m"
                    value={margin.m1}
                    min={0}
                    suffix="px"
                    disabled={readOnly}
                    onCommit={(n) => commitMarginSingle(n)}
                  />
                )}
              </SectionWithMultiToggle>
            )}
          </div>
        )}
      </div>
    </>
  )
}

function SectionWithMultiToggle({
  label,
  multi,
  onToggleMulti,
  toggleTitle,
  disabled,
  children,
}: {
  label: string
  multi: boolean
  onToggleMulti: () => void
  toggleTitle: string
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-pressed={multi}
          aria-label={toggleTitle}
          title={toggleTitle}
          disabled={disabled}
          onClick={onToggleMulti}
        >
          <span className="text-[10px] leading-none">{multi ? '⇶' : '≡'}</span>
        </Button>
      </div>
      {children}
    </div>
  )
}

