# Tile Scheduler Refactor — Performance Tracking

> **Status: historical (2026-06).** These checkpoints track the now-deleted V2
> per-effect scheduler. V2 was superseded by SSA Surface IR (`render/ssa/`).
> Retained as a historical perf record; re-baseline against SSA before using
> these numbers for comparison.

Tracks measured performance of the tile-scheduler rendering pipeline through the per-effect refactor described in the plan. Each row in the tables below represents the same set of repeatable scenarios captured at a checkpoint in the work, so regressions can be localized to the change that introduced them.

## Primary measurement: Rust bench (deterministic, no browser)

A parameterized synthetic bench in [src/tile_grid.rs](../src/tile_grid.rs) (function `end_to_end_rebuild_full(n_shapes, n_gathers, n_scatters, label)`, inside `mod bench`) measures the two phases of the tile scheduler that change with the refactor:

1. **Schedule build** — `tile_grid.rebuild()` over a synthetic `ShapesPool`. Pure CPU. This is where the per-effect refactor's cost concentrates.
2. **Schedule walk** — `grid.next()` over the entire schedule, no GPU work. Isolates pure scheduler iteration overhead.

Tests in the same module call this helper at fixed parameter sets and print the numbers via `println!`:

| Test name | Parameters |
|---|---|
| `bench_rebuild_full_1k_baseline` | 1k shapes, 0 gathers, 0 scatters |
| `bench_rebuild_full_1k_5_scatters` | 1k shapes, 0 gathers, 5 scatters |
| `bench_rebuild_full_1k_5_gathers_5_scatters` | 1k shapes, 5 gathers, 5 scatters |
| `bench_rebuild_full_10k_baseline` | 10k shapes, 0 gathers, 0 scatters |
| `bench_rebuild_full_10k_with_effects` | 10k shapes, 20 gathers, 20 scatters |

Plus the existing `bench_rebuild_e2e_*` family (gather-only configurations) that already lives in the same module.

### Run the bench

The bench is a normal `cargo test` running natively (not WASM). To avoid setting up Skia binaries per-platform, run inside the same `penpotapp/devenv:latest` Docker image that [scripts/build-wasm.sh](../../skia-rs-wasm/scripts/build-wasm.sh) uses for skia-rs-wasm — it already has Rust + Linux skia binaries cached.

From the repo root:

```sh
docker run --rm \
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

The two env vars are the Linux-x86_64 equivalents of what [_build_env](../_build_env) sets for the WASM target — they tell `skia-bindings` to download a precompiled Skia tarball instead of compiling from source (which would need ninja + clang locally).

- `--release` is mandatory — debug builds are dominated by allocator overhead and don't reflect production cost.
- `--nocapture` surfaces the `[bench] ...` lines from `println!`.
- `--test-threads=1` keeps wall-clock timings independent of CPU contention.
- Filter `bench_rebuild_full` runs only the parameterized benches added for this refactor. Use `bench_rebuild` to also include the existing `bench_rebuild_e2e_*` (gather-only) family.

If you're already on Linux x86_64 with `ninja` + `clang` available locally, you can drop the Docker wrapper and run the inner command directly — the env-var URL still avoids a 30+ minute Skia-from-source build.

### Interpreting bench output

```
[bench] e2e 1k shapes, 5 gathers, 5 scatters: rebuild=2.143ms/iter, walk=18.762µs/walk, schedule_len=1820, bands=23
```

- `rebuild` — schedule build cost. Dominant for viewport changes / dirty rebuilds. This is what the refactor most directly affects (richer `Paint` payloads add bytes per push).
- `walk` — pure scheduler dispatch overhead per full schedule pass. After the refactor this should grow proportionally to the action-list payload but stay well under the rebuild number.
- `schedule_len` — total step count. Multi-step splits (when introduced) will increase this.
- `bands` — total bands across all tiles. Should not change with the refactor (band partitioning logic is untouched).

### What this bench does NOT cover

The actual paint phase (`scheduler_render_effects` calling Skia draw functions) needs a GL context and runs only in the browser. Capture that with DevTools (procedure below) when end-to-end frame timing matters.

## Setup (browser-side, secondary)

### Build with profile macros

The crate compiles via Emscripten to `wasm32-unknown-emscripten`. Use the project build script — it sources `_build_env`, sets up Emscripten, and copies artifacts into the frontend's public directory automatically.

```sh
cd render-wasm
TILE_SCHEDULER=1 ./build release --features profile-macros
```

- `TILE_SCHEDULER=1` enables the `tile-scheduler` cargo feature ([_build_env:51-55](../_build_env)).
- The trailing `--features profile-macros` is forwarded to `cargo build` via `CARGO_PARAMS` ([_build_env:49](../_build_env)).
- The `profile-macros` feature wires up `begin_measure!` / `end_measure!` ([src/performance.rs](../src/performance.rs)) so each instrumented region emits `performance.mark` / `performance.measure` entries visible in DevTools.

Artifacts land in `../frontend/resources/public/js/render-wasm.{js,wasm}` automatically — the playgrounds pick them up on reload.

### Capture a measurement

1. Open the relevant playground or file in the browser.
2. Open DevTools → Performance, hit Record, exercise the scenario (5 seconds is enough for steady-state scenarios), Stop.
3. In the timeline, look at the User Timing track. Each `begin_measure!`/`end_measure!` pair shows up as a bar named after the measure (e.g. `start_render_loop`, `process_animation_frame`, `rebuild_tiles`).
4. Right-click → "Show in panel" or hover for individual durations. Take the **median** across the bars in the recording.
5. Paste the number into the relevant cell below.

### Existing measure points (baseline coverage)

These are already wired in `develop`:

| Measure | What it covers |
|---|---|
| `rebuild_tiles` | Full schedule rebuild ([render.rs:2959](../src/render.rs:2959)) |
| `rebuild_tiles_shallow` | Viewport-only rebuild on `set_view_end` ([render.rs:2941](../src/render.rs:2941)) |
| `rebuild_touched_tiles` | Incremental rebuild on shape mutation ([render.rs:2999](../src/render.rs:2999)) |
| `start_render_loop` | Whole render kickoff ([render.rs:1546](../src/render.rs:1546)) |
| `process_animation_frame` | Per-rAF tick ([render.rs:1619](../src/render.rs:1619)) |
| `tile_cache_update` | Tile texture cache update ([render.rs:1578](../src/render.rs:1578)) |
| `apply_drawing_to_render_canvas` | Per-shape composite ([render.rs:710](../src/render.rs:710)) |
| `render_from_cache` | Fast blit-only path ([render.rs:1463](../src/render.rs:1463)) |
| `render_preview` | Preview render ([render.rs:1515](../src/render.rs:1515)) |

### New measure points to add during the refactor

| Measure | What it covers |
|---|---|
| `scheduler_render_effects` | Whole new dispatcher invocation per `Render` action |
| `scheduler_build_scatter_cache` | Per `BuildCache { Scatter }` step |
| `scheduler_build_gather_cache` | Per `BuildCache { Gather }` step |
| `paint_step` | Whole `Paint` step in `run_schedule` (incl. all actions) |
| `emit_shape_steps_checked` | Per-shape emission loop in rebuild |

## Scenarios

A fixed set of repeatable scenarios exercised at every checkpoint. Same params each row so numbers are comparable.

| ID | Description | URL / how to run |
|---|---|---|
| S1 | Many simple rects | `wasm-playground/rects.html?shapes=1000` |
| S2 | Many rects (10×) | `wasm-playground/rects.html?shapes=10000` |
| S3 | Paths | `wasm-playground/paths.html?shapes=1000` |
| S4 | Drop shadows (heavy) | `wasm-playground/shadows.html?shapes=1000` |
| S5 | Texts | `wasm-playground/texts.html?texts=300` |
| S6 | Clips | `wasm-playground/clips.html` |
| S7 | Masks | `wasm-playground/masks.html` |
| S8 | Real file: pan | Open a representative production file, pan continuously for 5s |
| S9 | Real file: zoom | Same file, zoom in/out continuously for 5s |
| S10 | Real file: full render | Same file, force full render (e.g. reload) |

> Pick the "real file" once and stick with it across all rows — store the file ID/path here so future captures use the same one.
>
> Real file used: _TBD — fill on first capture._

## Capture protocol per row

1. Build with profile macros (command above).
2. Reload the playground / file.
3. Record 5s in DevTools Performance.
4. Take the median of each measure across the recording.
5. Paste into the table for the right scenario column.
6. Note the date and (post-baseline) the percent delta vs baseline.

If a measure didn't fire during the recording, write `—`. If it fired but is irrelevant for that scenario, write `n/a`.

## Regression gates (soft — flag in the tables, don't auto-block)

| Measure | Gate |
|---|---|
| `start_render_loop` | > +5% triggers investigation |
| `process_animation_frame` | > +5% triggers investigation |
| `rebuild_tiles` / `rebuild_touched_tiles` | > +20% triggers investigation |
| `render_from_cache` | > +1% is a bug — fast path must not regress |

## Memory

Heavy-scenario peak heap captured via DevTools Memory profiler at baseline and at final.

| Checkpoint | Scenario | Peak heap (MB) | Δ vs baseline |
|---|---|---|---|
| Baseline (develop) | S2 (rects ×10000) | _TBD_ | — |
| Final (post-refactor) | S2 (rects ×10000) | _TBD_ | _TBD_ |

If peak grows materially: switch to `Box<PaintPayload>` so the enum stays compact.

## Bench results (Rust, deterministic)

Every checkpoint adds a row. Numbers from `cargo test ... bench_rebuild_full_* -- --nocapture --test-threads=1`. `r` = `rebuild` median ms/iter, `w` = `walk` median µs/iter, `n` = schedule_len.

> Bench environment: `penpotapp/devenv:latest` Docker image running under `--platform linux/amd64` (x86_64 emulation on Apple Silicon host). Numbers are relative-comparison-only; absolute values would differ on native hardware but the before/after deltas remain meaningful as long as every checkpoint runs in the same environment.

### `bench_rebuild_full_1k_baseline` (1k shapes, 0 gathers, 0 scatters)

| Checkpoint | Date | r (ms) | w (µs) | n | Δ rebuild | Δ walk | Δ n |
|---|---|---|---|---|---|---|---|
| Baseline (develop) | 2026-05-03 | 1.131 | 4.714 | 1748 | — | — | — |
| V1 cache lifecycle refactor | 2026-05-03 | 1.101 | 4.479 | 1748 | -2.7% | -5.0% | 0 |
| V2a types + pass-through dispatcher | 2026-05-04 | 1.134 | 10.651 | 1748 | +0.3% | +126% (vs base) | 0 |
| V2b per-effect dispatcher | 2026-05-04 | 1.175 | 10.678 | 1748 | +3.9% (vs base) | +126% (vs base) | 0 |

### `bench_rebuild_full_1k_5_scatters` (1k shapes, 0 gathers, 5 scatters)

| Checkpoint | Date | r (ms) | w (µs) | n | Δ rebuild | Δ walk | Δ n |
|---|---|---|---|---|---|---|---|
| Baseline (develop) | 2026-05-03 | 1.360 | 4.345 | 1763 | — | — | — |
| V1 cache lifecycle refactor | 2026-05-03 | 1.392 | 4.960 | 1773 | +2.4% | +14.2% | +10 |
| V2a types + pass-through dispatcher | 2026-05-04 | 1.262 | 10.815 | 1773 | -7.2% | +149% (vs base) | +10 |
| V2b per-effect dispatcher | 2026-05-04 | 1.274 | 11.346 | 1773 | -6.3% (vs base) | +161% (vs base) | +10 |

### `bench_rebuild_full_1k_5_gathers_5_scatters` (1k shapes, 5 gathers, 5 scatters)

| Checkpoint | Date | r (ms) | w (µs) | n | Δ rebuild | Δ walk | Δ n |
|---|---|---|---|---|---|---|---|
| Baseline (develop) | 2026-05-03 | 2.022 | 4.470 | 1871 | — | — | — |
| V1 cache lifecycle refactor | 2026-05-03 | 2.115 | 5.887 | 1891 | +4.6% | +31.7% | +20 |
| V2a types + pass-through dispatcher | 2026-05-04 | 1.873 | 11.480 | 1891 | -7.4% | +157% (vs base) | +20 |
| V2b per-effect dispatcher | 2026-05-04 | 1.934 | 11.747 | 1891 | -4.4% (vs base) | +163% (vs base) | +20 |

### `bench_rebuild_full_10k_baseline` (10k shapes, 0 gathers, 0 scatters)

| Checkpoint | Date | r (ms) | w (µs) | n | Δ rebuild | Δ walk | Δ n |
|---|---|---|---|---|---|---|---|
| Baseline (develop) | 2026-05-03 | 48.061 | 33.186 | 14020 | — | — | — |
| V1 cache lifecycle refactor | 2026-05-03 | 49.793 | 37.393 | 14020 | +3.6% | +12.7% | 0 |
| V2a types + pass-through dispatcher | 2026-05-04 | 50.235 | 88.013 | 14020 | +4.5% | +165% (vs base) | 0 |
| V2b per-effect dispatcher | 2026-05-04 | 51.635 | 87.817 | 14020 | +7.4% (vs base) | +165% (vs base) | 0 |

### `bench_rebuild_full_10k_with_effects` (10k shapes, 20 gathers, 20 scatters)

| Checkpoint | Date | r (ms) | w (µs) | n | Δ rebuild | Δ walk | Δ n |
|---|---|---|---|---|---|---|---|
| Baseline (develop) | 2026-05-03 | 61.581 | 35.168 | 14611 | — | — | — |
| V1 cache lifecycle refactor | 2026-05-03 | 59.064 | 44.878 | 14691 | -4.1% | +27.6% | +80 |
| V2a types + pass-through dispatcher | 2026-05-04 | 56.695 | 92.090 | 14691 | -7.9% | +162% (vs base) | +80 |
| V2b per-effect dispatcher | 2026-05-04 | 58.113 | 109.067 | 14691 | -5.6% (vs base) | +210% (vs base) | +80 |

## Browser DevTools measurements (real-world)

### `start_render_loop` (ms, median)

| Checkpoint | Date | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 | S9 | S10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Baseline (develop) | TBD | | | | | | | | | | |

### `process_animation_frame` (ms, median)

| Checkpoint | Date | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 | S9 | S10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Baseline (develop) | TBD | | | | | | | | | | |

### `rebuild_tiles` (ms, median)

| Checkpoint | Date | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 | S9 | S10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Baseline (develop) | TBD | | | | | | | | | | |

### `rebuild_touched_tiles` (ms, median)

| Checkpoint | Date | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 | S9 | S10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Baseline (develop) | TBD | | | | | | | | | | |

### `apply_drawing_to_render_canvas` (ms, median per call)

| Checkpoint | Date | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 | S9 | S10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Baseline (develop) | TBD | | | | | | | | | | |

### `render_from_cache` (ms, median)

| Checkpoint | Date | S8 | S9 | S10 |
|---|---|---|---|---|
| Baseline (develop) | TBD | | | |

### New dispatcher measures (post-refactor only)

`scheduler_render_effects` (ms, median per call):

| Checkpoint | Date | S1 | S2 | S3 | S4 | S5 | S8 | S9 | S10 |
|---|---|---|---|---|---|---|---|---|---|

`paint_step` (ms, median per call):

| Checkpoint | Date | S1 | S2 | S3 | S4 | S5 | S8 | S9 | S10 |
|---|---|---|---|---|---|---|---|---|---|

`emit_shape_steps_checked` (total ms across rebuild):

| Checkpoint | Date | S1 | S2 | S3 | S4 | S5 | S8 | S9 | S10 |
|---|---|---|---|---|---|---|---|---|---|

## Checkpoint log

A short note per row describing what landed between this checkpoint and the previous one. Helps explain any deltas.

| Checkpoint | Commit | Notes |
|---|---|---|
| Baseline (develop) | working tree (with bench helpers added) | Pre-refactor reference. Bench helpers themselves don't change `rebuild`/`run_schedule` so the numbers are equivalent to plain `develop`. |
| V1 cache lifecycle refactor | working tree | Renamed `RenderStep::Render` → `Paint`. Added `BuildCache(CacheKind)` and `FreeCache(CacheKind)` step variants. Added `CacheKind::{Scatter, Gather}`. Scheduler now emits `BuildCache` for shapes with scatter or root-level glass (idempotent via `emitted_caches: HashSet<CacheKind>`) and emits `FreeCache` at the schedule tail. Removed inline `if !surfaces.has_scatter_output` cache build and inline `composite_current_to_target → flush → snapshot` from the dispatch arm; the dispatcher now reads from cache via `surfaces.get_glass_backdrop` (with a defensive fallback if a `BuildCache` step is somehow missing). End-of-frame global clears for scatter/glass dropped (cache release is now per-shape via `FreeCache`). New per-step measure points: `scheduler_build_cache`, `paint_step`. |
| V2a types + pass-through dispatcher | working tree | Replaced `Paint(Uuid)` with `Paint { shape: Uuid, actions: Vec<PaintAction> }`. Added `PaintAction::{BeginLayer, Render { input, output, effects }, EndLayer}`, `EffectKey::LegacyAll` placeholder, `SurfaceInput::{None, Surface, Cache}`, `LayerPaint`. New `RenderState::scheduler_render_effects` and `scheduler_paint_legacy` methods on `RenderState` (in `tile_grid.rs` `impl` block); the legacy V1 inline orchestration moved verbatim into `scheduler_paint_legacy` and is reached via `EffectKey::LegacyAll`. Paint dispatch arm rewritten as `for action in &actions` walking. `next()` switched from `clone` to `mem::take` (with `RenderStep::default() = Enter(Uuid::nil())`) to keep walk hot path allocator-free for the new `Vec<PaintAction>` payload. **Walk regresses ~2× vs V1 baseline (still microseconds; dominated by `Vec` drop on each consumed Paint step). Production frame cost unchanged — bench isolates allocator overhead that hides behind GPU work in real rendering. Rebuild within ±8% noise.** |
| V2b per-effect dispatcher | working tree | Replaced `EffectKey::LegacyAll` with five per-effect variants matching the existing renderer's natural boundaries: `BackgroundBlur`, `Glass`, `DropShadows`, `ShapeBody` (fills + strokes + inner shadows + composite via `render_shape` + `apply_drawing_to_render_canvas`), `ScatterBlit`. `paint_step_legacy_all(uuid)` helper replaced with `paint_step_for_shape(&Shape)` that builds the per-shape effect list from shape data (`has_bg_blur`, `has_glass`, `is_scatter`, `is_text`, `drop_shadows_visible`). `scheduler_paint_legacy` deleted; `scheduler_render_effects` rewritten as a flat `match effect` dispatch, one arm per `EffectKey`. The renderer no longer encodes effect ordering — the scheduler's emit phase does. Per-individual `Fill(i)` / `Stroke(i)` / `Shadow(i)` granularity is V3, contingent on splitting `render_shape` into per-aspect functions. **Walk +18% vs V2a on the heaviest scenario (more match-arm dispatch overhead per shape with several effects); rebuild within ±3% of V2a. Production frame impact still negligible vs Skia GPU work.** |

## Follow-ups discovered during the refactor

_(append items here as they come up — perf or otherwise.)_
