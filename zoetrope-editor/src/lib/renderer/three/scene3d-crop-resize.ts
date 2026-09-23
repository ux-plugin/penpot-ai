/**
 * scene3d-crop-resize — carry a 3D scene's view window along with a resize of its box.
 *
 * A RESIZE is the only gesture that writes. A move takes the whole view with it for free,
 * and Scale deliberately leaves the window untouched (that is what makes the scene change
 * size rather than reveal). Crop moves the window in step with the box so the world keeps a
 * fixed size on screen — and even Scale has to PIN a window on the first resize, or it would
 * be re-derived from whatever the box became and the scene would never resize at all.
 *
 * An effect of `commitChanges` — the one place every geometry write passes through — so the
 * 2D handles, the in-edit handles and typing a width into the inspector are all covered, in
 * the SAME commit and undo frame.
 */
import type { Effect, LocalChange } from '../../doc'
import { getNode, mod } from '../../doc'
import type { Scene3DDocument } from './scene3d-store'
import { defaultWindow, windowAfterCropResize, isCropMode, type BoxRect } from './scene3d-viewframe'

/** Sub-pixel wobble in a committed rect shouldn't count as a resize. */
const EPS = 1e-6

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * A node's box as the RENDERER measures it: its `selrect` — the shape's own rectangle,
 * unrotated — because that is what `getSelectionRect` reports and therefore what every live
 * rect is compared against. Not the bounds of `points`: those inflate under any rotation.
 */
export function nodeBoxRect(node: unknown): BoxRect | null {
  const n = node as
    | { selrect?: Record<string, unknown>; x?: unknown; y?: unknown; width?: unknown; height?: unknown }
    | undefined
  if (!n) return null
  const sr = n.selrect
  const x = num(sr?.x) ?? num(n.x)
  const y = num(sr?.y) ?? num(n.y)
  const w = num(sr?.width) ?? num(n.width)
  const h = num(sr?.height) ?? num(n.height)
  if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) return null
  return { x, y, w, h }
}

function rectAfter(before: BoxRect, attrs: Record<string, unknown>): BoxRect | null {
  const sr = attrs.selrect as Record<string, unknown> | undefined
  const fromSelrect = sr ? nodeBoxRect({ selrect: sr }) : null
  if (fromSelrect) return fromSelrect
  const x = num(attrs.x)
  const y = num(attrs.y)
  const w = num(attrs.width)
  const h = num(attrs.height)
  if (x === null && y === null && w === null && h === null) return null
  const next = { x: x ?? before.x, y: y ?? before.y, w: w ?? before.w, h: h ?? before.h }
  return next.w > 0 && next.h > 0 ? next : null
}

function sameSize(a: BoxRect, b: BoxRect): boolean {
  return Math.abs(a.w - b.w) < EPS && Math.abs(a.h - b.h) < EPS
}

/** Pair the frame write onto a resize commit. Returns nothing in the common case. */
export const cropResizeEffect: Effect = (changes) => {
  const out: LocalChange[] = []
  for (const change of changes) {
    if (change.op !== 'mod' || change.kind !== 'node') continue
    const node = getNode(change.id)
    const doc = node?.scene3d
    if (!doc) continue
    const attrs = change.set as Record<string, unknown>
    // A caller writing scene3d itself owns the frame; don't fight it.
    if ('scene3d' in attrs) continue
    const before = nodeBoxRect(node)
    if (!before) continue
    const after = rectAfter(before, attrs)
    if (!after || sameSize(before, after)) continue

    const stored = doc.viewWindow
    const win = stored ?? defaultWindow(before.w, before.h)
    const next = isCropMode(doc) ? windowAfterCropResize(win, before, after) : win
    if (stored && next === win) continue

    const nextDoc = { ...(JSON.parse(JSON.stringify(doc)) as Scene3DDocument), viewWindow: next }
    out.push(mod('node', change.id, { scene3d: nextDoc }))
  }
  return out
}
