/**
 * Floating "Stroke settings" panel — the Basic tab (custom dashes + dash cap +
 * join + miter angle), opened from the stroke row's sliders button. Models
 * Figma's stroke-settings dialog and reuses the side-editor pattern
 * (`FloatingPanelShell` + the color-editor context's stroke-settings track).
 *
 * Dynamic / Brush tabs and the Width-profile control are shown disabled — they
 * are separate, much larger features (procedural path deformation, a brush
 * engine, variable-width stroking) the renderer has no foundation for yet.
 */

import { useCallback, useState, type ReactNode } from 'react'
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
import { useColorEditor } from './use-color-editor'
import { FloatingPanelShell } from './FloatingPanelShell'
import { NumericField } from './NumericField'

const STYLE_OPTIONS = ['solid', 'dotted', 'dashed', 'mixed', 'custom'] as const
type StyleOption = (typeof STYLE_OPTIONS)[number]

const DASH_CAP_OPTIONS: StrokeDashCap[] = ['butt', 'round', 'square']
const JOIN_OPTIONS: StrokeBasicJoin[] = ['miter', 'round', 'bevel']

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

export function FloatingStrokeSettingsPanel() {
  const { activeTarget, activeStrokeSettings, anchorY, closeEditor, onStrokeSettingsChangeRef } =
    useColorEditor()

  const [tab, setTab] = useState<'basic' | 'dynamic'>('basic')

  // Local draft for the dashes text field so intermediate text ("8, ", "8, 6,")
  // isn't clobbered by re-parsing on every keystroke (mirrors the hex drafts).
  const [dashDraft, setDashDraft] = useState<string | null>(null)

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

  const header = <span className="text-xs font-medium">Stroke settings</span>

  return (
    <FloatingPanelShell
      targetKey={targetKey}
      anchorY={anchorY}
      title={header}
      width={300}
      onClose={closeEditor}
    >
      <div className="space-y-2.5">
        {/* Tabs — Basic + Dynamic active; Brush deferred */}
        <div className="flex gap-0.5 rounded-md bg-muted p-0.5">
          {(['basic', 'dynamic'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                'flex-1 rounded py-1 text-center text-xs capitalize transition-colors',
                tab === t
                  ? 'bg-background font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t}
            </button>
          ))}
          <div
            className="flex flex-1 items-center justify-center gap-1 py-1 text-center text-xs text-muted-foreground/60"
            title="Brush strokes are a separate feature — not available yet"
          >
            Brush
            <span className="rounded bg-background/60 px-1 text-[9px] leading-tight">later</span>
          </div>
        </div>

        {tab === 'basic' && (
          <>
            {/* Style */}
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
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Input
                type="text"
                className="h-7 min-w-0 font-mono text-xs"
                value={dashDraft ?? dashes.join(', ')}
                placeholder="8, 6, 2, 6"
                onChange={(e) => onDashesText(e.target.value)}
                onBlur={() => setDashDraft(null)}
                aria-label="Dash pattern"
              />
              {hasDashes && (
                <svg
                  viewBox="0 0 260 8"
                  preserveAspectRatio="none"
                  className="h-2 w-full text-foreground"
                  aria-hidden
                >
                  <line
                    x1="1"
                    y1="4"
                    x2="259"
                    y2="4"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeDasharray={dashes.join(' ')}
                  />
                </svg>
              )}
            </div>
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

        {/* Join */}
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
        )}

        {tab === 'dynamic' && (
          <>
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
          </>
        )}
      </div>
    </FloatingPanelShell>
  )
}
