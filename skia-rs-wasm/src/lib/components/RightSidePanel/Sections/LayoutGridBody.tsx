import { useCallback, useEffect, useRef, useState } from 'react'
import type { GridTrack, PenpotNode } from 'penpot-exporter/types'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  Check,
  ChevronDown,
  ChevronRight,
  Columns3,
  Minus,
  Plus,
  Rows3,
  StretchHorizontal,
  StretchVertical,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  commitNodePartialUpdate,
  getCommittedNodeOnActivePage,
} from '@/lib/renderer/properties/commit-node-properties'
import { getActiveOrSinglePageId } from '@/lib/renderer/store/doc-proxy'
import type { RectLikeNode } from '@/lib/renderer/properties/panel-utils'
import {
  TRACK_TYPE_OPTIONS,
  defaultTrack,
  trackChipLabel,
  trackTypeOption,
  type GridTrackType,
} from './grid-tracks'
import { round2 } from '@/lib/common/conversions'

type GridDir = 'row' | 'column'
type AxisAlign = 'start' | 'center' | 'end' | 'stretch'
type Gap = { rowGap: number; columnGap: number }
type Padding = { p1: number; p2: number; p3: number; p4: number }

interface LayoutView {
  layoutGridDir?: GridDir
  layoutGridRows?: GridTrack[]
  layoutGridColumns?: GridTrack[]
  layoutAlignItems?: AxisAlign
  layoutJustifyItems?: AxisAlign
  layoutGap?: Gap
  layoutPadding?: Padding
}

export interface LayoutGridBodyProps {
  nodeId: string
  initialNode: RectLikeNode
  readOnly: boolean
}

const DIRECTIONS: ReadonlyArray<{ value: GridDir; Icon: typeof Columns3; label: string }> = [
  { value: 'row', Icon: Columns3, label: 'Row — fill columns first' },
  { value: 'column', Icon: Rows3, label: 'Column — fill rows first' },
]

const JUSTIFY_ITEMS: ReadonlyArray<{ value: AxisAlign; Icon: typeof Columns3; label: string }> = [
  { value: 'start', Icon: AlignStartVertical, label: 'Start' },
  { value: 'center', Icon: AlignCenterVertical, label: 'Center' },
  { value: 'end', Icon: AlignEndVertical, label: 'End' },
  { value: 'stretch', Icon: StretchVertical, label: 'Stretch' },
]

const ALIGN_ITEMS: ReadonlyArray<{ value: AxisAlign; Icon: typeof Columns3; label: string }> = [
  { value: 'start', Icon: AlignStartHorizontal, label: 'Start' },
  { value: 'center', Icon: AlignCenterHorizontal, label: 'Center' },
  { value: 'end', Icon: AlignEndHorizontal, label: 'End' },
  { value: 'stretch', Icon: StretchHorizontal, label: 'Stretch' },
]

function readLayout(node: RectLikeNode): LayoutView {
  return node as LayoutView
}

function isMultiPad(p: Padding): boolean {
  return !(p.p1 === p.p2 && p.p2 === p.p3 && p.p3 === p.p4)
}

export function LayoutGridBody({ nodeId, initialNode, readOnly }: LayoutGridBodyProps) {
  const initial = readLayout(initialNode)
  const [direction, setDirection] = useState<GridDir>(initial.layoutGridDir ?? 'row')
  const [columns, setColumns] = useState<GridTrack[]>(initial.layoutGridColumns ?? [])
  const [rows, setRows] = useState<GridTrack[]>(initial.layoutGridRows ?? [])
  const [justifyItems, setJustifyItems] = useState<AxisAlign>(initial.layoutJustifyItems ?? 'start')
  const [alignItems, setAlignItems] = useState<AxisAlign>(initial.layoutAlignItems ?? 'stretch')

  const initialGap = initial.layoutGap ?? { rowGap: 0, columnGap: 0 }
  const [rowGap, setRowGap] = useState<number>(initialGap.rowGap ?? 0)
  const [colGap, setColGap] = useState<number>(initialGap.columnGap ?? 0)
  const [gapMulti, setGapMulti] = useState<boolean>(
    (initialGap.rowGap ?? 0) !== (initialGap.columnGap ?? 0),
  )

  const initialPad: Padding = {
    p1: initial.layoutPadding?.p1 ?? 0,
    p2: initial.layoutPadding?.p2 ?? 0,
    p3: initial.layoutPadding?.p3 ?? 0,
    p4: initial.layoutPadding?.p4 ?? 0,
  }
  const [pad, setPad] = useState<Padding>(initialPad)
  const [padMulti, setPadMulti] = useState<boolean>(isMultiPad(initialPad))

  const [colsOpen, setColsOpen] = useState(true)
  const [rowsOpen, setRowsOpen] = useState(true)

  const [gapDraft, setGapDraft] = useState<string | null>(null)
  const [rowGapDraft, setRowGapDraft] = useState<string | null>(null)
  const [colGapDraft, setColGapDraft] = useState<string | null>(null)
  const [padDraft, setPadDraft] = useState<string | null>(null)
  const [padTopDraft, setPadTopDraft] = useState<string | null>(null)
  const [padRightDraft, setPadRightDraft] = useState<string | null>(null)
  const [padBottomDraft, setPadBottomDraft] = useState<string | null>(null)
  const [padLeftDraft, setPadLeftDraft] = useState<string | null>(null)

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- mirrors external document updates */
    const v = readLayout(initialNode)
    setDirection(v.layoutGridDir ?? 'row')
    setColumns(v.layoutGridColumns ?? [])
    setRows(v.layoutGridRows ?? [])
    setJustifyItems(v.layoutJustifyItems ?? 'start')
    setAlignItems(v.layoutAlignItems ?? 'stretch')
    const g = v.layoutGap ?? { rowGap: 0, columnGap: 0 }
    setRowGap(g.rowGap ?? 0)
    setColGap(g.columnGap ?? 0)
    setGapMulti((g.rowGap ?? 0) !== (g.columnGap ?? 0))
    const p: Padding = {
      p1: v.layoutPadding?.p1 ?? 0,
      p2: v.layoutPadding?.p2 ?? 0,
      p3: v.layoutPadding?.p3 ?? 0,
      p4: v.layoutPadding?.p4 ?? 0,
    }
    setPad(p)
    setPadMulti(isMultiPad(p))
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [initialNode])

  const commit = useCallback(
    async (partial: Partial<PenpotNode>) => {
      if (readOnly) return
      const before = getCommittedNodeOnActivePage(nodeId)
      const pid = getActiveOrSinglePageId()
      if (!before || !pid) return
      await commitNodePartialUpdate(nodeId, before, partial, pid)
    },
    [nodeId, readOnly],
  )

  const onDirection = (v: GridDir) => {
    setDirection(v)
    void commit({ layoutGridDir: v } as Partial<PenpotNode>)
  }

  const commitColumns = (next: GridTrack[]) => {
    setColumns(next)
    void commit({ layoutGridColumns: next } as Partial<PenpotNode>)
  }
  const commitRows = (next: GridTrack[]) => {
    setRows(next)
    void commit({ layoutGridRows: next } as Partial<PenpotNode>)
  }

  const addColumn = () => {
    if (!colsOpen) setColsOpen(true)
    const last = columns[columns.length - 1]
    const lastType = (last?.type ?? 'flex') as GridTrackType
    commitColumns([...columns, defaultTrack(lastType)])
  }
  const removeColumn = (i: number) => {
    if (columns.length <= 1) return
    commitColumns(columns.filter((_, j) => j !== i))
  }
  const updateColumn = (i: number, track: GridTrack) => {
    commitColumns(columns.map((c, j) => (j === i ? track : c)))
  }

  const addRow = () => {
    if (!rowsOpen) setRowsOpen(true)
    const last = rows[rows.length - 1]
    const lastType = (last?.type ?? 'auto') as GridTrackType
    commitRows([...rows, defaultTrack(lastType)])
  }
  const removeRow = (i: number) => {
    if (rows.length <= 1) return
    commitRows(rows.filter((_, j) => j !== i))
  }
  const updateRow = (i: number, track: GridTrack) => {
    commitRows(rows.map((r, j) => (j === i ? track : r)))
  }

  const onJustifyItems = (v: AxisAlign) => {
    setJustifyItems(v)
    void commit({ layoutJustifyItems: v } as Partial<PenpotNode>)
  }
  const onAlignItems = (v: AxisAlign) => {
    setAlignItems(v)
    void commit({ layoutAlignItems: v } as Partial<PenpotNode>)
  }

  const commitGapSingle = (v: number) => {
    const safe = Math.max(0, v)
    setRowGap(safe)
    setColGap(safe)
    void commit({ layoutGap: { rowGap: safe, columnGap: safe } } as Partial<PenpotNode>)
  }
  const commitRowGap = (v: number) => {
    const safe = Math.max(0, v)
    setRowGap(safe)
    void commit({ layoutGap: { rowGap: safe, columnGap: colGap } } as Partial<PenpotNode>)
  }
  const commitColGap = (v: number) => {
    const safe = Math.max(0, v)
    setColGap(safe)
    void commit({ layoutGap: { rowGap, columnGap: safe } } as Partial<PenpotNode>)
  }

  const commitPadSingle = (v: number) => {
    const safe = Math.max(0, v)
    const p: Padding = { p1: safe, p2: safe, p3: safe, p4: safe }
    setPad(p)
    void commit({ layoutPadding: p } as Partial<PenpotNode>)
  }
  const commitPadSide = (key: keyof Padding, v: number) => {
    const safe = Math.max(0, v)
    const p: Padding = { ...pad, [key]: safe }
    setPad(p)
    void commit({ layoutPadding: p } as Partial<PenpotNode>)
  }

  const onToggleGapMulti = () => {
    setGapMulti((m) => {
      const next = !m
      if (!next) {
        const v = Math.max(rowGap, colGap)
        setRowGap(v)
        setColGap(v)
        void commit({ layoutGap: { rowGap: v, columnGap: v } } as Partial<PenpotNode>)
      }
      return next
    })
  }
  const onTogglePadMulti = () => {
    setPadMulti((m) => {
      const next = !m
      if (!next) {
        const v = pad.p1
        const p: Padding = { p1: v, p2: v, p3: v, p4: v }
        setPad(p)
        void commit({ layoutPadding: p } as Partial<PenpotNode>)
      }
      return next
    })
  }

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex min-w-0 items-center justify-between rounded-md bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary">
        <span className="truncate">Grid layout</span>
        <span className="shrink-0 font-mono text-[10px] text-primary/70">
          {columns.length} × {rows.length}
        </span>
      </div>

      <ControlBlock label="Flow direction">
        <IconRow
          items={DIRECTIONS}
          columns={2}
          value={direction}
          onChange={onDirection}
          disabled={readOnly}
        />
      </ControlBlock>

      <TrackList
        label="Columns"
        tracks={columns}
        open={colsOpen}
        onToggleOpen={() => setColsOpen((o) => !o)}
        onAdd={addColumn}
        onRemove={removeColumn}
        onUpdate={updateColumn}
        readOnly={readOnly}
      />

      <TrackList
        label="Rows"
        tracks={rows}
        open={rowsOpen}
        onToggleOpen={() => setRowsOpen((o) => !o)}
        onAdd={addRow}
        onRemove={removeRow}
        onUpdate={updateRow}
        readOnly={readOnly}
      />

      <ControlBlock label="Justify items">
        <IconRow
          items={JUSTIFY_ITEMS}
          columns={4}
          value={justifyItems}
          onChange={onJustifyItems}
          disabled={readOnly}
        />
      </ControlBlock>

      <ControlBlock label="Align items">
        <IconRow
          items={ALIGN_ITEMS}
          columns={4}
          value={alignItems}
          onChange={onAlignItems}
          disabled={readOnly}
        />
      </ControlBlock>

      <SectionWithMultiToggle
        label="Gap"
        multi={gapMulti}
        onToggleMulti={onToggleGapMulti}
        toggleTitle="Independent gaps"
        disabled={readOnly}
      >
        {gapMulti ? (
          <div className="grid grid-cols-2 gap-2">
            <PrefixedNumber
              id="rsp-grid-row-gap"
              prefix="↕"
              value={rowGapDraft ?? String(round2(rowGap))}
              disabled={readOnly}
              onChange={(s) => setRowGapDraft(s)}
              onBlur={() => {
                const n = round2(parseFloat(rowGapDraft ?? String(rowGap)) || 0)
                setRowGapDraft(null)
                commitRowGap(n)
              }}
            />
            <PrefixedNumber
              id="rsp-grid-col-gap"
              prefix="↔"
              value={colGapDraft ?? String(round2(colGap))}
              disabled={readOnly}
              onChange={(s) => setColGapDraft(s)}
              onBlur={() => {
                const n = round2(parseFloat(colGapDraft ?? String(colGap)) || 0)
                setColGapDraft(null)
                commitColGap(n)
              }}
            />
          </div>
        ) : (
          <NumberWithSuffix
            id="rsp-grid-gap"
            value={gapDraft ?? String(round2(rowGap))}
            disabled={readOnly}
            suffix="px"
            onChange={(s) => setGapDraft(s)}
            onBlur={() => {
              const n = round2(parseFloat(gapDraft ?? String(rowGap)) || 0)
              setGapDraft(null)
              commitGapSingle(n)
            }}
          />
        )}
      </SectionWithMultiToggle>

      <SectionWithMultiToggle
        label="Padding"
        multi={padMulti}
        onToggleMulti={onTogglePadMulti}
        toggleTitle="Independent sides"
        disabled={readOnly}
      >
        {padMulti ? (
          <div className="grid grid-cols-2 gap-2">
            <PrefixedNumber
              id="rsp-grid-pad-t"
              prefix="T"
              value={padTopDraft ?? String(round2(pad.p1))}
              disabled={readOnly}
              onChange={(s) => setPadTopDraft(s)}
              onBlur={() => {
                const n = round2(parseFloat(padTopDraft ?? String(pad.p1)) || 0)
                setPadTopDraft(null)
                commitPadSide('p1', n)
              }}
            />
            <PrefixedNumber
              id="rsp-grid-pad-r"
              prefix="R"
              value={padRightDraft ?? String(round2(pad.p2))}
              disabled={readOnly}
              onChange={(s) => setPadRightDraft(s)}
              onBlur={() => {
                const n = round2(parseFloat(padRightDraft ?? String(pad.p2)) || 0)
                setPadRightDraft(null)
                commitPadSide('p2', n)
              }}
            />
            <PrefixedNumber
              id="rsp-grid-pad-b"
              prefix="B"
              value={padBottomDraft ?? String(round2(pad.p3))}
              disabled={readOnly}
              onChange={(s) => setPadBottomDraft(s)}
              onBlur={() => {
                const n = round2(parseFloat(padBottomDraft ?? String(pad.p3)) || 0)
                setPadBottomDraft(null)
                commitPadSide('p3', n)
              }}
            />
            <PrefixedNumber
              id="rsp-grid-pad-l"
              prefix="L"
              value={padLeftDraft ?? String(round2(pad.p4))}
              disabled={readOnly}
              onChange={(s) => setPadLeftDraft(s)}
              onBlur={() => {
                const n = round2(parseFloat(padLeftDraft ?? String(pad.p4)) || 0)
                setPadLeftDraft(null)
                commitPadSide('p4', n)
              }}
            />
          </div>
        ) : (
          <NumberWithSuffix
            id="rsp-grid-pad"
            value={padDraft ?? String(round2(pad.p1))}
            disabled={readOnly}
            suffix="px"
            onChange={(s) => setPadDraft(s)}
            onBlur={() => {
              const n = round2(parseFloat(padDraft ?? String(pad.p1)) || 0)
              setPadDraft(null)
              commitPadSingle(n)
            }}
          />
        )}
      </SectionWithMultiToggle>
    </div>
  )
}

function ControlBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      {children}
    </div>
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
          {multi ? (
            <span className="text-[10px] leading-none">⇶</span>
          ) : (
            <span className="text-[10px] leading-none">≡</span>
          )}
        </Button>
      </div>
      {children}
    </div>
  )
}

interface IconItem<V extends string> {
  value: V
  Icon: typeof Columns3
  label: string
}

function IconRow<V extends string>({
  items,
  columns,
  value,
  onChange,
  disabled,
}: {
  items: ReadonlyArray<IconItem<V>>
  columns: number
  value: V
  onChange: (v: V) => void
  disabled?: boolean
}) {
  return (
    <div
      className="grid w-full gap-1 rounded-md bg-muted/60 p-1"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {items.map(({ value: v, Icon, label }) => {
        const active = v === value
        return (
          <Button
            key={v}
            type="button"
            variant={active ? 'secondary' : 'ghost'}
            size="icon-sm"
            aria-pressed={active}
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={() => onChange(v)}
            className="w-full"
          >
            <Icon className="size-3.5" aria-hidden />
          </Button>
        )
      })}
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
      <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-[11px] font-medium text-muted-foreground">
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

function TrackList({
  label,
  tracks,
  open,
  onToggleOpen,
  onAdd,
  onRemove,
  onUpdate,
  readOnly,
}: {
  label: string
  tracks: GridTrack[]
  open: boolean
  onToggleOpen: () => void
  onAdd: () => void
  onRemove: (i: number) => void
  onUpdate: (i: number, t: GridTrack) => void
  readOnly: boolean
}) {
  const summary = tracks
    .map((t) => (t.value != null ? `${t.value}${trackChipLabel(t.type ?? 'flex')}` : trackChipLabel(t.type ?? 'auto')))
    .join('  ')
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onToggleOpen}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[10px] font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
        >
          {open ? (
            <ChevronDown className="size-3 shrink-0" aria-hidden />
          ) : (
            <ChevronRight className="size-3 shrink-0" aria-hidden />
          )}
          <span>{label}</span>
          <span className="rounded bg-muted px-1 font-mono text-[9px] tracking-normal text-muted-foreground normal-case">
            {tracks.length}
          </span>
          {!open && summary && (
            <span className="ml-1 truncate font-mono text-[10px] tracking-normal text-muted-foreground/70 normal-case">
              {summary}
            </span>
          )}
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Add ${label.toLowerCase().slice(0, -1)}`}
          title={`Add ${label.toLowerCase().slice(0, -1)}`}
          disabled={readOnly}
          onClick={onAdd}
        >
          <Plus className="size-3" aria-hidden />
        </Button>
      </div>

      {open && (
        <div className="space-y-1">
          {tracks.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No {label.toLowerCase()} defined.</p>
          ) : (
            tracks.map((t, i) => (
              <TrackRow
                key={i}
                index={i}
                track={t}
                canDelete={tracks.length > 1}
                disabled={readOnly}
                onChange={(next) => onUpdate(i, next)}
                onDelete={() => onRemove(i)}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

function TrackRow({
  index,
  track,
  canDelete,
  disabled,
  onChange,
  onDelete,
}: {
  index: number
  track: GridTrack
  canDelete: boolean
  disabled?: boolean
  onChange: (t: GridTrack) => void
  onDelete: () => void
}) {
  const type = (track.type ?? 'flex') as GridTrackType
  const opt = trackTypeOption(type)
  const [draft, setDraft] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    window.addEventListener('mousedown', onDoc)
    return () => window.removeEventListener('mousedown', onDoc)
  }, [menuOpen])

  const onPickType = (next: GridTrackType) => {
    setMenuOpen(false)
    if (next === type) return
    onChange(defaultTrack(next, track.value))
  }

  const onValueBlur = () => {
    const raw = draft ?? String(track.value ?? opt.defaultValue ?? 0)
    setDraft(null)
    if (!opt.hasValue) return
    const n = Math.max(0, round2(parseFloat(raw)))
    if (Number.isNaN(n)) return
    onChange({ type, value: n })
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="w-4 shrink-0 text-center font-mono text-[10px] text-muted-foreground">
        {index + 1}
      </span>
      {opt.hasValue ? (
        <Input
          type="number"
          min={0}
          value={draft ?? String(round2(track.value ?? opt.defaultValue ?? 0))}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={onValueBlur}
          className="h-7 flex-1 px-2 text-xs"
        />
      ) : (
        <span className="flex h-7 flex-1 items-center rounded-md border border-input px-2 text-[11px] text-muted-foreground italic">
          {opt.hint.toLowerCase()}
        </span>
      )}
      <div className="relative" ref={wrapRef}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 w-14 px-2 font-mono text-[11px]"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={disabled}
          onClick={() => setMenuOpen((o) => !o)}
          title="Change sizing"
        >
          {opt.label}
          <ChevronDown className="ml-0.5 size-3" aria-hidden />
        </Button>
        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full z-50 mt-1 min-w-[160px] overflow-hidden rounded-md border border-border bg-popover py-1 shadow-md"
          >
            {TRACK_TYPE_OPTIONS.map((o) => {
              const active = o.type === type
              return (
                <button
                  key={o.type}
                  type="button"
                  role="menuitem"
                  onClick={() => onPickType(o.type)}
                  className={
                    'flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-xs hover:bg-accent ' +
                    (active ? 'text-foreground' : 'text-muted-foreground')
                  }
                >
                  <span className="font-mono">{o.label}</span>
                  <span className="text-[10px] text-muted-foreground">{o.hint}</span>
                  {active && <Check className="size-3 text-primary" aria-hidden />}
                </button>
              )
            })}
          </div>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Remove"
        title="Remove"
        disabled={disabled || !canDelete}
        onClick={onDelete}
      >
        <Minus className="size-3" aria-hidden />
      </Button>
    </div>
  )
}
