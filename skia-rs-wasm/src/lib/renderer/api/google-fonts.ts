/**
 * Google Fonts loading for text.
 *
 * render-wasm looks up a typeface by a family-name encoding `(fontId, weight,
 * style)` (see `serialized_font_family` in render-wasm `shapes/text.rs`), and
 * `_store_font` registers a face under that same key. The app never supplied a
 * font-URL resolver, so only the bundled Source Sans Pro Regular was ever
 * available and every weight / italic / family fell back to it.
 *
 * The full Google Fonts library (~1,900 families) is resolved from a metadata
 * snapshot generated into `google-fonts-catalog.json` (see
 * `scripts/gen-font-catalog.mjs`). Each variant carries a direct gstatic `.ttf`
 * URL — the format Skia's `new_from_data` needs (not woff2) — and gstatic serves
 * those with permissive CORS, so the browser can fetch them directly.
 *
 * The gstatic origin can be swapped for a self-hosted backend/proxy at build
 * time via the `FONT_BACKEND_URL` constant (see `renderer/config.ts`); the path
 * after the origin is preserved, so the backend just reverse-proxies the gstatic
 * font path (mirrors Penpot's `internal/gfonts/font` proxy).
 */

import { FONT_CATALOG_DATA, type FontCatalogVariant } from './google-fonts-catalog'
import { FONT_BACKEND_URL } from '@/lib/renderer/config'

const CATALOG = FONT_CATALOG_DATA

/** Public gstatic origin (up to `/s`) used when no `FONT_BACKEND_URL` is set. */
const GSTATIC_BASE = 'https://fonts.gstatic.com/s'

/** Origin font files load from: the build-time backend if set, else gstatic. */
const FONT_BASE = FONT_BACKEND_URL || GSTATIC_BASE

/** `[weight, italic(0|1), urlPath]` — urlPath is the gstatic URL minus the origin. */
type Variant = FontCatalogVariant

/** A family the renderer can load, surfaced to the picker. */
export interface FontFamilyMeta {
  /** Slug id written onto the span and resolved here (e.g. `robotomono`). */
  fontId: string
  /** Human label shown in the picker (e.g. `Roboto Mono`). */
  family: string
  /** Google Fonts category: sans-serif | serif | display | handwriting | monospace. */
  category: string
  /** Weights the family ships, ascending (so the weight control reflects reality). */
  weights: number[]
  /** Whether the family ships any italic face. */
  hasItalic: boolean
}

/**
 * Every loadable family, sorted by display name. Derived from the catalog so the
 * picker and the loader never drift.
 */
export const FONT_FAMILIES: readonly FontFamilyMeta[] = Object.entries(CATALOG)
  .map(([fontId, entry]) => ({
    fontId,
    family: entry.f,
    category: entry.c,
    weights: [...new Set(entry.v.map((v) => v[0]))].sort((a, b) => a - b),
    hasItalic: entry.v.some((v) => v[1] === 1),
  }))
  .sort((a, b) => a.family.localeCompare(b.family))

const META_BY_ID = new Map(FONT_FAMILIES.map((m) => [m.fontId, m]))

/** Metadata for a family by id (weights/italic availability, display name). */
export function familyMeta(fontId: string): FontFamilyMeta | undefined {
  return META_BY_ID.get(fontId)
}

/** True when the renderer has a catalog entry for this id. */
export function isKnownFont(fontId: string): boolean {
  return Object.prototype.hasOwnProperty.call(CATALOG, fontId)
}

/**
 * Picks the closest shipped variant: prefer the requested style (upright vs
 * italic); within that, the nearest weight; fall back to the other style if the
 * requested one has no faces.
 */
function pickVariant(variants: Variant[], weight: number, italic: 0 | 1): Variant | undefined {
  const sameStyle = variants.filter((v) => v[1] === italic)
  const pool = sameStyle.length ? sameStyle : variants
  if (!pool.length) return undefined
  return pool.reduce(
    (best, v) => (Math.abs(v[0] - weight) < Math.abs(best[0] - weight) ? v : best),
    pool[0],
  )
}

/**
 * Resolved font-file URL for a catalog font at the requested weight/style, or
 * `null` when the font isn't in the catalog (the caller keeps its own fallback).
 * The weight/style are snapped to the nearest face the family ships so we never
 * request a missing file.
 */
export function googleFontUrl(fontId: string, weight: number, style: string): string | null {
  const entry = CATALOG[fontId]
  if (!entry) return null
  const variant = pickVariant(entry.v, weight, style === 'italic' ? 1 : 0)
  if (!variant) return null
  return `${FONT_BASE}/${variant[2]}`
}
