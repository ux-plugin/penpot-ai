/**
 * Tracks which font FACES (family + weight + italic) resolved to real bytes vs.
 * fell back to the bundled default (Source Sans Pro). Written by the font loader
 * (`api/text.ts`) when a face loads or fails; read by the typography UI and the font
 * picker.
 *
 * Per-FACE granularity matters: a missing weight on an otherwise-available family
 * must still be caught — per-family tracking would report the family as available
 * and miss it. `familyStatuses` rolls faces back up to a per-family view for the two
 * indicator scopes (whole family missing vs. just a weight).
 */
import { create } from 'zustand'

export type FontAvailability = 'available' | 'substituted'

/**
 * Stable key for one font face — the granularity the renderer actually loads (each
 * weight/style is a separate typeface). `fontId` is a slug (alphanumerics only, no
 * `|`), so the separator is unambiguous.
 */
export function faceKey(fontId: string, weight: number, italic: boolean): string {
  return `${fontId}|${weight}|${italic ? 'i' : 'n'}`
}

interface FontAvailabilityState {
  byFace: Record<string, FontAvailability>
  markAvailable: (key: string) => void
  markSubstituted: (key: string) => void
}

export const useFontAvailabilityStore = create<FontAvailabilityState>()((set) => ({
  byFace: {},
  markAvailable: (key) =>
    set((s) =>
      s.byFace[key] === 'available' ? s : { byFace: { ...s.byFace, [key]: 'available' } },
    ),
  markSubstituted: (key) =>
    set((s) =>
      // 'available' wins (a loaded face stays loaded); don't churn on repeats.
      s.byFace[key] ? s : { byFace: { ...s.byFace, [key]: 'substituted' } },
    ),
}))

export type FamilyStatus = 'available' | 'missing'

/**
 * Per-family rollup of the face map: 'available' if ANY face of the family loaded,
 * else 'missing' if ≥1 face failed, else absent (untried). `available` wins
 * regardless of iteration order — a present family always has at least one loaded
 * face, so a single missing weight never marks the whole family "missing".
 */
export function familyStatuses(
  byFace: Record<string, FontAvailability>,
): Map<string, FamilyStatus> {
  const out = new Map<string, FamilyStatus>()
  for (const key in byFace) {
    const fontId = key.slice(0, key.indexOf('|'))
    if (byFace[key] === 'available') out.set(fontId, 'available')
    else if (out.get(fontId) !== 'available') out.set(fontId, 'missing')
  }
  return out
}
