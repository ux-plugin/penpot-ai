/**
 * Explicit geometry defaults so undo can restore them.
 *
 * `r1–r4` and `rotation` start out `undefined` on freshly created and many
 * loaded shapes. The undo snapshot (snapshotAttrsForUndo) can't capture an
 * absent attribute, so the first edit (unset → N) can't be undone back to 0 —
 * the value bottoms out at the first explicitly-set step. Normalizing these to
 * an explicit 0 at ingestion makes the committed `before` carry real values, so
 * undo restores 0 cleanly. 0 renders identically to unset, so there's no visual
 * or round-trip change.
 */

/** Shape types that carry corner radius — matches the Appearance panel's radius gating. */
const RADIUS_TYPES = new Set<string>(['rect', 'image', 'frame', 'instance', 'component'])

interface GeomDefaultsShape {
  type?: string
  rotation?: number
  r1?: number
  r2?: number
  r3?: number
  r4?: number
}

/**
 * Fill `rotation: 0` on every shape and `r1–r4: 0` on rect-backed shapes, only
 * where absent (never overwrites real values). Returns the same reference when
 * nothing needs filling, so it's a cheap no-op on already-normalized shapes and
 * is safe to call idempotently (e.g. on redo replay).
 */
export function applyGeometryDefaults<T extends GeomDefaultsShape>(node: T): T {
  const isRadiusType = node.type != null && RADIUS_TYPES.has(node.type)
  const needsRotation = node.rotation == null
  const needsRadius =
    isRadiusType &&
    (node.r1 == null || node.r2 == null || node.r3 == null || node.r4 == null)
  if (!needsRotation && !needsRadius) return node

  const out: T = { ...node }
  if (needsRotation) out.rotation = 0
  if (needsRadius) {
    out.r1 = node.r1 ?? 0
    out.r2 = node.r2 ?? 0
    out.r3 = node.r3 ?? 0
    out.r4 = node.r4 ?? 0
  }
  return out
}
