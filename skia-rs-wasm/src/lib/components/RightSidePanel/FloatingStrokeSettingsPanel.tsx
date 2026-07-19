/**
 * Floating "Stroke settings" panel, opened from the stroke row's sliders button.
 * Reuses the side-editor pattern (`FloatingPanelShell` + the color-editor
 * context's stroke-settings track).
 *
 * Consolidated from the old Basic/Dynamic/Brush tabs into a single panel keyed
 * off a "Brush" (rendering engine) picker. "Basic" is the default brush — the
 * standard Skia vector outline — and its options are the dash/corners block.
 * Other brushes (marker, calligraphic, …) swap in their own options as the
 * brush engine ships. Layout:
 *   • Preview      — one full-stroke sample (wavy) reflecting every option a
 *                    smooth curve can show; sits above everything
 *   • Brush        — picker: which rendering engine draws the stroke
 *   • (per brush)  — Basic ⇒ Dash pattern (style/dashes/cap) + Corners
 *                    (join/miter/width profile); other brushes ⇒ their options
 *   • Hand-drawn   — global path perturbation, applies to every brush
 */

import { useCallback, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, GripHorizontal, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { round2 } from '@/lib/common/conversions'
import type {
  StrokeWithSettings,
  StrokeDashCap,
  StrokeBasicJoin,
  StrokeDynamic,
} from '../../renderer/stroke-settings'
import { miterAngleToLimit, miterLimitToAngle } from '../../renderer/stroke-settings'
import {
  BRUSHES,
  DEFAULT_BRUSH_ID,
  GALLERY_WAVE,
  WIDTH_PROFILES,
  getBrush,
  toStrokeBrush,
  type BrushDef,
  type WidthProfileId,
} from '../../renderer/brushes'
import { useColorEditor } from './use-color-editor'
import { FloatingPanelShell } from './FloatingPanelShell'
import { NumericField } from './NumericField'

const STYLE_OPTIONS = ['solid', 'dotted', 'dashed', 'mixed', 'custom'] as const
type StyleOption = (typeof STYLE_OPTIONS)[number]

const DASH_CAP_OPTIONS: StrokeDashCap[] = ['butt', 'round', 'square']
const JOIN_OPTIONS: StrokeBasicJoin[] = ['miter', 'round', 'bevel']

/** Small filled glyph for a PowerStroke width profile (the width envelope). */
function ProfileIcon({ profile }: { profile: string }) {
  return (
    <svg viewBox="0 0 40 24" className="h-4 w-8" fill="currentColor" aria-hidden>
      {profile === 'uniform' && <rect x="2" y="9" width="36" height="6" rx="1" />}
      {profile === 'taper-both' && <path d="M2 12 Q20 3 38 12 Q20 21 2 12 Z" />}
      {profile === 'taper-start' && <path d="M2 12 L38 5 L38 19 Z" />}
      {profile === 'taper-end' && <path d="M38 12 L2 5 L2 19 Z" />}
      {profile === 'bulge' && <path d="M2 9 Q20 0 38 9 L38 15 Q20 24 2 15 Z" />}
    </svg>
  )
}

/** Mini sample of a brush, rendered as the gallery wave in that brush's style. */
function BrushSwatch({ brush, large }: { brush: BrushDef; large?: boolean }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-muted/40 text-foreground',
        large ? 'h-9 w-14' : 'h-5 w-9',
      )}
    >
      <svg viewBox="0 0 124 34" preserveAspectRatio="xMidYMid meet" className="h-full w-full" aria-hidden>
        <path
          d={GALLERY_WAVE}
          fill="none"
          stroke="currentColor"
          strokeWidth={brush.preview.width}
          strokeLinecap={brush.preview.cap}
          strokeDasharray={brush.preview.dash}
          strokeOpacity={brush.preview.opacity}
        />
      </svg>
    </span>
  )
}

/** Short thick segment showing a line cap. */
function CapIcon({ cap }: { cap: StrokeDashCap }) {
  return (
    <svg viewBox="0 0 30 12" className="h-3 w-7" aria-hidden>
      <line x1="7" y1="6" x2="20" y2="6" stroke="currentColor" strokeWidth="5" strokeLinecap={cap} />
    </svg>
  )
}

/**
 * L-corner with a thick stroke so the outer-corner treatment is visible at icon
 * size: `miter` keeps a sharp corner, `round` rounds it, `bevel` cuts it flat.
 * The original was the right shape but too thin (3px) to read the difference.
 */
/** Outer-edge contour of the thick corner, per join — this is the highlighted
 *  line. A thick body (width 14 → join radius 7) makes the round arc / bevel cut
 *  large enough to read at icon size. */
const JOIN_OUTER_PATH: Record<StrokeBasicJoin, string> = {
  miter: 'M 1 24 L 1 1 L 24 1',
  round: 'M 1 24 L 1 8 Q 1 1 8 1 L 24 1',
  bevel: 'M 1 24 L 1 8 L 8 1 L 24 1',
}

/**
 * A faded thick corner (the body) with its outer edge highlighted at full
 * strength — the highlighted contour is what encodes the join (sharp point /
 * arc / flat cut). The theme is grayscale, so the "accent" is a darker shade
 * (full `currentColor`) over the faded body, adapting to light/dark.
 */
function JoinIcon({ join }: { join: StrokeBasicJoin }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
      <polyline
        points="8,22 8,8 22,8"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.26"
        strokeWidth="14"
        strokeLinejoin={join}
        strokeLinecap="butt"
      />
      <path
        d={JOIN_OUTER_PATH[join]}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="miter"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Flat section header separating the panel's control groups. */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mt-1 border-t border-border/60 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
      {children}
    </div>
  )
}

function Row({ label, muted, children }: { label: string; muted?: boolean; children: ReactNode }) {
  return (
    <div className={cn('flex items-center gap-2', muted && 'opacity-55')}>
      <span className="w-[72px] shrink-0 text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

function Segmented<T extends string>({
  value,
  options,
  ariaLabel,
  render,
  onChange,
}: {
  value: T
  options: T[]
  ariaLabel: string
  render: (v: T) => ReactNode
  onChange: (v: T) => void
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-1 gap-0.5 rounded-md bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          title={o}
          aria-label={o}
          aria-pressed={value === o}
          className={cn(
            'flex h-6 flex-1 items-center justify-center rounded transition-colors',
            value === o
              ? 'bg-background text-foreground ring-1 ring-ring'
              : 'text-muted-foreground hover:bg-background/50',
          )}
        >
          {render(o)}
        </button>
      ))}
    </div>
  )
}

/** 0..1 value edited as a percent. `max` caps the percent (use >100 to allow
 *  exceeding 100%); `step` is the (subtle) increment. */
function PercentField({
  value,
  ariaLabel,
  onChange,
  max = 100,
  step = 0.5,
}: {
  value: number
  ariaLabel: string
  onChange: (v: number) => void
  max?: number
  step?: number
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <NumericField
        className="h-7 min-w-0 flex-1 px-1.5 text-xs"
        aria-label={ariaLabel}
        value={Math.round(value * 1000) / 10}
        min={0}
        max={max}
        step={step}
        onCommit={(v) => onChange(Math.max(0, Math.min(max, v)) / 100)}
      />
      <span className="shrink-0 text-[11px] text-muted-foreground">%</span>
    </div>
  )
}

const PREVIEW_W = 276
const PREVIEW_H = 46
const PREVIEW_MID = PREVIEW_H / 2

/** Preview dash array derived from a non-custom style (custom uses the real
 *  dashes). Rough mirror of the canvas derivation — enough to read the style. */
const STYLE_DASH: Record<string, string | undefined> = {
  solid: undefined,
  dotted: '1 5',
  dashed: '8 6',
  mixed: '10 4 1 4',
}

/**
 * Sampled wavy sample-stroke path. The base is a gentle two-hump wave; the
 * "Hand-drawn" dynamic adds a higher-frequency wiggle on top so the
 * Frequency / Wiggle / Smoothen controls visibly change the sample. Deterministic
 * (pure sines, no randomness) so it's stable across renders.
 */
function buildPreviewPath(dyn: StrokeDynamic | undefined): string {
  const N = 72
  const x0 = 10
  const x1 = PREVIEW_W - 10
  const span = x1 - x0
  const baseAmp = 9
  const smoothen = dyn?.smoothen ?? 0
  const wiggleAmp = (dyn?.wiggle ?? 0) * 7 * (1 - 0.6 * smoothen)
  const wigglePeriod = 64 / (0.4 + (dyn?.frequency ?? 0) * 1.6)
  let d = ''
  for (let i = 0; i <= N; i++) {
    const t = i / N
    const x = x0 + span * t
    const base = baseAmp * Math.sin(t * Math.PI * 2)
    const wig = wiggleAmp * Math.sin((x / wigglePeriod) * Math.PI * 2)
    d += `${i === 0 ? 'M' : 'L'} ${round2(x)} ${round2(PREVIEW_MID + base + wig)} `
  }
  return d.trim()
}

export function FloatingStrokeSettingsPanel() {
  const { activeTarget, activeStrokeSettings, anchorY, closeEditor, onStrokeSettingsChangeRef } =
    useColorEditor()

  // Local draft for the dashes text field so intermediate text ("8, ", "8, 6,")
  // isn't clobbered by re-parsing on every keystroke (mirrors the hex drafts).
  const [dashDraft, setDashDraft] = useState<string | null>(null)

  // Brush gallery flyout — a self-contained popover (not the shared color-editor
  // context, which only tracks one side panel) so it opens beside this panel.
  const [brushOpen, setBrushOpen] = useState(false)
  const [brushQuery, setBrushQuery] = useState('')
  // Flyout is portaled to <body> (the panel clips overflow), so it's positioned
  // in viewport coordinates and opens beside the stroke panel. It's draggable.
  const brushBtnRef = useRef<HTMLButtonElement>(null)
  const [brushPos, setBrushPos] = useState<{ left: number; top: number } | null>(null)
  const brushDrag = useRef<{ startX: number; startY: number; origLeft: number; origTop: number } | null>(null)

  const FLYOUT_W = 224

  const openBrush = useCallback(() => {
    // Anchor to the stroke panel (not the button) so the gallery opens fully to
    // the panel's side instead of overlapping it.
    const panel = brushBtnRef.current?.closest('[data-floating-panel]') as HTMLElement | null
    const r = (panel ?? brushBtnRef.current)?.getBoundingClientRect()
    if (r) {
      const gap = 8
      const margin = 8
      // Prefer opening to the left of the panel; flip to the right if it won't fit.
      let left = r.left - gap - FLYOUT_W
      if (left < margin) left = Math.min(r.right + gap, window.innerWidth - FLYOUT_W - margin)
      const top = Math.max(margin, Math.min(r.top, window.innerHeight - 320))
      setBrushPos({ left, top })
    }
    setBrushOpen(true)
  }, [])

  const closeBrush = useCallback(() => {
    setBrushOpen(false)
    setBrushQuery('')
  }, [])

  const onBrushDragStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!brushPos) return
      brushDrag.current = {
        startX: e.clientX,
        startY: e.clientY,
        origLeft: brushPos.left,
        origTop: brushPos.top,
      }
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    [brushPos],
  )
  const onBrushDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = brushDrag.current
    if (!d) return
    const left = Math.max(0, Math.min(d.origLeft + (e.clientX - d.startX), window.innerWidth - FLYOUT_W))
    const top = Math.max(0, Math.min(d.origTop + (e.clientY - d.startY), window.innerHeight - 60))
    setBrushPos({ left, top })
  }, [])
  const onBrushDragEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    brushDrag.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }, [])

  const handleChange = useCallback(
    (next: StrokeWithSettings) => {
      onStrokeSettingsChangeRef.current?.(next)
    },
    [onStrokeSettingsChangeRef],
  )

  const targetKey =
    activeTarget && activeStrokeSettings
      ? `stroke-settings-${activeTarget.kind}-${activeTarget.index}`
      : null

  if (!targetKey || !activeStrokeSettings) return null
  const stroke = activeStrokeSettings

  const update = (partial: Partial<StrokeWithSettings>) => handleChange({ ...stroke, ...partial })

  const dashes = stroke.strokeDashes ?? []
  const hasDashes = dashes.length > 0
  const displayStyle: StyleOption = hasDashes
    ? 'custom'
    : ((stroke.strokeStyle as StyleOption) ?? 'solid')
  const nonSolid = displayStyle !== 'solid'
  const isCustom = displayStyle === 'custom'
  const dashCap = stroke.strokeDashCap ?? 'butt'
  const join = stroke.strokeJoin ?? 'miter'
  const miterAngle = round2(miterLimitToAngle(stroke.strokeMiterLimit ?? 4))

  const dyn: StrokeDynamic = stroke.strokeDynamic ?? { frequency: 0.5, wiggle: 0, smoothen: 0.5 }
  const updateDyn = (partial: Partial<StrokeDynamic>) =>
    update({ strokeDynamic: { ...dyn, ...partial } })

  // Full-stroke preview: reflects color/opacity/width/dashes/cap + the hand-drawn
  // dynamic. (Join/miter don't read on a smooth curve — those show on canvas.)
  const previewColor = stroke.strokeColorGradient ? 'currentColor' : (stroke.strokeColor ?? 'currentColor')
  const previewOpacity = stroke.strokeOpacity ?? 1
  const previewWidth = Math.max(1, Math.min(14, stroke.strokeWidth ?? 1))
  const previewDash = hasDashes ? dashes.join(' ') : STYLE_DASH[displayStyle]
  const previewPath = buildPreviewPath(stroke.strokeDynamic)

  // Brush selection is persisted on the stroke (absent = the default `basic`).
  const brushId = stroke.strokeBrush?.id ?? DEFAULT_BRUSH_ID
  const activeBrush = getBrush(brushId)
  const selectBrush = (def: BrushDef) => update({ strokeBrush: toStrokeBrush(def) })

  // Params of the selected (non-basic) brush.
  const brushParams = stroke.strokeBrush?.params ?? activeBrush.defaults ?? {}
  const updateBrushParam = (patch: Record<string, number | string | number[] | undefined>) => {
    const base = stroke.strokeBrush ?? toStrokeBrush(activeBrush)
    if (!base) return
    const params: Record<string, number | string | number[]> = { ...(base.params ?? {}) }
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete params[k]
      else params[k] = v
    }
    update({ strokeBrush: { ...base, params } })
  }
  const powProfile = (typeof brushParams.profile === 'string' ? brushParams.profile : 'uniform') as WidthProfileId
  const powNib = typeof brushParams.nib === 'number' ? brushParams.nib : 0

  const texScale = typeof brushParams.scale === 'number' ? brushParams.scale : 8
  const texDensity = typeof brushParams.density === 'number' ? brushParams.density : 0.6

  const brushQ = brushQuery.trim().toLowerCase()
  const filteredBrushes = brushQ
    ? BRUSHES.filter(
        (b) => b.label.toLowerCase().includes(brushQ) || b.desc.toLowerCase().includes(brushQ),
      )
    : BRUSHES

  const onStyle = (value: StyleOption) => {
    if (value === 'custom') {
      update({ strokeStyle: 'dashed', strokeDashes: dashes.length ? dashes : [8, 6] })
    } else {
      update({ strokeStyle: value as StrokeWithSettings['strokeStyle'], strokeDashes: undefined })
    }
  }

  const onDashesText = (raw: string) => {
    setDashDraft(raw)
    const arr = raw
      .split(/[\s,]+/)
      .filter((t) => t.length > 0)
      .map((t) => Number(t))
      .filter((n) => Number.isFinite(n) && n >= 0)
    update({ strokeStyle: 'dashed', strokeDashes: arr })
  }

  const titleNode = <span className="text-xs font-medium">Stroke settings</span>

  // Full-stroke preview — rendered in the shell's pinned header slot so it stays
  // visible while the options scroll (reflects every option a smooth curve can
  // show: color/opacity/width/dashes/cap + hand-drawn).
  const previewHeader = (
    <div className="rounded-md border border-border bg-muted/40 p-1.5 text-foreground">
      <svg
        viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-[46px] w-full"
        aria-label="Stroke preview"
      >
        <path
          d={previewPath}
          fill="none"
          stroke={previewColor}
          strokeOpacity={previewOpacity}
          strokeWidth={previewWidth}
          strokeLinecap={dashCap}
          strokeLinejoin={join}
          strokeDasharray={previewDash}
        />
      </svg>
    </div>
  )

  return (
    <FloatingPanelShell
      targetKey={targetKey}
      anchorY={anchorY}
      title={titleNode}
      header={previewHeader}
      width={300}
      onClose={closeEditor}
    >
      <div className="relative space-y-2">
        {/* Brush gallery flyout — opens to the side of the panel, shows every
            brush's look before you pick it. Self-contained popover. */}
        {brushOpen && brushPos &&
          createPortal(
            <div onMouseDown={(e) => e.stopPropagation()}>
              <div className="fixed inset-0 z-[120]" onClick={closeBrush} aria-hidden />
              <div
                role="listbox"
                aria-label="Brush"
                style={{ left: brushPos.left, top: brushPos.top, width: FLYOUT_W }}
                className="fixed z-[121] overflow-hidden rounded-lg border border-border bg-background shadow-md"
              >
              {/* Draggable title bar */}
              <div
                className="flex cursor-grab items-center justify-between border-b border-border px-2 py-1.5 select-none active:cursor-grabbing"
                onPointerDown={onBrushDragStart}
                onPointerMove={onBrushDragMove}
                onPointerUp={onBrushDragEnd}
                onLostPointerCapture={onBrushDragEnd}
              >
                <span className="text-[11px] font-medium">Brush</span>
                <GripHorizontal className="size-3.5 text-muted-foreground" />
              </div>
              <div className="p-1.5">
              <div className="relative mb-1">
                <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="text"
                  autoFocus
                  className="h-7 pl-7 text-xs"
                  placeholder="Search brushes"
                  value={brushQuery}
                  onChange={(e) => setBrushQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') closeBrush()
                  }}
                  aria-label="Search brushes"
                />
              </div>
              <div className="space-y-0.5">
                {filteredBrushes.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    role="option"
                    aria-selected={brushId === b.id}
                    disabled={!b.ready}
                    onClick={() => {
                      selectBrush(b)
                      closeBrush()
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md p-1.5 text-left transition-colors',
                      brushId === b.id ? 'bg-accent' : 'hover:bg-muted',
                      !b.ready && 'cursor-not-allowed opacity-55 hover:bg-transparent',
                    )}
                  >
                    <BrushSwatch brush={b} large />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="text-xs font-medium">{b.label}</span>
                        {!b.ready && (
                          <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">soon</span>
                        )}
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">{b.desc}</span>
                    </span>
                    {brushId === b.id && <Check className="size-3.5 shrink-0 text-foreground" />}
                  </button>
                ))}
                {filteredBrushes.length === 0 && (
                  <p className="px-1.5 py-3 text-center text-[11px] text-muted-foreground">
                    No brushes match “{brushQuery.trim()}”
                  </p>
                )}
              </div>
              </div>
              </div>
            </div>,
            document.body,
          )}

        {/* Brush type — the stroke's rendering engine. Opens the gallery flyout
            so each brush's look is visible before selecting. */}
        <Row label="Brush">
          <button
            ref={brushBtnRef}
            type="button"
            onClick={() => (brushOpen ? closeBrush() : openBrush())}
            aria-haspopup="listbox"
            aria-expanded={brushOpen}
            title="Choose brush"
            className={cn(
              'border-input bg-background flex h-7 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border px-1.5 text-xs',
              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              brushOpen && 'ring-1 ring-ring',
            )}
          >
            <span className="truncate font-medium">{activeBrush.label}</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </Row>

        {brushId === DEFAULT_BRUSH_ID ? (
          <>
            {/* ── Dash pattern (along the path) — Basic-brush option ── */}
            <SectionLabel>Dash pattern</SectionLabel>
            <Row label="Style">
              <select
                className="border-input bg-background h-7 min-w-0 flex-1 rounded-md border px-1.5 text-xs"
                value={displayStyle}
                onChange={(e) => onStyle(e.target.value as StyleOption)}
                title="Stroke style"
              >
                {STYLE_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s[0].toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </Row>

            {/* Custom dash pattern */}
            {isCustom && (
              <Row label="Dashes">
                <Input
                  type="text"
                  className="h-7 min-w-0 flex-1 font-mono text-xs"
                  value={dashDraft ?? dashes.join(', ')}
                  placeholder="8, 6, 2, 6"
                  onChange={(e) => onDashesText(e.target.value)}
                  onBlur={() => setDashDraft(null)}
                  aria-label="Dash pattern"
                />
              </Row>
            )}

            {/* Dash cap */}
            {nonSolid && (
              <Row label="Dash cap">
                <Segmented
                  value={dashCap}
                  options={DASH_CAP_OPTIONS}
                  ariaLabel="Dash cap"
                  render={(c) => <CapIcon cap={c} />}
                  onChange={(c) => update({ strokeDashCap: c })}
                />
              </Row>
            )}

            {/* ── Corners — Basic-brush option ── */}
            <SectionLabel>Corners</SectionLabel>
            <Row label="Join">
              <Segmented
                value={join}
                options={JOIN_OPTIONS}
                ariaLabel="Join"
                render={(j) => <JoinIcon join={j} />}
                onChange={(j) => update({ strokeJoin: j })}
              />
            </Row>

            {/* Miter angle (only meaningful for miter joins) */}
            <Row label="Miter angle" muted={join !== 'miter'}>
              <NumericField
                className="h-7 min-w-0 flex-1 px-1.5 text-xs"
                aria-label="Miter angle (degrees)"
                value={miterAngle}
                min={0}
                max={180}
                step={1}
                onCommit={(deg) => update({ strokeMiterLimit: miterAngleToLimit(deg) })}
              />
            </Row>

            {/* Width profile — deferred (variable-width stroking) */}
            <Row label="Width profile" muted>
              <div className="flex h-7 min-w-0 flex-1 items-center justify-between rounded-md border border-dashed border-input bg-muted px-2 text-xs text-muted-foreground">
                Uniform
                <span className="rounded bg-background/60 px-1 text-[9px]">later</span>
              </div>
            </Row>
          </>
        ) : activeBrush.engine === 'power' ? (
          <>
            {/* ── PowerStroke (variable-width) options ── */}
            <SectionLabel>Width profile</SectionLabel>
            <Row label="Profile">
              <Segmented
                value={powProfile}
                options={[...WIDTH_PROFILES]}
                ariaLabel="Width profile"
                render={(p) => <ProfileIcon profile={p} />}
                onChange={(p) =>
                  // Set the preset and drop any hand-sculpted points (which override it).
                  update({
                    strokeWidthPoints: undefined,
                    strokeBrush: {
                      ...(stroke.strokeBrush ?? { id: activeBrush.id, engine: activeBrush.engine }),
                      params: { ...(stroke.strokeBrush?.params ?? {}), profile: p },
                    },
                  })
                }
              />
            </Row>
            <Row label="Nib">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <NumericField
                  className="h-7 min-w-0 flex-1 px-1.5 text-xs"
                  aria-label="Calligraphic nib angle (degrees, 0 = round)"
                  value={round2(powNib)}
                  min={0}
                  max={180}
                  step={5}
                  onCommit={(v) => updateBrushParam({ nib: Math.max(0, Math.min(180, v)) })}
                />
                <span className="shrink-0 text-[11px] text-muted-foreground">°</span>
              </div>
            </Row>
            <p className="px-0.5 text-[11px] leading-snug text-muted-foreground">
              Variable-width stroke. Nib = pen-angle direction (0–180°); 0 = round.
            </p>
          </>
        ) : activeBrush.engine === 'texture-stretch' ? (
          <>
            {/* ── Texture (grain) options ── */}
            <SectionLabel>Texture</SectionLabel>
            <Row label="Grain">
              <NumericField
                className="h-7 min-w-0 flex-1 px-1.5 text-xs"
                aria-label="Grain feature size"
                value={round2(texScale)}
                min={1}
                max={100}
                step={1}
                onCommit={(v) => updateBrushParam({ scale: Math.max(1, v) })}
              />
            </Row>
            <Row label="Density">
              <PercentField
                value={texDensity}
                ariaLabel="Density"
                onChange={(v) => updateBrushParam({ density: v })}
              />
            </Row>
            <p className="px-0.5 text-[11px] leading-snug text-muted-foreground">
              Dry, grainy ink stroke. Grain = texture size; Density = how solid vs broken.
            </p>
          </>
        ) : (
          /* Remaining brush engines land here as they ship. */
          <div className="flex items-center justify-between rounded-md border border-dashed border-input bg-muted px-2 py-3 text-xs text-muted-foreground">
            <span>{activeBrush.label} options</span>
            <span className="rounded bg-background/60 px-1 text-[9px]">in progress</span>
          </div>
        )}

        {/* ── Hand-drawn — global path modifier, applies to every brush ── */}
        <SectionLabel>Hand-drawn</SectionLabel>
        <p className="px-0.5 text-[11px] leading-snug text-muted-foreground">
          Perturbs the path into a hand-drawn, wavy line.
        </p>
        <Row label="Frequency">
          <PercentField
            value={dyn.frequency}
            ariaLabel="Frequency"
            max={300}
            onChange={(v) => updateDyn({ frequency: v })}
          />
        </Row>
        <Row label="Wiggle">
          <PercentField
            value={dyn.wiggle}
            ariaLabel="Wiggle"
            max={300}
            onChange={(v) => updateDyn({ wiggle: v })}
          />
        </Row>
        <Row label="Smoothen">
          <PercentField
            value={dyn.smoothen}
            ariaLabel="Smoothen"
            onChange={(v) => updateDyn({ smoothen: v })}
          />
        </Row>
      </div>
    </FloatingPanelShell>
  )
}
