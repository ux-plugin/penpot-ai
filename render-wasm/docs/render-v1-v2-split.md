# Renderer V1 / V2 module split

## Goal

Clone the orchestrator file `src/render.rs` (3177 LOC) into a
scheduler-native `render_v2` and cfg-gate the two. V1 frozen, V2 free
to refactor without `cfg(not(tile-scheduler))` knife-fights. Shared
submodules (`fills`, `strokes`, `shadows`, `filters`, `text`, etc.)
stay shared — they are pure draw helpers, no traversal state.

When `tile-scheduler` ships default-on, delete `v1.rs` whole-file.
No grep-and-untangle.

## Scope clarification

The 3177-line file is the **orchestrator**: state struct, traversal
loop, `render_shape`, enter/exit, nested-state stacks. Everything
that has V1 vs V2 divergence today.

Submodules in `src/render/` are stateless: `fills::render`,
`strokes::render_stroke`, `shadows::render_inner_shadow`, etc.
Both V1 and V2 call them. Do **not** duplicate.

## Target shape

```
src/render/
  mod.rs          # cfg-routes v1 OR v2 as `crate::render::*`
                  # declares shared submodules
  v1.rs           # current 3177-line orchestrator (frozen)
  v2.rs           # initial: cp of v1.rs. Then strip + refactor.
  fills.rs        # SHARED — unchanged
  strokes.rs      # SHARED
  shadows.rs      # SHARED
  filters.rs      # SHARED
  text.rs         # SHARED
  ...
```

`mod.rs` body:

```rust
#[cfg(not(feature = "tile-scheduler"))]
mod v1;
#[cfg(not(feature = "tile-scheduler"))]
pub use v1::*;

#[cfg(feature = "tile-scheduler")]
mod v2;
#[cfg(feature = "tile-scheduler")]
pub use v2::*;

mod fills;
pub mod filters;
mod fonts;
mod gpu_state;
pub mod grid_layout;
mod images;
mod noise;
mod options;
mod shadows;
mod strokes;
mod surfaces;
pub mod text;
pub mod text_editor;
mod local;
mod gather;
mod glass;
mod ui;
mod texture;
mod debug;
```

Consumers (`crate::render::RenderState`, `crate::render::SurfaceId`,
`crate::render::Surfaces`) keep importing as before — `mod.rs`
re-exports the active orchestrator transparently.

## Phases

### Phase 1 — Mechanical split (no behavior change)

1. `git mv src/render.rs src/render/mod.rs`
2. In `mod.rs`, peel orchestrator body into `src/render/v1.rs`.
   `mod.rs` keeps only the submodule decls + a `mod v1; pub use v1::*;`.
3. `cp src/render/v1.rs src/render/v2.rs`.
4. `mod.rs` cfg-routes: `not(tile-scheduler)` → v1, `tile-scheduler` → v2.
5. Verify: `cargo check` (default features) green. `cargo check
   --features tile-scheduler` green. Both feature configs build.

**Stop gate.** Commit. Visual+perf smoke test. Same byte-identical V1
behavior + V2 behavior expected (V2 still has all the V1 paths).

### Phase 2 — Strip V1-only paths from `v2.rs`

Inside `v2.rs` only, delete:

- `pending_nodes: Vec<NodeRenderState>` field + `NodeRenderState` struct
- `nested_fills`, `nested_blurs`, `nested_shadows`, `parent_shadows`
  fields + their push/pop machinery
- `ignore_nested_blurs` + `with_nested_blurs_suppressed`
- `clip_bounds` field, `apply_to_current_surface` flag plumbing
- `start_render_loop` + `process_animation_frame` + `render_shape_tree`
  traversal
- All `cfg(not(feature = "tile-scheduler"))` blocks (delete the block)
- All `cfg(feature = "tile-scheduler")` gates (unwrap to bare code)

Inside `v1.rs`: leave alone. Frozen.

Visual + perf smoke after. Tests must stay green.

### Phase 3 — `render_shape_into_target` rewrite

In `v2.rs` only. Replace `render_shape` (635 LOC) + `can_render_directly`
(22-cond predicate) + dual fast/slow split with one fn:

```rust
fn render_shape_into_target(&mut self, shape: &Shape, target: SurfaceId)
```

- Always draws directly into `target` (no implicit outer save_layer).
- BeginLayer/EndLayer composition lives in scheduler dispatcher
  (already done, V2c.2).
- Inline alpha + blend handled by scheduler `BeginLayer`. `render_shape`
  internals never call `save_layer` for opacity.
- Layer-blur: when `shape.has_layer_blur()`, scheduler emits BeginLayer
  with `frame_blur_sigma_dev`; `render_shape_into_target` is oblivious.
- Inner shadows: drawn at end into target (current `render_inner_shadows`).
- Strokes: drawn after fills (current order).

This kills the V1 wrapping assumption that broke iso_opacity_500 +
iso_layer_blur_200.

### Phase 4 — Wire scheduler dispatcher

In `tile_grid/mod.rs`, `LocalFx::ShapeBody` arm: replace
`render_shape(...) + apply_drawing_to_render_canvas(...)` with
`render_shape_into_target(shape, SurfaceId::Current)`.

Drop `apply_drawing_to_render_canvas` from V2 (was V1 surface-shuffling
ceremony).

### Phase 5 — Visual fixup

Status update: Phase 4 shipped with `render_shape_into_target` wired
into the scheduler `LocalFx::ShapeBody` arm. Byte-parity vs baselines
confirmed for all 12 visual cells. Group opacity composition (V2c.2)
keeps working through the new path (`iso_groups_100__idle` shows
pastel children at α=0.6).

Originally hypothesized blanks (`iso_opacity_500__*`,
`iso_layer_blur_200__idle`) are NOT scheduler-specific renderer bugs:
a V1-only build (no `tile-scheduler`) produces the SAME blank
screenshots for these cells. Root cause is below the renderer —
candidates: scene-layout (LEAVES_PER_ROW=100, stride=100 spreads
shapes across 10000px wide world, only first 10 cols visible),
visibility/culling predicate misclassifying opacity-flagged shapes,
or `apply_isolated_fx` interaction with default Shape state.

Defer the layout-level investigation. The renderer split lands
without making these worse.

Still-broken (independent fixes, scoped to V2c.3.x):

- `iso_masked_50__idle__f30` — masked group two-pass scheduler integration
- `iso_svg_50__idle__f30` — SVG transform mapping
- `nested_d3_b5_no_fx`, `mixed_kitchen_sink` — bench-layout overflow

### Phase 6 — Validate

- `pnpm run visual:capture` — eyeball diff vs baselines
- `pnpm run perf:quick` — V2c.3-prep baseline numbers
- `cargo test --features tile-scheduler tile_grid::tests` — scheduler unit tests
- `cargo test` (default) — V1 path untouched, must pass

## Cost / risk

| Item | Cost |
|---|---|
| One-time duplicate | ~3200 LOC (one file, not whole tree) |
| Ongoing | zero shared-orchestrator bug fixes (V1 frozen) |
| Bug-port risk | port V1 fixes to V2 by hand; mitigated since V1 is maintenance-mode |
| End-state | delete `v1.rs` whole file when scheduler default-on |

## Migration order vs V2c.3

This split is a **prerequisite** for V2c.3 subtree cache. V2c.3 needs
to recurse into a Filter scratch surface; that recursion calls
`render_shape_into_target` per leaf. Building V2c.3 on top of the
current shared `render_shape` would re-introduce the V1 wrapping
assumption inside the cache build — exactly the bug already exposed
by iso_opacity_500.

Order: Phase 1-4 first → V2c.3.

## Out of scope

- Penpot frontend changes — none. WASM ABI unchanged.
- Sub-module refactor (`fills.rs`, `strokes.rs` etc.) — defer.
- `tile_grid/mod.rs` size — separate concern (already split V2c.2).

## Done definition

- `cargo check` + `cargo check --features tile-scheduler` both green ✓
- visual harness: 12/12 byte-identical with pre-split baselines under
  `tile-scheduler` ✓ (proves no behavior delta from the split)
- visual harness: working cells (flat_baseline, iso_text, iso_groups
  pastel children) stay green ✓
- `src/render/v2.rs` < `src/render/v1.rs` LOC (proof of strip) ✓
  v1: 3161, v2 post-strip: 2300, post-Phase-4: ~2440 (+`render_shape_into_target`)
- perf:quick within ±5% of pre-split V2c.2 baseline — pending Phase 6
- iso_opacity_500 / iso_layer_blur_200 visual greens — deferred (not
  scheduler-specific; same blanks under V1 build)
