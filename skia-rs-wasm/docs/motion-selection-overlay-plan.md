# Motion selection + overlay — implementation plan (V0)

Status: planned. Branch: `worktree-motion-timeline-spike`. TS-only (no wasm rebuild).

## Problem

When the timeline is **paused mid-animation**, a shape is *drawn* at its animated
position (via a render-time modifier) but the selection **hit-test index still holds
it at its rest position**. Result: clicking the shape you see selects nothing; the
empty rest slot still "catches" clicks. Two coordinate spaces disagree.

- Render truth: `document rest ⊕ modifier` (drawn), applied in render-wasm via
  `setWasmModifiers` — the same channel the drag handlers use for live previews.
- Hit-test truth: the worker's quadtree + `overlaps`/`overlapsPath`, built from
  **rest** geometry (`indexShape` → `shapeToBounds`). Never sees the modifier.

## Core principle

The design **document stores the rest pose only**. Animation lives in the anim doc as
deltas. The canvas shows `rest ⊕ modifier`. Selection must **read** the composed
(evaluated) pose but **write back** to whichever layer owns the change (anim doc for
animated props; document for the rest). This keeps "going back" free: scrub to 0 /
stop clears the modifier → shape at rest, document and undo untouched.

## Locked decisions

1. **Modifier-aware hit-testing in the worker** (not a main-thread pre-pass). Reuses
   the existing `updateIndexSingle` seam. Unifies design ↔ animated hit-testing and
   extends to marquee/deform. Worker index stays at rest by default; a transient
   "hit-transform layer" is applied on pause/scrub and cleared on stop.
2. **Paused-only.** Special pick + full overlay only when a shape's modifier is active
   and playback isn't running. Selection is disabled during active playback.
3. **Non-destructive.** No document mutation during playback. Stop → rest, zero residue.
4. **Badge = selection-gated.** The small "has motion" square shows only when an
   animated shape is **selected** (clean canvas otherwise). Clicking it toggles the
   path overlay for that shape.
5. **Progressive disclosure.** Full overlay when `motionMode || (selected &&
   showMotionPaths)`; badge on `selected && hasMotion`; nothing during active playback.
6. **Overlay = motion path + start/end onion-skin ghosts + read-only keyframe diamonds
   + live selection box/handles on the evaluated transform.**

## Architecture — JS is the hub, two consumers, two cadences

The transforms originate in the **evaluator** (today the TS engine
`evaluateTimelinesTs` on the main thread; optionally the Rust runtime `rustEval`
reading render-wasm's `HEAPF32`). Either way JS ends up holding the per-node
props → matrices (`propsToModifier`).

```
          per-node props (eval: TS main-thread, or Rust→HEAPF32)
                              |
                          [ JS hub ]  -- propsToModifier --> matrices
                          /            \
            every frame  /              \  ONLY on pause / scrub
                        v                v
                 render-wasm         selection worker (postMessage)
                 setWasmModifiers    quadtree.removeAll(id) + insert
                 (draw the shape)    (+ hitTransform)   <- the "lazy" update
```

"Lazily" means: event-driven (pause / scrub-settle), **animated shapes only** (tiny
payload), skipped during active playback, cleared on stop. The worker never talks to
wasm; JS mediates. render-wasm gets the fast per-frame stream to *draw*; the worker
gets the occasional pause/scrub snapshot to *hit-test*. Same matrices, two rates.

## Broad / narrow phase — the transform-aware index

You already run the industry two-phase scheme:

- **Broad phase:** quadtree over world-space AABBs (`worker/quadtree.ts`,
  `indexShape` → `quadtree.insert(index, id, bound, data)`).
- **Narrow phase:** exact `overlaps` → `overlapsPath` (flattens real segments).
- `updateIndexSingle` already does `quadtree.removeAll(id)` + re-insert per shape.

Extend it, don't replace it. Add a per-entry **current-frame geometry provider**:

| Motion tier | Broad-phase input | Narrow-phase test | Cost |
|---|---|---|---|
| Affine (move/rotate/scale/skew) | transformed AABB | inverse-map query by `M⁻¹`, test rest geometry | O(1) setup |
| Rigid rotation (optional tightness) | OBB | inverse-map | O(1) |
| Skeletal / gesture deform (Rive/Spine) | deformed-mesh AABB | test **evaluated** outline / hit-proxy | O(verts), lazy |
| Morph / blend | evaluated-shape AABB | test **evaluated** polygon | O(verts), lazy |
| Freeform / random keyframed path | evaluated-path AABB | `overlapsPath` on **flattened evaluated** segments | O(segs), lazy |

Unifying rule: **broad phase never sees exact geometry; narrow phase computes exact
geometry lazily, only for the few candidates a query returns.** For V0, affine only
(carry a matrix). Deform later reuses the *same* seam by carrying evaluated points
instead of a matrix — **no index change**.

## Worker protocol (new)

- Message `updateHitTransforms(Map<id, { matrix: Matrix; worldAABB: Selrect }>)` →
  for each id: `quadtree.removeAll(id)` + re-insert with the animated AABB, and set
  `hitTransform` on the entry.
- Message `clearHitTransforms()` → drop the layer, entries revert to rest.
- Extend `SelectionIndexShape` with `hitTransform?: Matrix` (and later
  `evalPoints?: Point[]`).
- `overlaps`: if `hitTransform` present, map the query rect by `M⁻¹` before testing
  (affine). Everything downstream — marquee, clip-parent checks, topmost order — is
  transform-aware for free because it routes through `queryIndex`/`overlaps`.

## Slices

Recommended order: 1 → 2 first (fixes the "can't select" bug, independently
shippable), then 3 → 4 → 5 → 6 for the full overlay.

| # | Slice | Key files | Done when |
|---|---|---|---|
| 1 | Evaluated-pose provider + geometry-provider abstraction | new `renderer/motion/animated-pose.ts`; reads `motion-store.ts`, `playback-controller.ts` eval, `api/modifiers.ts` `propsToModifier` | `getAnimatedTransform(id)`, `getAnimatedAABB(id)`, `hasMotion(id)`, `motionOverlayActive()` correct at a paused frame (unit-tested) |
| 2 | Worker hit-transform channel (the selection fix) | `worker/selection.ts` (`updateIndexSingle` seam, `SelectionIndexShape`), `worker/intersect.ts` (`overlaps`), `worker/worker-sync.ts`, `worker/types.ts`; producer in `motion-store.ts` / `playback-controller.ts` | on pause/scrub, animated entries refit + `hitTransform` set; clicking the moved shape selects it; cleared on stop |
| 3 | Live box/handles on evaluated transform | `components/Overlay/SelectionOverlay.tsx` (+ maybe `animatedSelectionTransform` signal) | selection box + corner/rotation handles sit on the animated pose when paused |
| 4 | Motion badge (selection-gated) | new `components/Overlay/MotionBadge.tsx` inside `SelectionOverlay` | badge draws at the selected animated shape iff `selected && hasMotion(id)`; click toggles the path overlay |
| 5 | Overlay layers: ghosts + path + keyframes | new `components/Overlay/MotionPathOverlay.tsx`; samples via `anim/sample.ts` + `anim/evaluate.ts`; ghost outline from `Overlay/world-corners.ts` | start/end ghosts, sampled motion-path polyline, read-only keyframe diamonds render in world coords |
| 6 | Visibility gate + `Show motion paths` toggle | `SelectionOverlay.tsx`, motion store | full overlay when `motionMode || (selected && showMotionPaths)`; badge on `selected && hasMotion`; nothing during active playback |

## Resolve-first checks

1. **Does `wasmSelectionRectSignal` already include the active modifier?** If wasm
   computes the selection rect from modified bounds, the box/handles track for free
   and Slice 3 is nearly a no-op. If rest-only, Slice 3 overrides the overlay transform.
2. **Reuse `propsToModifier`** for the overlay transform so ghosts/box/path are
   computed from the exact prop→matrix mapping the renderer uses — no drift.

## Out of scope (V0) — natural next steps

- Draggable keyframes / drag-while-paused → keyframe authoring (the AE edit loop).
- Onion-range or every-keyframe ghosts (start/end only for now).
- Selection during active playback.
- Rotation-motion correctness — render-wasm bakes path rotation and ignores the
  rotation field; rotated-path ghosts may be imperfect. Flag, don't fix here.
- Deform (Rive/morph/random-path) narrow-phase via evaluated points — the seam is
  designed for it (Slice 2 geometry-provider), but only affine is wired in V0.

## Verification

Host-testable units for Slices 1, 2, 5 (pose math, worker inverse-map selects the
moved shape, path sampling). Slices 3/4/6 are visual — verified in a real browser
(headless has no GL surface, so no screenshot). No wasm rebuild at any point.

## Industry rationale (why this shape)

No single structure indexes transformed *exact* geometry — the transform changes every
frame. The universal answer is the two-phase decomposition above: index only bounding
volumes (cheap to refit), keep geometry in local space + a per-object transform, and
resolve exactly on demand. Broad-phase options in the wild: quadtree/loose-quadtree
(2D editors — what we use), BVH / dynamic AABB tree (Bullet `btDbvt`, Box2D
`b2DynamicTree`, `three-mesh-bvh`), R-tree (`rbush`), uniform grid / spatial hash,
sweep-and-prune. Narrow phase is universal: local-space geometry + inverse-transform
for rigid/affine; proxy or evaluated mesh for deformable (Rive/Spine editors hit-test
selection against the deformed bbox / hit-area, exact per-triangle only for mesh edit).

## Update — scale and dimension are TWO channels (2026-07-07)

Web parity settles it: `transform: scale()` composites (no reflow — children scale/
distort), while animating `width`/`height` runs layout every frame (children REFLOW).
Same split as Figma (scale tool vs W/H). So we model both, as distinct channels:

- **scale (scaleX/scaleY)** — transform overlay, compositor path (matrix modifier +
  the matrix hit-transform from Slices 1-2). Delta = `1 + δ` (`sx = 1 + (scaleX ?? 0)`).
  Cheap, per-frame, children distort. READY to build.
- **width/height** — structural dimension, RE-RASTER path: mutate real geometry each
  frame (stroke/radius fixed, auto-layout children reflow). Delta = additive px (like
  x/y — already clean). Needs (a) a per-frame geometry+layout channel in render-wasm
  (the `animation_active` re-raster path; Docker wasm build), (b) EVALUATED-GEOMETRY
  hit-test (resized points, NOT a matrix — the first user of the escalation's
  evaluated-points branch), (c) reflow for layout containers. Its own, larger slice.

Authoring (Figma-consistent): resize handles -> W/H keyframes; a scale tool / modifier-
drag (or numeric field) -> scale keyframes. `AnimatableProperty` gains `width|height`
distinct from `scaleX|scaleY`; the render adapter forks transform-props (matrix) vs
geometry-props (W/H sink) vs opacity (fill path).

Build order: Slice 3 (gate flip: box + move) -> 3b scale keyframes (cheap, matrix path)
-> 3c width/height keyframes (render geometry channel + reflow + evaluated-points hit).
