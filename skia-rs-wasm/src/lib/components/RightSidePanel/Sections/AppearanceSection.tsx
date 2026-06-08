import { useCallback, useEffect, useState } from 'react'
import { useSelector } from '@xstate/react'
import { useSnapshot } from 'valtio'
import type { PenpotNode } from 'penpot-exporter/types'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  commitTextGrowType,
  getCommittedNodeOnActivePage,
  rectLayoutPartial,
} from '@/lib/renderer/properties/commit-node-properties'
import type { RectLikeNode } from '@/lib/renderer/properties/panel-utils'
import { docProxy, getActiveOrSinglePageId } from '@/lib/renderer/store/doc-proxy'
import { getLayoutMode, type LayoutMode } from './layout-mode'
import { isTextNode, pinGrowAxis } from './text-typography'

type GrowType = 'fixed' | 'auto-width' | 'auto-height'

const GROW_MODES: ReadonlyArray<{ value: GrowType; label: string }> = [
  { value: 'fixed', label: 'Fixed' },
  { value: 'auto-width', label: 'Auto width' },
  { value: 'auto-height', label: 'Auto height' },
]

type SizeDraft = { width: number; height: number }
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
  const [draft, setDraft] = useState<SizeDraft | null>(null)

  const node = initialNode as RectLikeNode & {
    r1?: number
    r2?: number
    r3?: number
    r4?: number
    layoutItemMargin?: Partial<Margin>
  }

  const committed: SizeDraft = {
    width: initialNode.width ?? 100,
    height: initialNode.height ?? 100,
  }
  const { width, height } = draft ?? committed

  const initialCorners: Corners = {
    r1: node.r1 ?? 0,
    r2: node.r2 ?? 0,
    r3: node.r3 ?? 0,
    r4: node.r4 ?? 0,
  }
  const [corners, setCorners] = useState<Corners>(initialCorners)
  const [cornersMulti, setCornersMulti] = useState<boolean>(isMultiCorners(initialCorners))

  const [radiusDraft, setRadiusDraft] = useState<string | null>(null)
  const [r1Draft, setR1Draft] = useState<string | null>(null)
  const [r2Draft, setR2Draft] = useState<string | null>(null)
  const [r3Draft, setR3Draft] = useState<string | null>(null)
  const [r4Draft, setR4Draft] = useState<string | null>(null)

  const initialMargin: Margin = {
    m1: node.layoutItemMargin?.m1 ?? 0,
    m2: node.layoutItemMargin?.m2 ?? 0,
    m3: node.layoutItemMargin?.m3 ?? 0,
    m4: node.layoutItemMargin?.m4 ?? 0,
  }
  const [margin, setMargin] = useState<Margin>(initialMargin)
  const [marginMulti, setMarginMulti] = useState<boolean>(isMultiMargin(initialMargin))
  const [marginDraft, setMarginDraft] = useState<string | null>(null)
  const [mTopDraft, setMTopDraft] = useState<string | null>(null)
  const [mRightDraft, setMRightDraft] = useState<string | null>(null)
  const [mBottomDraft, setMBottomDraft] = useState<string | null>(null)
  const [mLeftDraft, setMLeftDraft] = useState<string | null>(null)

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

  const commitSize = useCallback(
    async (axis: 'w' | 'h') => {
      if (readOnly || !draft) return
      const before = getCommittedNodeOnActivePage(nodeId)
      const pid = getActiveOrSinglePageId()
      if (!before || !pid) return
      const x = (before as { x?: number }).x ?? 0
      const y = (before as { y?: number }).y ?? 0
      const rot = (before as { rotation?: number }).rotation ?? 0
      let partial: Partial<PenpotNode> = rectLayoutPartial(x, y, draft.width, draft.height, rot)
      if (isText) {
        // Typing a dimension pins that axis — it's no longer content-driven.
        const grow = pinGrowAxis((before as { growType?: string }).growType, axis)
        partial = { ...partial, growType: grow }
      }
      await commitNodePartialUpdate(nodeId, before, partial, pid)
      setDraft(null)
    },
    [readOnly, nodeId, draft, isText],
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

  const commitRadiusSingle = (raw: string) => {
    const n = Math.max(0, parseFloat(raw) || 0)
    const next: Corners = { r1: n, r2: n, r3: n, r4: n }
    setCorners(next)
    void commitCorners(next)
  }
  const commitCornerSide = (key: keyof Corners, raw: string) => {
    const n = Math.max(0, parseFloat(raw) || 0)
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

  const commitMarginSingle = (raw: string) => {
    const n = Math.max(0, parseFloat(raw) || 0)
    const next: Margin = { m1: n, m2: n, m3: n, m4: n }
    setMargin(next)
    void commitMargin(next)
  }
  const commitMarginSide = (key: keyof Margin, raw: string) => {
    const n = Math.max(0, parseFloat(raw) || 0)
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

  const patchDraft = (patch: Partial<SizeDraft>) =>
    setDraft((d) => ({ ...(d ?? committed), ...patch }))

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
                <Input
                  id="rsp-w"
                  type="number"
                  disabled={fieldsDisabled || widthComputed}
                  title={widthComputed ? 'Width is auto-sized (see Auto resize)' : undefined}
                  value={Number.isFinite(width) ? width : 0}
                  onChange={(e) =>
                    patchDraft({ width: Math.max(1, parseFloat(e.target.value) || 1) })
                  }
                  onBlur={() => void commitSize('w')}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rsp-h">H</Label>
                <Input
                  id="rsp-h"
                  type="number"
                  disabled={fieldsDisabled || heightComputed}
                  title={heightComputed ? 'Height is auto-sized (see Auto resize)' : undefined}
                  value={Number.isFinite(height) ? height : 0}
                  onChange={(e) =>
                    patchDraft({ height: Math.max(1, parseFloat(e.target.value) || 1) })
                  }
                  onBlur={() => void commitSize('h')}
                />
              </div>
            </div>

            <SectionWithMultiToggle
              label="Radius"
              multi={cornersMulti}
              onToggleMulti={onToggleCornersMulti}
              toggleTitle="Independent corners"
              disabled={readOnly}
            >
              {cornersMulti ? (
                <div className="grid grid-cols-2 gap-2">
                  <PrefixedNumber
                    id="rsp-r1"
                    prefix="⌜"
                    value={r1Draft ?? String(corners.r1)}
                    disabled={readOnly}
                    onChange={setR1Draft}
                    onBlur={() => {
                      const v = r1Draft ?? String(corners.r1)
                      setR1Draft(null)
                      commitCornerSide('r1', v)
                    }}
                  />
                  <PrefixedNumber
                    id="rsp-r2"
                    prefix="⌝"
                    value={r2Draft ?? String(corners.r2)}
                    disabled={readOnly}
                    onChange={setR2Draft}
                    onBlur={() => {
                      const v = r2Draft ?? String(corners.r2)
                      setR2Draft(null)
                      commitCornerSide('r2', v)
                    }}
                  />
                  <PrefixedNumber
                    id="rsp-r4"
                    prefix="⌞"
                    value={r4Draft ?? String(corners.r4)}
                    disabled={readOnly}
                    onChange={setR4Draft}
                    onBlur={() => {
                      const v = r4Draft ?? String(corners.r4)
                      setR4Draft(null)
                      commitCornerSide('r4', v)
                    }}
                  />
                  <PrefixedNumber
                    id="rsp-r3"
                    prefix="⌟"
                    value={r3Draft ?? String(corners.r3)}
                    disabled={readOnly}
                    onChange={setR3Draft}
                    onBlur={() => {
                      const v = r3Draft ?? String(corners.r3)
                      setR3Draft(null)
                      commitCornerSide('r3', v)
                    }}
                  />
                </div>
              ) : (
                <NumberWithSuffix
                  id="rsp-radius"
                  value={radiusDraft ?? String(corners.r1)}
                  disabled={readOnly}
                  suffix="px"
                  onChange={setRadiusDraft}
                  onBlur={() => {
                    const v = radiusDraft ?? String(corners.r1)
                    setRadiusDraft(null)
                    commitRadiusSingle(v)
                  }}
                />
              )}
            </SectionWithMultiToggle>

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
                    <PrefixedNumber
                      id="rsp-m-t"
                      prefix="T"
                      value={mTopDraft ?? String(margin.m1)}
                      disabled={readOnly}
                      onChange={setMTopDraft}
                      onBlur={() => {
                        const v = mTopDraft ?? String(margin.m1)
                        setMTopDraft(null)
                        commitMarginSide('m1', v)
                      }}
                    />
                    <PrefixedNumber
                      id="rsp-m-r"
                      prefix="R"
                      value={mRightDraft ?? String(margin.m2)}
                      disabled={readOnly}
                      onChange={setMRightDraft}
                      onBlur={() => {
                        const v = mRightDraft ?? String(margin.m2)
                        setMRightDraft(null)
                        commitMarginSide('m2', v)
                      }}
                    />
                    <PrefixedNumber
                      id="rsp-m-b"
                      prefix="B"
                      value={mBottomDraft ?? String(margin.m3)}
                      disabled={readOnly}
                      onChange={setMBottomDraft}
                      onBlur={() => {
                        const v = mBottomDraft ?? String(margin.m3)
                        setMBottomDraft(null)
                        commitMarginSide('m3', v)
                      }}
                    />
                    <PrefixedNumber
                      id="rsp-m-l"
                      prefix="L"
                      value={mLeftDraft ?? String(margin.m4)}
                      disabled={readOnly}
                      onChange={setMLeftDraft}
                      onBlur={() => {
                        const v = mLeftDraft ?? String(margin.m4)
                        setMLeftDraft(null)
                        commitMarginSide('m4', v)
                      }}
                    />
                  </div>
                ) : (
                  <NumberWithSuffix
                    id="rsp-m"
                    value={marginDraft ?? String(margin.m1)}
                    disabled={readOnly}
                    suffix="px"
                    onChange={setMarginDraft}
                    onBlur={() => {
                      const v = marginDraft ?? String(margin.m1)
                      setMarginDraft(null)
                      commitMarginSingle(v)
                    }}
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

function NumberWithSuffix({
  id,
  value,
  onChange,
  onBlur,
  disabled,
  suffix,
}: {
  id: string
  value: string
  onChange: (s: string) => void
  onBlur: () => void
  disabled?: boolean
  suffix: string
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        type="number"
        min={0}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className="pr-8"
      />
      <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground">
        {suffix}
      </span>
    </div>
  )
}

function PrefixedNumber({
  id,
  prefix,
  value,
  onChange,
  onBlur,
  disabled,
}: {
  id: string
  prefix: string
  value: string
  onChange: (s: string) => void
  onBlur: () => void
  disabled?: boolean
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-[12px] font-medium text-muted-foreground">
        {prefix}
      </span>
      <Input
        id={id}
        type="number"
        min={0}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className="pl-7"
      />
    </div>
  )
}
