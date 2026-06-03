# Tile Scheduler V2: per-effect Paint payload

> **Status: superseded / historical (2026-06).** The V1/V2 tile-scheduler
> orchestrators and the `tile-scheduler` feature gate were deleted; **SSA
> Surface IR (`render/ssa/`) is now the only draw path.** The per-effect
> dispatch pattern described here lives on in `render/ssa/dispatch.rs`. Kept as
> a design-rationale record, not active guidance.

Plan for the second phase of the per-effect tile scheduler refactor. V1 (already landed) gave the scheduler ownership of cache lifecycle (`BuildCache` / `FreeCache`, `CacheKind::{Scatter, Gather}`, `emitted_caches` set, `Paint(Uuid)` step). V2 makes the *paint* itself per-effect: the `Paint` step carries a list of explicit actions with `(input, output, effects)`, and the renderer becomes a stateless dispatcher that paints exactly what each action says.

## Context

After V1 the dispatcher in `run_schedule`'s `Paint(id)` arm ([tile_grid.rs:1731](../src/tile_grid.rs:1731)) still hardcodes effect ordering: background blur → glass → drop shadows → `render_shape` (fills/strokes/inner shadows via per-aspect surfaces) → `apply_drawing_to_render_canvas`. The renderer "thinks about keeping effects in sync" via this hardcoded sequence and via [render.rs:render_shape()](../src/render.rs:803) — an ~800-line dispatcher inside the renderer.

Goal: invert ownership. The scheduler emits a sequence of paint actions per shape. Each action carries `(input, output, effects[])` and the dispatcher iterates the list, routing each effect to its existing per-effect renderer. Save_layer wrapping becomes explicit `BeginLayer` / `EndLayer` actions. The renderer keeps no implicit ordering or surface-routing knowledge.

User decisions (carried over from V1 plan, still binding):
- A step carries a list of actions/effects applied in list order; bundle freely.
- Default for V2 is one `Paint` step per shape, all actions bundled. Multi-step-per-shape (mid-shape yield) is a capability the model supports but is not emitted by default.
- Layer wrap modeled with `BeginLayer` / `EndLayer` actions (extend Enter/Exit semantics).
- Text shapes stay atomic — one `EffectKey::TextContent` paints fills + drops + strokes + inner shadows together.
- New helpers gated behind `#[cfg(feature = "tile-scheduler")]`; legacy `render_shape` and friends untouched.

## Approach (phased)

Three phases, each independently buildable, testable, and bench-able. Each phase ends with a row added to the bench tables in [perf-tile-scheduler-refactor.md](perf-tile-scheduler-refactor.md). Phasing keeps the diff reviewable and lets us catch perf regressions at the step that introduced them.

### Phase 2a — Types and pass-through dispatcher

Goal: new step shape, new dispatcher exists, behavior identical to V1.

1. In [tile_grid.rs](../src/tile_grid.rs), expand the step model. `Paint(Uuid)` becomes:
   ```rust
   Paint {
       shape: Uuid,
       actions: Vec<PaintAction>,      // unbounded
   }

   pub enum PaintAction {
       BeginLayer(LayerPaint),
       Render {
           input: SurfaceInput,
           output: SurfaceId,
           effects: Vec<EffectKey>,    // unbounded — any number of effects per Render action
       },
       EndLayer,
   }

   pub enum SurfaceInput { None, Surface(SurfaceId), Cache(CacheKind) }

   pub enum EffectKey {
       LegacyAll,           // 2a only: routes to existing render_shape orchestration
       // 2b: replace LegacyAll with per-effect variants:
       // Fill(u16), Stroke(u16), Shadow(u16),
       // BackgroundBlur, Glass, ScatterBlit, Noise, TextContent,
   }

   pub struct LayerPaint {
       pub opacity: f32,
       pub blend_mode: skia::BlendMode,
       pub layer_blur_sigma: Option<f32>,
       pub masked: bool,
   }
   ```
2. **Why plain `Vec`** — fully unbounded, so any shape with any number of effects is handled by construction. The Paint variant grows the `RenderStep` enum by ~16 bytes (Uuid + Vec header = 40 bytes vs. the ~24 bytes of the largest V1 variant). For a 14k-step schedule that's ~225 KB extra — fine. One `Vec` allocation per Paint step; sequential walk stays cache-friendly with no indirection.
3. In [render.rs](../src/render.rs), add `RenderState::scheduler_render_effects(shape, input, output, &[EffectKey])` — new method, gated on `tile-scheduler`. For 2a, when it sees `EffectKey::LegacyAll`, it does exactly what today's Paint arm does (bg blur → glass → drop shadows → `render_shape` → composite). All other variants of `EffectKey` are unimplemented in 2a.
4. Update emission in `emit_shape_steps_checked` ([tile_grid.rs:1283](../src/tile_grid.rs:1283)): for each leaf shape, emit `Paint { shape, actions: vec![Render { input: None, output: SurfaceId::Current, effects: vec![LegacyAll] }] }`.
5. Update `run_schedule`'s `Paint` arm: walk `actions`, dispatch `Render` action via `scheduler_render_effects`. `BeginLayer`/`EndLayer` arms unimplemented in 2a (no emitter pushes them yet).
6. The legacy inline orchestration (lines 1928–2017) moves *into* `scheduler_render_effects` behind the `LegacyAll` arm — same logic, relocated.

Verification 2a:
- `cargo check --features tile-scheduler --release` passes.
- `cargo test --features tile-scheduler --release bench_rebuild_full -- --nocapture --test-threads=1` runs and produces numbers within ±5% of V1 on `rebuild` and within ±15% on `walk` (the richer Paint payload adds bytes per push).
- Schedule length grows by 0 (still one Paint step per leaf).
- Visual regression in browser: identical to V1 (this phase is structural-only).

Add a row to the bench tables: **"V2a types + pass-through dispatcher"**.

### Phase 2b — Per-effect EffectKey variants

Goal: `LegacyAll` is gone. Each visible effect on a shape becomes its own `EffectKey` in the action's effects list.

1. Replace `EffectKey::LegacyAll` with the real per-effect variants:
   ```rust
   pub enum EffectKey {
       Fill(u16),
       Stroke(u16),
       Shadow(u16),       // index into shape.shadows; kind discriminates drop vs inner
       BackgroundBlur,
       Glass,             // consumes Cache(Gather(shape))
       ScatterBlit,       // consumes Cache(Scatter(shape))
       Noise,
       TextContent,       // atomic text paragraph
   }
   ```
2. In `scheduler_render_effects`, route each `EffectKey` to the existing per-effect renderer:
   - `Fill(i)` → [fills::render](../src/render/fills.rs).
   - `Stroke(i)` → [strokes::render](../src/render/strokes.rs).
   - `Shadow(i)` (drop) → [shadows::render_element_drop_shadows_and_composite](../src/render.rs:2171) for non-text, [shadows::render_text_shadows](../src/render/shadows.rs) for text.
   - `Shadow(i)` (inner) → [shadows::render_fill_inner_shadows](../src/render/shadows.rs) / `render_stroke_inner_shadows`.
   - `BackgroundBlur` → [render.rs:render_background_blur](../src/render.rs:496).
   - `Glass` → [glass::render_glass_with_backdrop_image](../src/render/glass.rs) (root) or [glass::render_glass](../src/render/glass.rs) (nested). Uses `input: Cache(Gather(id))` for root case.
   - `ScatterBlit` → blit-from-cache slice (today's [tile_grid.rs:1841-1928](../src/tile_grid.rs:1841)). Lifted into the dispatcher.
   - `Noise` → existing noise paint application.
   - `TextContent` → existing text paragraph path ([render.rs:1053-1296](../src/render.rs:1053)) called atomically.
3. The dispatcher pushes the canvas onto `output` before iterating, restores after. For inner shadows, internally save_layers a transparent layer so `BlendMode::SrcATop` clips to the shape's silhouette without leaking onto prior tile content (this isolation is the dispatcher's job, not the scheduler's).
4. Update `emit_shape_steps_checked` to build the effect list per shape:
   ```text
   effects = []
   if shape.background_blur.is_some() && !hidden: effects.push(BackgroundBlur)
   if root-level glass: effects.push(Glass)  [input: Cache(Gather(id))]
   for i, drop shadow in shape.shadows where !hidden: effects.push(Shadow(i))
   if scatter: effects = [ScatterBlit]  [input: Cache(Scatter(id))]
   else if Type::Text: effects = [TextContent]
   else:
     for i, fill in shape.fills where !hidden: effects.push(Fill(i))
     for i, stroke in shape.strokes where !hidden: effects.push(Stroke(i))
     for i, inner shadow: effects.push(Shadow(i))
   if shape.noise.is_some(): effects.push(Noise)
   ```
   Then emit one `Paint { shape, actions: vec![Render { input, output: Current, effects }] }`.
5. Delete the legacy orchestration block from `scheduler_render_effects` (the V2a `LegacyAll` arm body). The dispatcher is now purely per-effect.
6. Optionally: delete `render_shape` ([render.rs:803-1638](../src/render.rs:803)) if no caller remains. Likely it stays for the legacy non-tile-scheduler path; gate accordingly.

Verification 2b:
- All bench tests still green.
- Visual regression: pixel-perfect match against V2a on a comprehensive file (multiple fills/strokes, drop+inner shadows, layer blur, bg blur, glass root + nested, scatter, noise, text, masked groups, frame opacity).
- Bench rows added: **"V2b per-effect EffectKey"**. Watch `paint_step` µs — should be within ±10% of V2a (per-effect dispatch overhead is tiny relative to actual Skia draw cost).

### Phase 2c — `BeginLayer` / `EndLayer` actions (deferred)

> **Status (2026-05-04):** types and pattern-match arms are in place from Phase 2a (`PaintAction::BeginLayer(LayerPaint)`, `PaintAction::EndLayer`); the emitter does **not** yet produce them and the dispatcher arms are still empty. Landing real emission requires splitting save_layer logic out of `render_shape` / `render_shape_enter` so it doesn't get applied twice (once explicitly via `BeginLayer`, once again inside `render_shape`). Without visual-regression coverage in CI this is a higher-risk change than 2a/2b, so it's parked until the next session can pair it with browser-level visual diffs.

Goal: save_layer wrapping (opacity, blend mode, layer blur, masked group) is explicit in the schedule rather than implicit in `render_shape_enter`.

1. Implement the `BeginLayer(LayerPaint)` and `EndLayer` arms in `scheduler_render_effects`:
   - `BeginLayer(paint)` → `canvas.save_layer(...)` with the prebuilt paint (opacity, blend mode, optional `image_filter` for layer blur). Logic ported from [render.rs:1755-1777](../src/render.rs:1755).
   - `EndLayer` → `canvas.restore()`.
2. Update emission to produce wrapped actions for shapes that need save_layer:
   ```rust
   actions: Vec<PaintAction> = Vec::new();
   if needs_save_layer(shape) { actions.push(BeginLayer(LayerPaint::for_shape(shape))); }
   actions.push(Render { input, output, effects });
   if needs_save_layer(shape) { actions.push(EndLayer); }
   ```
   `needs_save_layer` is true when `shape.opacity < 1.0 || shape.blend_mode != Normal || shape.blur.is_some() || shape.is_masked_group()`.
3. For container shapes (frames/groups) with save_layer needs, the wrap must bracket the *whole subtree*. The schedule already emits `Enter(group_id)` before children and `Exit(group_id)` after; insert standalone `Paint { shape: group_id, actions: vec![BeginLayer(...)] }` immediately after `Enter` and the matching `EndLayer`-only Paint immediately before `Exit`.
4. Strip the save_layer logic from `render_shape_enter` / `render_shape_exit` *only for the tile-scheduler path*. Either branch on `cfg`, or add a new `scheduler_enter_container` / `scheduler_exit_container` that does clip + transform only.

Verification 2c:
- Visual regression on a file heavy in layer-blur, opacity, blend-mode, and masked-group cases.
- New bench scenario: shapes with layer blur set on every shape (synthetic). Add as `bench_rebuild_full_1k_layered`. Capture before (V2b) and after (V2c) numbers.
- Confirm canvas state survives `process_animation_frame` yields when a `BeginLayer` / `Render` / `EndLayer` triplet straddles two frames. The tile-scheduler doesn't yield mid-Paint today (one Paint per shape is atomic), so this is safe by construction unless 2d ships.

## Types reference (final V2 shape)

```rust
// tile_grid.rs
pub enum RenderStep {
    SetTileBand { tile, band_index, is_first, is_last },
    Enter(Uuid),
    Exit(Uuid),
    BuildCache(CacheKind),     // V1
    FreeCache(CacheKind),      // V1
    Paint { shape: Uuid, actions: Vec<PaintAction> },  // V2
    FinalizeBand { tile, kind },
}

pub enum PaintAction {
    BeginLayer(LayerPaint),
    Render {
        input: SurfaceInput,
        output: SurfaceId,
        effects: Vec<EffectKey>,     // unbounded — any number of effects per Render action
    },
    EndLayer,
}

pub enum EffectKey {
    Fill(u16),
    Stroke(u16),
    Shadow(u16),
    BackgroundBlur,
    Glass,
    ScatterBlit,
    Noise,
    TextContent,
}

pub enum SurfaceInput { None, Surface(SurfaceId), Cache(CacheKind) }

pub struct LayerPaint {
    pub opacity: f32,
    pub blend_mode: skia::BlendMode,
    pub layer_blur_sigma: Option<f32>,
    pub masked: bool,
}
```

`CacheKind` and the `BuildCache`/`FreeCache` variants are unchanged from V1.

## Key files to modify

- [render-wasm/src/tile_grid.rs](../src/tile_grid.rs)
  - Step enum and `PaintAction` / `EffectKey` / `SurfaceInput` / `LayerPaint` definitions.
  - `emit_shape_steps_checked` — build the action list (2a trivial, 2b per-effect, 2c with BeginLayer/EndLayer wrap).
  - `run_schedule` Paint arm — walk actions, dispatch each.
- [render-wasm/src/render.rs](../src/render.rs)
  - Add `scheduler_render_effects(shape, input, output, &[EffectKey])` (the heart of V2).
  - Add `scheduler_begin_layer(&LayerPaint)` / `scheduler_end_layer()`.
  - Add `scheduler_enter_container(uuid)` / `scheduler_exit_container(uuid)` (clip/transform only, no save_layer) — gated on `tile-scheduler`.
  - `render_shape`, `render_shape_enter`, `render_shape_exit`, `apply_drawing_to_render_canvas` stay untouched for the legacy path.
- [render-wasm/Cargo.toml](../Cargo.toml) — no new dependencies (plain `Vec` and `Box`).
- Per-effect modules ([render/fills.rs](../src/render/fills.rs), [render/strokes.rs](../src/render/strokes.rs), [render/shadows.rs](../src/render/shadows.rs), [render/glass.rs](../src/render/glass.rs), [render/texture.rs](../src/render/texture.rs)) — already per-effect entry points; expose stable signatures keyed by index where needed.

## Reused functions (no new equivalents needed)

- `fills::render`, `strokes::render` — already per-effect.
- `shadows::render_element_drop_shadows_and_composite`, `render_fill_inner_shadows`, `render_stroke_inner_shadows`, `render_text_shadows` — already per-effect.
- `glass::render_glass`, `glass::render_glass_with_backdrop_image` — already per-effect; pair with `Cache(Gather(...))` input.
- `texture::render_and_filter_to_image`, `texture::render_and_filter_subtree_to_image` — already used by V1's `BuildCache(Scatter)`; the per-tile blit ([tile_grid.rs:1841-1928](../src/tile_grid.rs:1841)) lifts into the dispatcher's `ScatterBlit` arm.
- `render_background_blur` ([render.rs:496](../src/render.rs:496)) — reused by `BackgroundBlur` effect.
- `surfaces.get_glass_backdrop` (added in V1) — feeds the `Glass` effect for root-level gathers.

## Tricky bits

1. **Inner shadow `SrcATop` clipping** — `BlendMode::SrcATop` only paints where the destination already has alpha. The dispatcher must ensure the inner shadow lands in a save_layer'd region containing only this shape's fill silhouette, not whatever else is on Current. Use a transparent `save_layer` around the fill-then-inner-shadow pair, or keep the per-aspect Fills surface as a clip mask (today's mechanism). Either way the scheduler doesn't see this — it's the dispatcher's responsibility.

2. **Order within a single `Render` action** — the effects list is applied in list order. Drop shadows first (so they land below fills), then fills, then strokes, then inner shadows last (so they clip to fills+strokes silhouette). The emitter encodes this order; the dispatcher just walks it.

3. **Layer wrap on groups** — for a frame/group with opacity/blend/blur, `BeginLayer` / `EndLayer` must wrap the entire subtree's Paint steps, not just the group's own Paint step. Emit them as standalone single-action Paint steps positioned immediately after `Enter(group_id)` and immediately before `Exit(group_id)`.

4. **Frame strokes after children** — clipped frames render their strokes *after* their children, not before. Today this lives in `render_shape_exit`'s `skip_strokes` branch ([render.rs:1807-1850](../src/render.rs:1807)). In V2c, model this as a *second* Paint step on the frame, emitted after the children's steps but before `Exit(frame_id)`, with effects = [stroke indices only].

5. **Combined scatter+glass** — already correct in V1: `BuildCache(Gather)` runs first, `BuildCache(Scatter)` reads the cached backdrop. V2 just changes how the *paint* is dispatched, not the cache build. The Paint step for a scatter+glass shape has `effects: [ScatterBlit]` with `input: Cache(Scatter(id))`.

6. **Text atomicity** — `TextContent` is one effect. Splitting text fills/drops/strokes/inner-shadows into separate `EffectKey` variants would require restructuring Skia's paragraph builder usage, which is out of scope. Single `EffectKey::TextContent` calls today's [render.rs:1053-1296](../src/render.rs:1053) text path atomically.

7. **Unbounded action and effect lists** — both `actions: Vec<PaintAction>` and `effects: Vec<EffectKey>` are plain `Vec`s with no inline cap. Any shape with any number of effects (4 fills + 3 strokes + 5 shadows + bg blur + noise = 14, or anything larger) is handled by construction. The Paint variant grows the `RenderStep` enum by ~16 bytes — fine.

8. **Yield mid-shape** — V2 emits one Paint per shape (atomic). Multi-step splitting for mid-shape yield is V2d (optional, deferred). The step model already supports it; the emitter just needs a heuristic for "this shape is expensive enough to split".

## Verification (full V2)

### Bench rows to capture

After each phase, run the bench in the same Docker environment as V1 baseline:

```sh
docker run --rm --platform linux/amd64 \
  -v "$(pwd):/home/penpot/penpot:z" \
  -w /home/penpot/penpot/render-wasm \
  penpotapp/devenv:latest \
  sudo -EH -u penpot bash -lc '
    export SKIA_BINARIES_URL="https://github.com/penpot/skia-binaries/releases/download/0.93.1/skia-binaries-319323662b1685a112f5-x86_64-unknown-linux-gnu-gl-svg-textlayout-binary-cache-webp.tar.gz"
    export CARGO_BUILD_TARGET="x86_64-unknown-linux-gnu"
    cargo test --bin render_wasm --features tile-scheduler --release \
      bench_rebuild_full -- --nocapture --test-threads=1
  '
```

Append rows to each scenario's table in [perf-tile-scheduler-refactor.md](perf-tile-scheduler-refactor.md):
- **V2a types + pass-through dispatcher** — expect ±5% on rebuild, ±15% on walk vs V1.
- **V2b per-effect EffectKey** — expect rebuild within ±10% of V2a (per-effect emission iterates fills/strokes/shadows lists, slight overhead). Walk within ±10%.
- **V2c BeginLayer/EndLayer** — expect schedule_len growth proportional to layered shapes (×3 instead of ×1 for those shapes).

### Soft regression gates

- `paint_step` µs: > +20% vs V1 triggers investigation (per-effect dispatch overhead should be tiny next to actual Skia draw cost).
- `rebuild` ms: > +20% vs V1 triggers investigation (richer emission can grow this).
- `walk` µs: grows proportionally to schedule length growth — fine if proportional, flag if super-linear.

### Visual regression

After each phase, run the frontend dev server with the rebuilt WASM and visually diff against V1 on a file containing every effect class:
- multiple solid/gradient/image fills,
- inner+outer strokes (multiple),
- drop + inner shadows (mixed, multiple per shape),
- layer blur,
- background blur,
- root-level + nested glass,
- scatter texture,
- scatter + glass on the same shape,
- noise,
- text with all decorations,
- masked groups,
- frames with opacity / blend mode / clip_content + strokes.

Pixel-perfect match expected; any difference is a regression to be fixed before moving to the next phase.

### Legacy path

Run `cargo check --release` (no `tile-scheduler` feature) after each phase to confirm `PendingTiles` path still compiles. New scheduler-only functions must be `#[cfg(feature = "tile-scheduler")]`-gated.

## Out of scope (for V2)

- **V2d: multi-step Paint per shape** — splitting a shape into multiple `Paint` steps to enable mid-shape yield. The step model supports it; the emitter needs a cost heuristic. Defer until profiling shows we need it.
- **Splitting text into per-pass effect steps** — `TextContent` stays atomic.
- **Collapsing per-aspect surfaces** (Fills / Strokes / DropShadows / InnerShadows / TextDropShadows) into a single scratch — kept as private renderer detail. Each effect dispatcher uses whatever scratch it needs internally; the scheduler doesn't see it.
- **Per-effect dirty tracking** — incremental rebuild stays band-level.
- **Changing the band DAG / topo-sort logic** in `tile_grid.rebuild`.

## Suggested order of operations

1. Phase 2a in one PR. Lands types and structural rename. Easy to revert if perf regresses unexpectedly.
2. Phase 2b in one PR. The big diff — pulls effect ordering into the emitter. Comprehensive visual regression here.
3. Phase 2c in one PR. Smaller, isolated to layer-wrap cases.
4. (Optional V2d in a separate effort if frame budget on heavy scenes shows benefit.)
