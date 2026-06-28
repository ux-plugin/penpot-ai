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
function JoinIcon({ join }: { join: StrokeBasicJoin }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
      <polyline
        points="8,22 8,8 22,8"
        fill="none"
        stroke="currentColor"
        strokeWidth="8"
        strokeLinejoin={join}
        strokeLinecap="butt"
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

export function FloatingStrokeSettingsPanel() {
  const { activeTarget, activeStrokeSettings, anchorY, closeEditor, onStrokeSettingsChangeRef } =
    useColorEditor()

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
        {/* Tabs — only Basic is implemented */}
        <div className="flex gap-0.5 rounded-md bg-muted p-0.5">
          <div className="flex-1 rounded bg-background py-1 text-center text-xs font-medium">Basic</div>
          {(['Dynamic', 'Brush'] as const).map((t) => (
            <div
              key={t}
              className="flex flex-1 items-center justify-center gap-1 py-1 text-center text-xs text-muted-foreground/60"
              title={`${t} strokes are a separate feature — not available yet`}
            >
              {t}
              <span className="rounded bg-background/60 px-1 text-[9px] leading-tight">later</span>
            </div>
          ))}
        </div>

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
      </div>
    </FloatingPanelShell>
  )
}
