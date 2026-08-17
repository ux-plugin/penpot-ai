/**
 * Slot shape — a Build-mode SPA "router outlet".
 *
 * A slot is a *reference* node, not a container: it owns no children. It marks a
 * region of a shell frame and points at one or more candidate view frames, one of
 * which renders at a time. This is the instance↔main relationship (like a
 * component instance referencing its main), NOT the parent↔child relationship a
 * frame has with its `shapes`. Keeping these distinct preserves the invariant that
 * a frame has exactly one geometric parent while a view can be shown by many slots.
 *
 * Defined locally (the `penpot-exporter` submodule is read-only); `SlotShape` is
 * not part of the upstream `PenpotNode` union, so local code that may encounter a
 * slot narrows via `LocalNode` + `isSlotShape` (see worker/geometry/shapes.ts).
 */
import type { FrameShape, PenpotNode } from 'penpot-exporter/types'

/**
 * Geometry/layout is reused wholesale from `FrameShape` so a slot participates in
 * the shell's auto-layout exactly like a frame would. Two upstream keys are
 * replaced:
 *   - `type`   → the `'slot'` discriminant
 *   - `shapes` → dropped; a slot references views, it does not own children
 */
export type SlotShape = Omit<FrameShape, 'type' | 'shapes'> & {
  type: 'slot'
  /** Candidate view-frame ids this slot can show (Uuid). */
  views: string[]
  /** Which view renders at edit time — the default. Undefined = empty slot. */
  activeView?: string
}

/**
 * `PenpotNode` widened with the locally-defined `SlotShape`. Use this as the
 * parameter type anywhere a value may be a slot so the `type === 'slot'` narrowing
 * type-checks (the upstream union has no `'slot'` member).
 */
export type LocalNode = PenpotNode | SlotShape
