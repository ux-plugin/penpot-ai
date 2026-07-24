/**
 * Brush registry — the catalog of stroke brushes shown in the picker gallery.
 *
 * A brush = a rendering engine + parameters. "Basic" is the default (the
 * standard Skia vector outline); the others are placeholders for the phased
 * brush engine (see the plan) and are marked `ready: false` until their render
 * path lands. Selecting a brush snapshots {id, engine, params} onto the stroke
 * (`toStrokeBrush`) so a shared document renders without the author's library.
 */

import type { StrokeBrush, StrokeBrushEngine } from './stroke-settings'

/** Illustrative styling for the gallery swatch until engines render real previews. */
export interface BrushPreview {
  width: number
  cap: 'butt' | 'round' | 'square'
  dash?: string
  opacity: number
}

export interface BrushDef {
  /** Stable registry id, stored on the stroke. */
  id: string
  label: string
  /** Engine that renders it — drives the option block and the render path. */
  engine: StrokeBrushEngine
  /** One-line gallery description (also searched). */
  desc: string
  /** False = shown as a disabled preview until its engine exists. */
  ready: boolean
  /** Params applied when this brush is selected. */
  defaults?: StrokeBrush['params']
  preview: BrushPreview
}

/** Small fixed wave for gallery swatches — stable, independent of hand-drawn. */
export const GALLERY_WAVE = 'M 6 17 C 26 3, 42 3, 62 17 S 98 31, 118 17'

export const DEFAULT_BRUSH_ID = 'basic'

export const BRUSHES: BrushDef[] = [
  {
    id: 'basic',
    label: 'Basic',
    engine: 'basic',
    desc: 'Standard vector outline',
    ready: true,
    preview: { width: 3, cap: 'round', opacity: 1 },
  },
  {
    id: 'marker',
    label: 'Marker',
    engine: 'texture-dab',
    desc: 'Soft felt-tip edge',
    ready: false,
    preview: { width: 6, cap: 'round', opacity: 0.7 },
  },
  {
    id: 'calligraphic',
    label: 'Calligraphic',
    engine: 'power',
    desc: 'Angled nib, variable width',
    ready: true,
    defaults: { profile: 'taper-both', nib: 45 },
    preview: { width: 4, cap: 'butt', opacity: 1 },
  },
  {
    id: 'grain',
    label: 'Grain',
    engine: 'texture-stretch',
    desc: 'Dry, grainy ink edge',
    ready: true,
    defaults: { scale: 8, density: 0.6 },
    preview: { width: 6, cap: 'round', dash: '5 2', opacity: 0.85 },
  },
]

/** PowerStroke width-envelope presets, in the order the renderer indexes them
 *  (uniform = 0). */
export const WIDTH_PROFILES = ['uniform', 'taper-both', 'taper-start', 'taper-end', 'bulge'] as const
export type WidthProfileId = (typeof WIDTH_PROFILES)[number]

/** Profile id used when width points are hand-authored (not a pickable preset). */
export const CUSTOM_PROFILE_ID = 'custom'

/** Width-profile id → renderer index. `custom` (5) is driven by `widthPoints`
 *  rather than a preset formula; anything unknown falls back to uniform/0. */
export function widthProfileIndex(id: string): number {
  if (id === CUSTOM_PROFILE_ID) return WIDTH_PROFILES.length
  const i = (WIDTH_PROFILES as readonly string[]).indexOf(id)
  return i < 0 ? 0 : i
}

/** Look up a brush by id, falling back to the default (`basic`). */
export function getBrush(id: string | undefined): BrushDef {
  return BRUSHES.find((b) => b.id === id) ?? BRUSHES[0]
}

/**
 * Snapshot a brush onto a stroke. `basic` returns `undefined` — the absent
 * `strokeBrush` *is* the default, so we don't bloat every stroke with it.
 */
export function toStrokeBrush(def: BrushDef): StrokeBrush | undefined {
  if (def.id === DEFAULT_BRUSH_ID) return undefined
  return { id: def.id, engine: def.engine, params: def.defaults }
}
