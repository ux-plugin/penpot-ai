/**
 * scene3d-crop-resize — carry a 3D scene's view window along with a resize of its box.
 *
 * A RESIZE is the only gesture that writes. A move takes the whole view with it for free,
 * and Scale deliberately leaves the window untouched (that is what makes the scene change
 * size rather than reveal). Crop moves the window in step with the box so the world keeps a
 * fixed size on screen — and even Scale has to PIN a window on the first resize, or it would
 * be re-derived from whatever the box became and the scene would never resize at all.
 *
 * Rather than hooking each resize gesture, this augments the change set inside
 * `commitChanges` — the one place every geometry write passes through. So the 2D selection
 * handles, the in-edit handles and typing a width into the inspector are all covered by the
 * same code, in the SAME commit, and therefore the same undo frame: one press of undo puts
 * the box and its view back together. A second commit would have split them and made undo
 * jump the content.
 */

import type { Change } from 'penpot-exporter/types'
import type { LocalChange } from '../../changes/bulk-changes'
import { getNode } from '../store/doc-proxy'
import type { Scene3DDocument } from './scene3d-store'
import {
  defaultWindow,
  windowAfterCropResize,
  isCropMode,
  type BoxRect,
} from './scene3d-viewframe'

type ModObj = Extract<Change, { type: 'mod-obj' }>
type Op = { type: string; value?: Record<string, unknown>; attr?: string; val?: unknown }

/** Sub-pixel wobble in a committed rect shouldn't count as a resize. */
const EPS = 1e-6

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * A node's box as the RENDERER measures it: its `selrect` — the shape's own rectangle,
 * unrotated — because that is what `getSelectionRect` reports and therefore what every live
 * rect is compared against.
 *
 * Do NOT be tempted to use the axis-aligned bounds of `points` instead. They differ the
 * moment a scene is rotated at all: 0.08° on a 348×327 box inflates the bounds by ~0.46
 * units, which is far past the threshold that decides "is a resize in flight", so a crop
 * treats it as one and rebuilds its window to the box's aspect — a jump of tens of percent,
 * not a nudge. Both sides must read the same kind of rectangle.
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

/** Every attribute this change assigns, flattened across its operations. */
function assignedAttrs(change: ModObj): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const op of (change.operations ?? []) as Op[]) {
    if (op.type === 'assign' && op.value) Object.assign(out, op.value)
    else if (op.type === 'set' && op.attr) out[op.attr] = op.val
  }
  return out
}

/**
 * The box this change leaves behind, or null if it doesn't touch geometry. Reads selrect
 * first, exactly as `nodeBoxRect` does, so `before` and `after` are always the same kind of
 * rectangle and a rotated scene never looks resized purely because of how it was measured.
 */
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

/**
 * Pair the frame write onto a resize commit. Returns null — the common case, and the fast
 * path — when no crop-mode scene was resized, so the caller keeps its arrays as they are.
 *
 * Undo entries are PREPENDED to match how the changes builder orders inverses, though the
 * ordering is academic here: `scene3d` and the geometry attrs never overlap.
 */
export function augmentCropResizeChanges(
  redoChanges: readonly LocalChange[],
  undoChanges: readonly LocalChange[],
): { redoChanges: LocalChange[]; undoChanges: LocalChange[] } | null {
  let extraRedo: Change[] | null = null
  let extraUndo: Change[] | null = null

  for (const change of redoChanges) {
    if (change.type !== 'mod-obj') continue
    const node = getNode(change.id) as { scene3d?: Scene3DDocument } | undefined
    const doc = node?.scene3d
    if (!doc) continue

    const attrs = assignedAttrs(change)
    // A caller writing scene3d itself owns the frame; don't fight it.
    if ('scene3d' in attrs) continue

    const before = nodeBoxRect(node)
    if (!before) continue
    const after = rectAfter(before, attrs)
    // Not geometry, or a pure move — a move takes the whole view with it, nothing to write.
    if (!after || sameSize(before, after)) continue

    // The window has to be pinned down BEFORE the box changes, in either mode. Left to be
    // re-derived from whatever the box became, a Scale resize would just re-fit the new box
    // every time and the scene would never actually change size.
    const stored = doc.viewWindow
    const win = stored ?? defaultWindow(before.w, before.h)
    // SCALE leaves the window alone — that is what makes the scene scale rather than reveal.
    // CROP tracks the box with it, so the world keeps a fixed size on screen.
    const next = isCropMode(doc) ? windowAfterCropResize(win, before, after) : win
    if (stored && next === win) continue // already pinned, and Scale has nothing to move

    // `scene3d` is one opaque blob, so the pair carries whole documents.
    const pageId = (change as { pageId?: string }).pageId
    const write = (value: Scene3DDocument): Change => {
      const base: ModObj = {
        type: 'mod-obj',
        id: change.id,
        operations: [{ type: 'assign', value: { scene3d: value } }],
      } as ModObj
      return (pageId ? { ...base, pageId } : base) as Change
    }
    // Clone the doc so the redo change never aliases the live document object.
    const nextDoc = { ...(JSON.parse(JSON.stringify(doc)) as Scene3DDocument), viewWindow: next }
    ;(extraRedo ??= []).push(write(nextDoc))
    ;(extraUndo ??= []).push(write(JSON.parse(JSON.stringify(doc)) as Scene3DDocument))
  }

  if (!extraRedo || !extraUndo) return null
  return {
    redoChanges: [...redoChanges, ...extraRedo],
    undoChanges: [...extraUndo, ...undoChanges],
  }
}
