import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'

export interface Placement {
  fc: number
  fr: number
  tc: number
  tr: number
}

export interface GridPlacementPickerProps {
  cols: number
  rows: number
  value: Placement
  onChange: (next: Placement) => void
  disabled?: boolean
  maxWidth?: number
}

const VISUAL_CELL_MAX = 22
const VISUAL_CELL_MIN = 12

function colToLetter(n: number): string {
  let s = ''
  let v = n
  while (v > 0) {
    s = String.fromCharCode(65 + ((v - 1) % 26)) + s
    v = Math.floor((v - 1) / 26)
  }
  return s
}

function letterToCol(s: string): number | null {
  let n = 0
  for (const ch of s.toUpperCase()) {
    if (ch < 'A' || ch > 'Z') return null
    n = n * 26 + (ch.charCodeAt(0) - 64)
  }
  return n || null
}

function fmtCoord(c: number, r: number, useLetters: boolean): string {
  return useLetters ? `${colToLetter(c)}${r}` : `${c},${r}`
}

function parseCoord(
  raw: string,
  cols: number,
  rows: number,
  useLetters: boolean,
): { c: number; r: number } | null {
  const s = raw.trim()
  if (!s) return null
  if (useLetters) {
    const m = s.match(/^([A-Za-z]+)\s*(\d+)$/)
    if (m) {
      const c = letterToCol(m[1])
      const r = +m[2]
      if (!c || c > cols || r < 1 || r > rows) return null
      return { c, r }
    }
  }
  const m = s.match(/^(\d+)\s*[,\s]\s*(\d+)$/)
  if (!m) return null
  const c = +m[1]
  const r = +m[2]
  if (c < 1 || c > cols || r < 1 || r > rows) return null
  return { c, r }
}

function normSel(a: { c: number; r: number }, b: { c: number; r: number }): Placement {
  return {
    fc: Math.min(a.c, b.c),
    fr: Math.min(a.r, b.r),
    tc: Math.max(a.c, b.c),
    tr: Math.max(a.r, b.r),
  }
}

function clampCell(
  cell: { c: number; r: number },
  cols: number,
  rows: number,
): { c: number; r: number } {
  return {
    c: Math.max(1, Math.min(cols, cell.c)),
    r: Math.max(1, Math.min(rows, cell.r)),
  }
}

export function GridPlacementPicker({
  cols,
  rows,
  value,
  onChange,
  disabled,
  maxWidth = 220,
}: GridPlacementPickerProps) {
  const safeCols = Math.max(1, cols)
  const safeRows = Math.max(1, rows)
  const useLetters = safeCols <= 26

  const gap = safeCols > 16 || safeRows > 16 ? 1 : 2
  const idealCell = Math.floor((maxWidth - gap * (safeCols - 1)) / safeCols)
  const cellSize = Math.max(0, Math.min(VISUAL_CELL_MAX, idealCell))
  const numericMode = cellSize < VISUAL_CELL_MIN

  const visualW = numericMode
    ? maxWidth
    : safeCols * cellSize + (safeCols - 1) * gap
  const visualH = numericMode
    ? Math.min(80, Math.max(40, (safeRows / safeCols) * visualW))
    : safeRows * cellSize + (safeRows - 1) * gap

  const gridRef = useRef<HTMLDivElement | null>(null)
  const numericRef = useRef<HTMLDivElement | null>(null)
  const [dragAnchor, setDragAnchor] = useState<{ c: number; r: number } | null>(null)

  const cellAtFromGrid = (clientX: number, clientY: number): { c: number; r: number } | null => {
    const el = gridRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    const step = cellSize + gap
    if (step <= 0) return null
    const c = clampCell(
      { c: Math.floor(x / step) + 1, r: Math.floor(y / step) + 1 },
      safeCols,
      safeRows,
    )
    return c
  }

  const onGridMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (disabled) return
    e.preventDefault()
    const cell = cellAtFromGrid(e.clientX, e.clientY)
    if (!cell) return
    setDragAnchor(cell)
    onChange(normSel(cell, cell))
  }
  const onGridMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragAnchor || disabled) return
    const cell = cellAtFromGrid(e.clientX, e.clientY)
    if (!cell) return
    onChange(normSel(dragAnchor, cell))
  }
  const onGridEnd = () => {
    if (dragAnchor) setDragAnchor(null)
  }

  useEffect(() => {
    if (!dragAnchor) return
    const onUp = () => setDragAnchor(null)
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [dragAnchor])

  const startNumericDrag = (
    e: React.MouseEvent<HTMLElement>,
    mode: 'move' | 'tl' | 'br',
  ) => {
    if (disabled) return
    const host = numericRef.current
    if (!host) return
    e.preventDefault()
    e.stopPropagation()
    const rect = host.getBoundingClientRect()
    const cellW = rect.width / safeCols
    const cellH = rect.height / safeRows
    const cellAt = (clientX: number, clientY: number): { c: number; r: number } =>
      clampCell(
        {
          c: Math.floor((clientX - rect.left) / cellW) + 1,
          r: Math.floor((clientY - rect.top) / cellH) + 1,
        },
        safeCols,
        safeRows,
      )
    const start = { ...value }
    const startCell = cellAt(e.clientX, e.clientY)
    const onMv = (ev: MouseEvent) => {
      const cur = cellAt(ev.clientX, ev.clientY)
      if (mode === 'move') {
        const dc = cur.c - startCell.c
        const dr = cur.r - startCell.r
        const wSpan = start.tc - start.fc
        const hSpan = start.tr - start.fr
        const fc = Math.max(1, Math.min(safeCols - wSpan, start.fc + dc))
        const fr = Math.max(1, Math.min(safeRows - hSpan, start.fr + dr))
        onChange({ fc, fr, tc: fc + wSpan, tr: fr + hSpan })
      } else if (mode === 'tl') {
        onChange(normSel({ c: cur.c, r: cur.r }, { c: start.tc, r: start.tr }))
      } else if (mode === 'br') {
        onChange(normSel({ c: start.fc, r: start.fr }, { c: cur.c, r: cur.r }))
      }
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMv)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMv)
    window.addEventListener('mouseup', onUp)
  }

  const cells: React.ReactElement[] = []
  if (!numericMode) {
    for (let r = 1; r <= safeRows; r++) {
      for (let c = 1; c <= safeCols; c++) {
        const inside = c >= value.fc && c <= value.tc && r >= value.fr && r <= value.tr
        cells.push(
          <div
            key={`${c}-${r}`}
            className={
              'rounded-sm transition-colors ' +
              (inside ? 'bg-primary' : 'bg-muted hover:bg-muted-foreground/20')
            }
          />,
        )
      }
    }
  }

  const single = value.fc === value.tc && value.fr === value.tr
  const summary = single
    ? fmtCoord(value.fc, value.fr, useLetters)
    : `${fmtCoord(value.fc, value.fr, useLetters)} → ${fmtCoord(value.tc, value.tr, useLetters)}`

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          Cell placement
        </span>
        <span className="font-mono text-[10px] text-primary">{summary}</span>
      </div>

      <div className="rounded-md border border-border bg-muted/30 p-2">
        {numericMode ? (
          <div
            ref={numericRef}
            className="relative rounded-sm border border-dashed border-border bg-muted"
            style={{ width: visualW, height: visualH }}
          >
            <div
              role="presentation"
              className="absolute cursor-move rounded-sm bg-primary/30 ring-1 ring-primary"
              style={{
                left: `${((value.fc - 1) / safeCols) * 100}%`,
                top: `${((value.fr - 1) / safeRows) * 100}%`,
                width: `${((value.tc - value.fc + 1) / safeCols) * 100}%`,
                height: `${((value.tr - value.fr + 1) / safeRows) * 100}%`,
              }}
              onMouseDown={(e) => startNumericDrag(e, 'move')}
            >
              <span
                className="absolute -left-1 -top-1 size-2 cursor-nwse-resize rounded-full bg-primary"
                onMouseDown={(e) => startNumericDrag(e, 'tl')}
              />
              <span
                className="absolute -right-1 -bottom-1 size-2 cursor-nwse-resize rounded-full bg-primary"
                onMouseDown={(e) => startNumericDrag(e, 'br')}
              />
            </div>
            <span className="pointer-events-none absolute right-1 bottom-0.5 font-mono text-[9px] text-muted-foreground">
              {safeCols} × {safeRows}
            </span>
          </div>
        ) : (
          <div
            ref={gridRef}
            className={'grid select-none ' + (disabled ? '' : 'cursor-crosshair')}
            style={{
              width: visualW,
              height: visualH,
              gridTemplateColumns: `repeat(${safeCols}, ${cellSize}px)`,
              gridTemplateRows: `repeat(${safeRows}, ${cellSize}px)`,
              gap,
            }}
            onMouseDown={onGridMouseDown}
            onMouseMove={onGridMouseMove}
            onMouseUp={onGridEnd}
            onMouseLeave={onGridEnd}
          >
            {cells}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <CoordInput
          id="rsp-grid-from"
          label="From"
          value={fmtCoord(value.fc, value.fr, useLetters)}
          cols={safeCols}
          rows={safeRows}
          useLetters={useLetters}
          disabled={disabled}
          onCommit={(p) => onChange(normSel(p, { c: value.tc, r: value.tr }))}
        />
        <CoordInput
          id="rsp-grid-to"
          label="To"
          value={fmtCoord(value.tc, value.tr, useLetters)}
          cols={safeCols}
          rows={safeRows}
          useLetters={useLetters}
          disabled={disabled}
          onCommit={(p) => onChange(normSel({ c: value.fc, r: value.fr }, p))}
        />
      </div>
    </div>
  )
}

function CoordInput({
  id,
  label,
  value,
  cols,
  rows,
  useLetters,
  onCommit,
  disabled,
}: {
  id: string
  label: string
  value: string
  cols: number
  rows: number
  useLetters: boolean
  onCommit: (p: { c: number; r: number }) => void
  disabled?: boolean
}) {
  const [draft, setDraft] = useState(value)
  const [bad, setBad] = useState(false)

  useEffect(() => {
    setDraft(value)
  }, [value])

  const commit = () => {
    const parsed = parseCoord(draft, cols, rows, useLetters)
    if (parsed) {
      onCommit(parsed)
      setDraft(fmtCoord(parsed.c, parsed.r, useLetters))
      return
    }
    setBad(true)
    window.setTimeout(() => setBad(false), 400)
    setDraft(value)
  }

  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-[10px] font-medium text-muted-foreground">
        {label}
      </span>
      <Input
        id={id}
        type="text"
        spellCheck={false}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            setDraft(value)
            e.currentTarget.blur()
          }
        }}
        className={
          'pl-12 font-mono text-xs ' +
          (useLetters ? 'uppercase ' : '') +
          (bad ? 'border-destructive ring-2 ring-destructive/30' : '')
        }
      />
    </div>
  )
}
