import { useCallback } from 'react'
import type { Fill, Shadow } from 'penpot-exporter/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { fillSwatchBackground } from '../../FillEditor/fill-swatch-background'
import { isColorFill } from '../../../renderer/api/constants'
import { normalizeHex } from '../../../renderer/properties/panel-utils'
import type { EffectItem, EffectKind, Noise } from '../../../renderer/properties/panel-utils'
import { DEFAULT_SHADOW, DEFAULT_BLUR, DEFAULT_NOISE } from '../../../renderer/properties/panel-utils'
import { useColorEditorFor } from '../use-color-editor'

const EFFECT_KIND_OPTIONS: { value: EffectKind; label: string }[] = [
  { value: 'drop-shadow', label: 'Drop shadow' },
  { value: 'inner-shadow', label: 'Inner shadow' },
  { value: 'layer-blur', label: 'Layer blur' },
  { value: 'noise', label: 'Noise' },
]

/** Convert Shadow color to a Fill so FillEditor can be reused. */
function shadowColorToFill(shadow: Shadow): Fill {
  if (shadow.color?.gradient) {
    return { fillColorGradient: shadow.color.gradient }
  }
  return {
    fillColor: shadow.color?.color ?? '#000000',
    fillOpacity: shadow.color?.opacity ?? 1,
  }
}

/** Merge Fill color fields back into a Shadow. */
function fillToShadowColor(fill: Fill, existing: Shadow): Shadow {
  if (fill.fillColorGradient) {
    return {
      ...existing,
      color: { gradient: fill.fillColorGradient },
    }
  }
  return {
    ...existing,
    color: {
      color: fill.fillColor ?? '#000000',
      opacity: fill.fillOpacity ?? 1,
    },
  }
}

/** Extract the hidden flag from any effect item. */
function getEffectHidden(item: EffectItem): boolean {
  if (item.kind === 'layer-blur') return item.blur.hidden
  if (item.kind === 'noise') return item.noise.hidden ?? false
  return item.shadow.hidden
}

/** Convert between effect kinds, preserving hidden state. */
function convertEffect(current: EffectItem, newKind: EffectKind): EffectItem {
  const hidden = getEffectHidden(current)

  if (newKind === 'noise') {
    return { kind: 'noise', noise: { ...DEFAULT_NOISE, hidden } }
  }
  if (newKind === 'layer-blur') {
    return { kind: 'layer-blur', blur: { ...DEFAULT_BLUR, hidden } }
  }
  if (current.kind === 'layer-blur' || current.kind === 'noise') {
    return { kind: newKind, shadow: { ...DEFAULT_SHADOW, style: newKind, hidden } }
  }
  // Shadow → Shadow (different style)
  return { kind: newKind, shadow: { ...current.shadow, style: newKind } }
}

export interface EffectRowProps {
  effect: EffectItem
  index: number
  readOnly: boolean
  onChange: (effect: EffectItem, index: number) => void
  onRemove: (index: number) => void
}

export function EffectRow({ effect, index, readOnly, onChange, onRemove }: EffectRowProps) {
  const isShadow = effect.kind === 'drop-shadow' || effect.kind === 'inner-shadow'
  const isNoise = effect.kind === 'noise'
  const shadow = isShadow ? effect.shadow : null
  const blur = effect.kind === 'layer-blur' ? effect.blur : null
  const noise = isNoise ? effect.noise : null

  const { isActive: expanded, openEditor, closeEditor } = useColorEditorFor('shadow', index)

  const fill = shadow ? shadowColorToFill(shadow) : null
  const isSolid = fill ? isColorFill(fill) : false
  const swatchBg = fill ? fillSwatchBackground(fill) : '#94a3b8'

  const hexDisplay = shadow
    ? isSolid
      ? (shadow.color?.color ?? '#000000')
      : 'Gradient'
    : ''
  const opacity = shadow?.color?.opacity ?? 1

  const handleKindChange = useCallback(
    (newKind: EffectKind) => {
      if (newKind === effect.kind) return
      // Close shadow color editor if switching away from shadow kinds
      if (expanded && (newKind === 'layer-blur' || newKind === 'noise')) closeEditor()
      onChange(convertEffect(effect, newKind), index)
    },
    [effect, index, onChange, expanded, closeEditor],
  )

  const handleShadowUpdate = useCallback(
    (partial: Partial<Shadow>) => {
      if (!shadow) return
      onChange({ kind: effect.kind as 'drop-shadow' | 'inner-shadow', shadow: { ...shadow, ...partial } }, index)
    },
    [shadow, effect.kind, index, onChange],
  )

  const handleHexChange = useCallback(
    (raw: string) => {
      if (!shadow || !isSolid) return
      const v = raw.trim()
      if (/^#[0-9A-Fa-f]{6}$/.test(v) || /^#[0-9A-Fa-f]{3}$/.test(v)) {
        handleShadowUpdate({ color: { ...shadow.color, color: normalizeHex(v) } })
      }
    },
    [shadow, isSolid, handleShadowUpdate],
  )

  const handleOpacityChange = useCallback(
    (pct: number) => {
      if (!shadow || !isSolid) return
      const v = Math.max(0, Math.min(100, pct)) / 100
      handleShadowUpdate({ color: { ...shadow.color, opacity: v } })
    },
    [shadow, isSolid, handleShadowUpdate],
  )

  const handleNoiseUpdate = useCallback(
    (partial: Partial<Noise>) => {
      if (!noise) return
      onChange({ kind: 'noise', noise: { ...noise, ...partial } }, index)
    },
    [noise, index, onChange],
  )

  const toggleExpand = useCallback(
    (e: React.MouseEvent) => {
      if (readOnly || !shadow) return
      if (expanded) {
        closeEditor()
      } else {
        const y = (e.currentTarget as HTMLElement).getBoundingClientRect().top
        openEditor(fill!, y, `Shadow ${index + 1} color`, (nextFill) => {
          onChange(
            { kind: effect.kind as 'drop-shadow' | 'inner-shadow', shadow: fillToShadowColor(nextFill, shadow) },
            index,
          )
        })
      }
    },
    [readOnly, shadow, expanded, closeEditor, openEditor, fill, index, effect.kind, onChange],
  )

  if (readOnly) {
    return (
      <div className="space-y-1">
        <div className="flex min-h-8 items-center gap-1.5">
          {isShadow && (
            <div
              className="size-5 shrink-0 rounded border border-border"
              style={{ background: swatchBg }}
              aria-hidden
            />
          )}
          {isNoise && noise && (
            <div
              className="size-5 shrink-0 rounded border border-border"
              style={{ background: noise.color?.color ?? '#000000' }}
              aria-hidden
            />
          )}
          <span className="text-xs text-muted-foreground">
            {EFFECT_KIND_OPTIONS.find((o) => o.value === effect.kind)?.label ?? 'Effect'}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {/* Row 1: swatch (shadow only) + type dropdown + remove */}
      <div className="flex min-h-8 items-center gap-1.5">
        {isShadow && (
          <button
            type="button"
            onClick={toggleExpand}
            className={cn(
              'size-5 shrink-0 rounded border border-border',
              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              expanded && 'ring-2 ring-ring',
            )}
            style={{ background: swatchBg }}
            title={expanded ? 'Close shadow color editor' : 'Open shadow color editor'}
            aria-expanded={expanded}
            aria-label="Toggle shadow color editor"
          />
        )}
        {isNoise && noise && (
          <div
            className="size-5 shrink-0 rounded border border-border"
            style={{ background: noise.color?.color ?? '#000000' }}
            aria-hidden
          />
        )}
        <select
          className="border-input bg-background h-8 min-w-0 flex-1 rounded-md border px-1.5 text-xs"
          value={effect.kind}
          onChange={(e) => handleKindChange(e.target.value as EffectKind)}
          title="Effect type"
        >
          {EFFECT_KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          onClick={() => onRemove(index)}
          aria-label="Remove effect"
        >
          ×
        </Button>
      </div>

      {/* Row 2 for shadows: hex + opacity */}
      {isShadow && shadow && (
        <div className="flex min-h-8 items-center gap-1.5">
          <Input
            type="text"
            className="h-8 min-w-0 flex-1 font-mono text-xs"
            value={hexDisplay}
            placeholder={isSolid ? '#RRGGBB' : undefined}
            disabled={!isSolid}
            readOnly={!isSolid}
            onChange={(e) => handleHexChange(e.target.value)}
          />
          <span className="shrink-0 text-xs text-muted-foreground">%</span>
          <Input
            type="number"
            className="h-8 w-12 shrink-0 px-1 text-xs"
            min={0}
            max={100}
            value={isSolid ? Math.round(opacity * 100) : 100}
            disabled={!isSolid}
            onChange={(e) => handleOpacityChange(Number(e.target.value))}
          />
        </div>
      )}

      {/* Row 3 for shadows: X, Y, blur, spread */}
      {isShadow && shadow && (
        <div className="flex min-h-7 items-center gap-1.5">
          <Input
            type="number"
            className="h-7 w-14 shrink-0 px-1 text-xs"
            step={1}
            value={shadow.offsetX}
            onChange={(e) => handleShadowUpdate({ offsetX: parseFloat(e.target.value) || 0 })}
            title="X offset"
          />
          <Input
            type="number"
            className="h-7 w-14 shrink-0 px-1 text-xs"
            step={1}
            value={shadow.offsetY}
            onChange={(e) => handleShadowUpdate({ offsetY: parseFloat(e.target.value) || 0 })}
            title="Y offset"
          />
          <Input
            type="number"
            className="h-7 w-14 shrink-0 px-1 text-xs"
            min={0}
            step={1}
            value={shadow.blur}
            onChange={(e) => handleShadowUpdate({ blur: Math.max(0, parseFloat(e.target.value) || 0) })}
            title="Blur"
          />
          <Input
            type="number"
            className="h-7 w-14 shrink-0 px-1 text-xs"
            step={1}
            value={shadow.spread}
            onChange={(e) => handleShadowUpdate({ spread: parseFloat(e.target.value) || 0 })}
            title="Spread"
          />
        </div>
      )}

      {/* Row 2 for blur: value */}
      {!isShadow && blur && (
        <div className="flex min-h-7 items-center gap-1.5">
          <span className="shrink-0 text-xs text-muted-foreground">Value</span>
          <Input
            type="number"
            className="h-7 w-20 shrink-0 px-1 text-xs"
            min={0}
            step={1}
            value={blur.value}
            onChange={(e) =>
              onChange(
                { kind: 'layer-blur', blur: { ...blur, value: Math.max(0, parseFloat(e.target.value) || 0) } },
                index,
              )
            }
            title="Blur value"
          />
        </div>
      )}

      {/* Noise-specific controls */}
      {isNoise && noise && (
        <>
          {/* Row 2: noise subtype + size */}
          <div className="flex min-h-7 items-center gap-1.5">
            <select
              className="border-input bg-background h-7 min-w-0 flex-1 rounded-md border px-1.5 text-xs"
              value={noise.noiseType ?? 'monotone'}
              onChange={(e) => handleNoiseUpdate({ noiseType: e.target.value as Noise['noiseType'] })}
              title="Noise type"
            >
              <option value="monotone">Monotone</option>
              <option value="duotone">Duotone</option>
              <option value="multitone">Multitone</option>
            </select>
            <span className="shrink-0 text-xs text-muted-foreground">Size</span>
            <Input
              type="number"
              className="h-7 w-16 shrink-0 px-1 text-xs"
              min={1}
              max={500}
              step={1}
              value={noise.noiseSize ?? 50}
              onChange={(e) =>
                handleNoiseUpdate({ noiseSize: Math.max(1, Math.min(500, parseFloat(e.target.value) || 1)) })
              }
              title="Noise size"
            />
          </div>

          {/* Row 3: primary color hex */}
          <div className="flex min-h-7 items-center gap-1.5">
            <span className="shrink-0 text-xs text-muted-foreground">Color</span>
            <Input
              type="text"
              className="h-7 min-w-0 flex-1 font-mono text-xs"
              value={noise.color?.color ?? '#000000'}
              placeholder="#RRGGBB"
              onChange={(e) => {
                const v = e.target.value.trim()
                if (/^#[0-9A-Fa-f]{6}$/.test(v) || /^#[0-9A-Fa-f]{3}$/.test(v)) {
                  handleNoiseUpdate({ color: { ...noise.color, color: normalizeHex(v) } })
                }
              }}
              title="Primary color"
            />
            <span className="shrink-0 text-xs text-muted-foreground">%</span>
            <Input
              type="number"
              className="h-7 w-12 shrink-0 px-1 text-xs"
              min={0}
              max={100}
              value={Math.round((noise.color?.opacity ?? 1) * 100)}
              onChange={(e) =>
                handleNoiseUpdate({
                  color: { ...noise.color, opacity: Math.max(0, Math.min(100, Number(e.target.value))) / 100 },
                })
              }
              title="Primary color opacity"
            />
          </div>

          {/* Row 4: density (hidden for monotone) */}
          {noise.noiseType !== 'monotone' && (
            <div className="flex min-h-7 items-center gap-1.5">
              <span className="shrink-0 text-xs text-muted-foreground">Density</span>
              <Input
                type="number"
                className="h-7 w-20 shrink-0 px-1 text-xs"
                min={0}
                max={1}
                step={0.01}
                value={noise.density ?? 0.5}
                onChange={(e) =>
                  handleNoiseUpdate({ density: Math.max(0, Math.min(1, parseFloat(e.target.value) || 0)) })
                }
                title="Density"
              />
            </div>
          )}

          {/* Row 5: secondary color (duotone only) */}
          {noise.noiseType === 'duotone' && (
            <div className="flex min-h-7 items-center gap-1.5">
              <span className="shrink-0 text-xs text-muted-foreground">Secondary</span>
              <Input
                type="text"
                className="h-7 min-w-0 flex-1 font-mono text-xs"
                value={noise.secondaryColor?.color ?? '#ffffff'}
                placeholder="#RRGGBB"
                onChange={(e) => {
                  const v = e.target.value.trim()
                  if (/^#[0-9A-Fa-f]{6}$/.test(v) || /^#[0-9A-Fa-f]{3}$/.test(v)) {
                    handleNoiseUpdate({ secondaryColor: { ...noise.secondaryColor, color: normalizeHex(v) } })
                  }
                }}
                title="Secondary color"
              />
              <span className="shrink-0 text-xs text-muted-foreground">%</span>
              <Input
                type="number"
                className="h-7 w-12 shrink-0 px-1 text-xs"
                min={0}
                max={100}
                value={Math.round((noise.secondaryColor?.opacity ?? 1) * 100)}
                onChange={(e) =>
                  handleNoiseUpdate({
                    secondaryColor: {
                      ...noise.secondaryColor,
                      opacity: Math.max(0, Math.min(100, Number(e.target.value))) / 100,
                    },
                  })
                }
                title="Secondary color opacity"
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
