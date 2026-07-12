/**
 * Deterministic, reversible font slug ⇄ UUID mapping.
 *
 * The WASM renderer keys every font by a 16-byte UUID (`FontFamily.id`, the font
 * cache key), but our *persisted* identity is the catalog slug (e.g.
 * "sourcesanspro"). Penpot does the same split — its content stores the font-id
 * string ("gfont-roboto") and assigns each Google font a *random* build-time
 * UUID held in a runtime fontsdb; the UUID never leaves the session.
 *
 * We mirror that, but make the UUID **deterministic** — a hash of the slug
 * formatted as a UUID string — so we can keep an exact **reverse** map
 * (UUID → slug). That reverse direction is what lets us read styled content back
 * out of the WASM editor on commit (the editor only knows the UUID) and recover
 * the slug the document model needs.
 *
 * Every catalog slug is seeded at load; off-catalog slugs are derived on demand
 * and memoised, so both directions stay total. The UUID is only ever a transient
 * cache key — it is never persisted — so the exact hash is unimportant; only
 * determinism and reversibility within a session matter.
 */

import { FONT_CATALOG_DATA } from './google-fonts-catalog'
import { u32ToUUID } from '@skia-rs-wasm/common/conversions'

const ZERO_UUID = '00000000-0000-0000-0000-000000000000'
/** Slug the renderer treats as the default family (uuid/zero maps here). */
const DEFAULT_SLUG = 'sourcesanspro'

/** 32-bit FNV-1a with a seed; four seeded passes give 128 independent-ish bits. */
function fnv1a(str: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * Deterministic UUID-format string for a slug. Uses `u32ToUUID` (the same
 * formatter the font pipeline reads back with) over four seeded hashes, so a
 * slug always yields the identical UUID within a session.
 */
function deriveUuid(slug: string): string {
  return u32ToUUID([fnv1a(slug, 0), fnv1a(slug, 1), fnv1a(slug, 2), fnv1a(slug, 3)])
}

const slugToUuidMap = new Map<string, string>()
const uuidToSlugMap = new Map<string, string>()

// Seed every catalog slug up front so the common case is a plain lookup and the
// reverse map is populated for commit-time resolution.
for (const slug of Object.keys(FONT_CATALOG_DATA)) {
  const uuid = deriveUuid(slug)
  slugToUuidMap.set(slug, uuid)
  uuidToSlugMap.set(uuid, slug)
}

/**
 * Slug → WASM font UUID. Off-catalog slugs are derived and memoised (both
 * directions) so a later `fontUuidToSlug` can still recover them. Empty/missing
 * slugs map to uuid/zero (the renderer's default font).
 */
export function fontSlugToUuid(slug: string | undefined | null): string {
  // The default family is render-wasm's bundled face, keyed by the zero UUID
  // (`default_font_uuid() = Uuid::nil()`, registered at nil/400/Normal). Alias the
  // default slug to it so picking "Source Sans Pro" — and untyped default text that
  // resolves to this slug — uses the bundled font: no gstatic fetch, no offline
  // "unavailable" flag, exactly like a span with no font set.
  if (!slug || slug === DEFAULT_SLUG) return ZERO_UUID
  const hit = slugToUuidMap.get(slug)
  if (hit) return hit
  const uuid = deriveUuid(slug)
  slugToUuidMap.set(slug, uuid)
  uuidToSlugMap.set(uuid, slug)
  return uuid
}

/**
 * WASM font UUID → slug. Unknown ids (or uuid/zero) fall back to the default
 * family, matching the renderer's own uuid/zero → default behaviour.
 */
export function fontUuidToSlug(uuid: string | undefined | null): string {
  if (!uuid || uuid === ZERO_UUID) return DEFAULT_SLUG
  return uuidToSlugMap.get(uuid) ?? DEFAULT_SLUG
}

/**
 * WASM font UUID → slug, or null when the id is unknown (or uuid/zero). Lets
 * callers fall back to a known-good original family instead of forcing the
 * default — used on commit so an unmapped id doesn't silently retype the text.
 */
export function fontUuidToSlugOrNull(uuid: string | undefined | null): string | null {
  if (!uuid || uuid === ZERO_UUID) return null
  return uuidToSlugMap.get(uuid) ?? null
}
