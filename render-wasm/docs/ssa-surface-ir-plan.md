# SSA Surface IR — Transition Plan

Status: design proposal
Branch: `render-wasm-ssa-surface-ir`
Owner: TBD

## Goal

Replace the current shared-Current + named-SurfaceId + bespoke-cache architecture
with a flat, **per-tile SSA-style IR** where every step has explicit `readFrom`
and `writeTo` operands. Logical surface IDs are named in the schedule;
physical Skia surfaces are managed by an allocator that pools backings based on
liveness.

The end state collapses three independent buffer mechanisms (the fixed
`SurfaceId` scratch set, the long-lived `ScopeAllocation` map, the per-effect
caches) into one uniform model: **named logical surfaces with explicit
lifetimes, scheduler-managed physical backing**.

## Target IR shape

```rust
/// Logical surface ID. Per-tile-keyed.
struct SurfaceRef {
    role: SurfaceRole,   // ScopeOf(Uuid) | Snapshot | Backdrop | TileOutput | Target
    tile: Option<Tile>,  // None for Target
    version: u32,        // for repeated writes if relaxed-SSA is used
}

enum RenderStep {
    /// Paint a shape's full body (fills + strokes + drop/inner/text shadows)
    /// into one or more logical surfaces. The fills/strokes/shadows passes
    /// are handled internally by the dispatcher using transient scratches
    /// from the allocator pool — they do NOT appear as logical SurfaceRefs
    /// in the IR, because no downstream consumer ever wants just one pass.
    /// This keeps the schedule at ~1 step per shape, not ~10.
    Paint {
        shape: Uuid,
        effects: Vec<EffectKey>,   // fills, strokes, shadows in composite order
        clip_rect: Rect,           // world-space clip (was set by SetTileBand)
        world_origin: Point,       // tile's world origin (was render_area)
        write_to: Vec<SurfaceRef>, // typically 1; may fork for pre-population
    },

    /// Take an immutable snapshot of a logical surface's current pixel state.
    /// SSA: produces a fresh SurfaceRef the snapshot is bound to.
    Snapshot {
        from: SurfaceRef,
        rect: Rect,                // sub-region of source
        write_to: SurfaceRef,      // the snapshot's logical ID
    },

    /// Compose multiple snapshots into a single backdrop surface for a
    /// downstream gather shader. Implements the 3×3 neighborhood fusion
    /// (today's build_gather_backdrop_scoped).
    ComposeBackdrop {
        shape: Uuid,               // the gather shape this backdrop is for
        read_from: Vec<SurfaceRef>,
        extent: Rect,              // gather's world-space sample region
        write_to: SurfaceRef,
    },

    /// Run a gather effect (Glass, BackgroundBlur).
    PaintGather {
        shape: Uuid,
        backdrop: SurfaceRef,
        effects: Vec<GatherFx>,
        write_to: SurfaceRef,
    },

    /// Composite one logical surface into another with a paint
    /// (opacity, blend mode, clip). Replaces EndLayer + the implicit
    /// FinalizeBand → Target composite. `erase_after=true` fuses the
    /// EraseSurface that would otherwise immediately follow — common
    /// for short-lived intermediates like scope buffers and backdrops.
    Composite {
        from: SurfaceRef,
        to: SurfaceRef,
        paint: LayerPaint,
        rect: Rect,                // destination rect in `to`'s coords
        erase_after: bool,         // fold EraseSurface(from) into this step
    },

    /// Write a logical surface's content into the cross-frame tile cache.
    /// Replaces the implicit cache_current_tile_texture step at FinalizeBand.
    WriteTileCache {
        from: SurfaceRef,
        tile: Tile,
    },

    /// Explicit kill marker. **Optional in the schedule** — liveness
    /// analysis derives it from last-use. Default schedules elide it.
    /// Used by the IR validator in debug builds and by tools that want
    /// the lifetimes spelled out.
    EraseSurface(SurfaceRef),
}
```

### Granularity rationale

The IR is **coarse-grained on purpose**:

- **One `Paint` step per shape.** Fills, strokes, drop shadows, inner
  shadows, text drop shadows are all done inside the dispatcher using
  **the same fixed singletons we use today** (`shape_fills`,
  `shape_strokes`, `drop_shadows`, `inner_shadows`, `text_drop_shadows`)
  — sequential use, no concurrent demand, allocation cost = 0 per frame.
  These never become logical SurfaceRefs because no consumer in the
  renderer wants to read just one pass — gather backdrops sample the
  *composited scope*, tile cache snapshots the *composited scope*,
  cross-tile snapshots snapshot the *composited scope*. Per-pass IDs
  would 10× the step count for zero observable benefit.
- **Composite+Erase fuse via `erase_after`** for short-lived intermediates.
  No separate Erase step for the common case.
- **EraseSurface is optional in the schedule.** Liveness derives it; the
  explicit step is for validation only.

Resulting step count on the screenshot scene (Frame 1 with Frame 2/Frame 3
descendants and one Glass shape, in Tile (0,0)): **~12 steps** vs today's
**~28** (the bracket steps Enter/Exit/BeginLayer/EndLayer/PushScope/PopScope/
SetTileBand/FinalizeBand collapse, the explicit Composite steps replace
them roughly one-for-many). On gather-heavy scenes the SSA schedule grows
by ~25% over today; on typical shape-heavy scenes the step count is
comparable.

There are **no bracket steps**. No `SetTileBand`, `FinalizeBand`, `BeginLayer`,
`EndLayer`, `Enter`, `Exit`, `PushScope`, `PopScope`, `BuildCache`, `FreeCache`.
Every responsibility those steps carried is now expressed as one of the
self-contained operations above.

## Per-tile scoping

Logical surfaces are **strictly per-tile**:

- `ScopeOf(Frame1)` at Tile (0,0) is a *different* logical ID from
  `ScopeOf(Frame1)` at Tile (1,0).
- Cross-tile reads happen only via explicit `Snapshot` steps and `ComposeBackdrop`.
- Cross-frame state exists only via `Target` (one logical ID, viewbox-sized) and
  `WriteTileCache` (per-tile, written explicitly).

This dissolves the multi-writer SSA problem and aligns the IR with how
gather effects actually sample (per-tile snapshots fused at the gather).

## What goes / what stays

### Goes (deleted entirely)

| Today | Replaced by | Notes |
|---|---|---|
| `enum SurfaceId` (Filter, Cache, Current, Fills, Strokes, DropShadows, InnerShadows, TextDropShadows) | Logical `SurfaceRef` allocated on demand | Target/UI/Debug/Export stay; the scratch set goes |
| `Surfaces.current: skia::Surface` (the fixed shared scratch) | Per-tile logical surfaces from the allocator pool | The 9× tile_area buffer goes |
| `Surfaces.filter, cache` | Per-use logical surfaces from the pool | Fixed scratches deleted |
| `RenderStep::SetTileBand` | `clip_rect` + `world_origin` baked into each `Paint`/`Composite` step | Tile context becomes per-step data |
| `RenderStep::FinalizeBand` + `FinalizeKind` | Explicit `Composite(scope → Target)` + optional `WriteTileCache` + (empty-tile) `Paint(bg → Target)` | Three implicit behaviors become three explicit steps |
| `RenderStep::Enter` + `RenderStep::Exit` (with `skip_body_paint`, `has_external_layer`, `has_external_gather`) | A `Paint` step (or nothing) for the container body, plus `Composite` for its children's scopes folding back | No more bracket semantics |
| `RenderStep::BeginLayer` + `RenderStep::EndLayer` | Children paint into the layer's logical surface; a `Composite` step folds it into the parent's surface with the layer's paint | Replaces Skia `save_layer` for the bracket cases |
| `RenderStep::PushScope` + `RenderStep::PopScope` (+ `is_final_tile`, `mark_final_pop_scopes` backward pass) | Per-tile `ScopeOf(F)` logical surfaces; cross-tile aggregation via explicit `Snapshot`/`ComposeBackdrop` | The whole scope-stack runtime collapses |
| `RenderStep::BuildCache(CacheKind)` + `RenderStep::FreeCache` | `Snapshot` + `ComposeBackdrop` (for gather); `Paint` into a logical surface (for scatter / local blur) | CacheKind enum disappears |
| `Surfaces.interband_cache: HashMap<Tile, Image>` | Falls out as a normal logical surface in the IR | The cache key becomes a SurfaceRef |
| `Surfaces.glass_backdrop_cache: HashMap<Uuid, Image>` | The `Backdrop` role SurfaceRef from `ComposeBackdrop` | Per-shape cache becomes a per-gather backdrop surface |
| `Surfaces.glass_backdrop_world_origin_cache: HashMap<Uuid, Point>` | Backdrop SurfaceRef carries its world origin as metadata | Origin lives with the surface, not in a side map |
| `Surfaces.scatter_output_cache: HashMap<Uuid, (Image, Rect)>` | Logical surface produced by a `Paint(scatter)` step | Scatter output becomes a normal SurfaceRef |
| `Surfaces.local_blur_output_cache: HashMap<Uuid, (Image, Rect)>` | Same — logical surface from a `Paint(local_blur)` step | Local blur output becomes a normal SurfaceRef |
| `RenderState.scope_allocations: FxHashMap<Uuid, ScopeAllocation>` | Per-tile logical surfaces in the pool | The "long-lived scope buffer" mechanism deletes |
| `RenderState.open_scopes: Vec<OpenScope>` | Gone — no runtime scope stack to maintain | Scope state is implicit in the IR |
| `struct ScopeAllocation`, `struct OpenScope` | Gone | |
| `RenderState.current_tile: Option<Tile>` | Gone — every step carries its own tile context | |
| `RenderState.render_area: Rect` | Gone — every step carries its own `world_origin` and `clip_rect` | |
| `handle_push_scope`, `handle_pop_scope` | Gone — no dedicated scope opcodes anymore | |
| `build_gather_backdrop_scoped` (the 250-line composer) | Replaced by the `ComposeBackdrop` step's straightforward multi-source blit | The Target+scope_chain+Current dance becomes data-driven |
| Runtime branches in `scheduler_render_effects`: `is_self_scope`, `is_root_level`, `needs_per_tile_rebuild`, `snapshot_source` | Gone — backdrop sources baked into the IR at build time | The `if`-tree collapses |
| `GatherKind::snapshot_source` | Gone — answer is in the IR | |
| `emit_cache_build_for_shape` + `emitted_caches: HashSet<CacheKind>` dedup | Gone — Snapshot/ComposeBackdrop steps emit naturally, allocator handles backing reuse | |
| `mark_final_pop_scopes` backward pass | Gone — no PopScope step to mark | |
| `restore_canvas`, `snapshot_current_for_interband`, `restore_current_from_interband`, `drop_interband`, `clear_interband_cache` | Gone — interband behavior is implicit in the IR (different bands write to different logical surfaces) | |

### Stays (essentially unchanged)

| Component | Role |
|---|---|
| `tile_grid::TileGrid` (the band/tile geometry) | Still computes which shapes touch which tiles, the band split at gather barriers, the band dependency DAG |
| `build_dependency_graph` topo sort | Still drives schedule ordering; now operates on step nodes instead of band nodes |
| `Surfaces.target: skia::Surface` | Still the viewbox accumulator. Becomes one logical SurfaceRef (`Target`). |
| `Surfaces.tiles: TileTextureCache` | Still the cross-frame per-tile output cache. Written by explicit `WriteTileCache` steps. |
| `Surfaces.ui`, `Surfaces.debug`, `Surfaces.export` | Unchanged — outside the per-tile dataflow |
| Per-pass scratches (`shape_fills`, `shape_strokes`, `drop_shadows`, `inner_shadows`, `text_drop_shadows`) + their `dirty_surfaces` bitfield | Stays as singletons. Moves from `Surfaces`'s public interface into the `Paint` dispatcher module since they're now implementation detail. Sequential use means no need for the allocator pool. |
| `GpuState`, `create_surface_with_dimensions`, `create_surface_with_isize` | Still the surface factory — but called by the allocator, not at startup |
| `render::shape_body` + `render::strokes` + `render::glass` + `render::gather` + `render::scatter` + `render::local` | Each effect's actual rendering code (the shaders, paints, draw calls) stays. We're rewiring the dispatcher around them, not rewriting them. |
| `render::gather::GatherKind::extent_world` | Still computes the gather's sample extent — now consumed by schedule builder to emit Snapshot dep edges |
| `Shape`, `ShapesPool`, `paint_plan_for_shape`, `needs_scope` | Unchanged. `needs_scope` becomes "the schedule builder emits ScopeOf surfaces for this shape's children." |
| `Viewbox`, `TileViewbox`, tile coordinate math | Unchanged |
| `perf_trace`, `perf_guard!` | Unchanged — instrumentation hooks fit any IR |
| `subtree_cache`, `effect_cache` (frame-fingerprint dedup) | Unchanged — they operate above the IR, deciding whether to reschedule a subtree at all |

### New components

| Component | Responsibility |
|---|---|
| `tile_grid::ssa::SurfaceRef` | Logical surface ID (role + tile + version) |
| `tile_grid::ssa::Step` | The new flat step enum (Paint, Snapshot, ComposeBackdrop, PaintGather, Composite, WriteTileCache, EraseSurface) |
| `tile_grid::ssa::ScheduleBuilder` | Replaces `build_schedule` + `emit_shape_steps_checked` + `emit_cache_build_for_shape`. Walks the shape tree producing Step nodes with explicit operands. |
| `tile_grid::ssa::DepGraph` | Generalizes `build_dependency_graph` to step nodes. Cross-tile edges come from Snapshot consumers depending on Snapshot producers. |
| `tile_grid::ssa::LivenessPass` | One backward pass per tile (since scopes are per-tile). Computes `[first_write, last_read]` per SurfaceRef. |
| `tile_grid::ssa::SurfaceAllocator` | Free-list pool keyed by size class. Returns physical `skia::Surface` for a logical SurfaceRef; reclaims on EraseSurface or implicit last-read. Cross-frame texture recycling lives here. |
| `tile_grid::ssa::Dispatcher` | Replaces `run_schedule`'s 700-line match. Flat loop: read step, resolve operands via allocator, execute draw. |
| `tile_grid::ssa::IrValidator` (debug builds) | Verifies SSA invariants: each SurfaceRef has one producer, ≥1 consumer, last-read ≤ EraseSurface ≤ next-write, no use-after-erase. |

## Migration

Single big-bang rewrite. No release process to gate, no other engineers to
review against the legacy path, so the phased migration's main benefits
(incremental delivery, bisectability across landings, hybrid maintenance
for ongoing develop traffic) don't apply. The plan is: snapshot legacy
outputs, delete legacy, rebuild from scratch, diff against the snapshot.

### Step 1 — Capture baseline (1–3 days)

Before deleting anything, lock in what "correct" means.

**Pixel snapshots:**
- Run every test in `skia-rs-wasm/test/visual/*` through the current
  renderer. Save each tile's PNG output to `render-wasm/tests/golden_legacy/`
  keyed by `(test_name, tile)`.
- Add a small CLI / test harness to `render-wasm` that takes a scene and
  emits per-tile PNGs to a directory. Reuse for both the snapshot run and
  later verification.
- Tag the commit at this point: `git tag legacy-snapshot` — so a
  `git worktree add` from this tag can re-render any scene through
  legacy mid-development if the diff isn't enough to debug.

**Perf snapshots:**
- Run the perf benches in `skia-rs-wasm/test/perf/` against representative
  scenes. Capture `perf_trace`'s JSON output to
  `render-wasm/tests/perf_baseline/`.
- Numbers needed per scene: `frame_TOTAL`, `tile_grid_rebuild`,
  `run_schedule_TOTAL`, peak GPU memory (via `webgl_lost_context` /
  Skia stats), allocation count per frame.

**Edge-case checklist:**
- Walk `band-scheduler.md`, `per-effect-refactor-v2-plan.md`,
  `v2c3-subtree-cache.md`, and the commit log for the last ~6 months.
  Extract every subtle behavior the renderer handles. Write them to
  `render-wasm/docs/ssa-surface-ir-correctness-checklist.md`.
- Covers at minimum: masked groups (Phase E DstIn semantics), nested
  scoped frames with multiple gathers, scatter with drop shadows, layer
  blur on rotated text, frame-clip blur, opacity-1.0 save_layer skip,
  inner shadow overlay-above-vs-below-stroke, root-level vs scoped
  gather sample radius, tile cache invalidation across shape mutations.
- This checklist is the acceptance criteria for Step 3.

**Gap fill:**
- If any item on the checklist isn't covered by a visual regression test,
  add one before proceeding. The pixel snapshot only catches what's in
  the test set.

Exit criteria: PNG snapshots and perf JSON checked into the repo, edge-case
checklist written, every checklist item covered by ≥1 visual regression test,
`legacy-snapshot` tag pushed.

### Step 2 — Delete and rebuild (2–4 weeks)

Now the legacy code can go. The pixel snapshots are the source of truth;
the legacy code is not.

**Deletes (do these first, get them out of the way):**
- `RenderStep::{SetTileBand, FinalizeBand, Enter, Exit, BeginLayer,
  EndLayer, PushScope, PopScope, BuildCache, FreeCache}`
- `FinalizeKind`
- `CacheKind`
- `RenderState.{current_tile, render_area, scope_allocations, open_scopes,
  emitted_caches}` (and the `ScopeAllocation`, `OpenScope` types)
- `Surfaces.{filter, cache, current, interband_cache, glass_backdrop_cache,
  glass_backdrop_world_origin_cache, local_blur_output_cache,
  scatter_output_cache}` and the associated `SurfaceId::{Filter, Cache,
  Current}` variants
- Methods: `handle_push_scope`, `handle_pop_scope`,
  `build_gather_backdrop_scoped`, `mark_final_pop_scopes`,
  `snapshot_source`, `emit_cache_build_for_shape`, `build_schedule`,
  `emit_shape_steps_checked`, `scheduler_render_effects`'s gather
  branches, `restore_canvas`, `snapshot_current_for_interband`,
  `restore_current_from_interband`, `drop_interband`,
  `clear_interband_cache`

What stays untouched: the effect renderers (`render/glass.rs`,
`render/scatter.rs`, `render/gather.rs`, `render/local.rs`,
`render/shape_body.rs`, `render/strokes.rs`, the shadow code), `Shape`,
`ShapesPool`, `Viewbox`, tile geometry, `subtree_cache`, `effect_cache`,
`perf_trace`, `Surfaces.{target, tiles, ui, debug, export}`, and the
per-pass singletons inside the Paint dispatcher.

**Build:**
- `tile_grid::ssa::{SurfaceRef, Step, ScheduleBuilder, DepGraph,
  LivenessPass, SurfaceAllocator, Dispatcher, IrValidator}`
- Wire the new dispatcher to call existing effect renderers with the
  right inputs. The effect renderers don't change.
- Hook into the same entry points (`start_render_loop`,
  `process_animation_frame`, `render_shape_tree_sync`) that drive
  `run_schedule` today.

**Suggested sub-PR carve-up** (against the SSA branch, not develop —
they don't need to land independently, this is just for the engineer's
mental organization):

1. `SurfaceAllocator` + `IrValidator` standalone, with unit tests against
   synthetic schedules. No integration with the renderer yet.
2. `Step` enum + `Dispatcher` skeleton, dispatching to stub effect
   renderers. Verifies the dispatch path before plugging in real renderers.
3. `ScheduleBuilder` + `DepGraph` + `LivenessPass`, walking real shape
   trees and emitting real schedules. Pixel-diff against snapshots starts
   here.
4. Wire-up + delete the legacy code paths.

The four sub-PRs squash into one commit when merging to develop.

Exit criteria: pixel-diff passes on every scene in the visual regression
suite; every item on the correctness checklist verified; perf benches
within 5% of baseline on every scene.

### Step 3 — Verify and tune (3–5 days)

Per-scene comparison run:

- Render every visual regression scene through the new system. Pixel-diff
  against `tests/golden_legacy/`. Failures get debugged one at a time;
  the `legacy-snapshot` worktree is the reference.
- Run perf benches. Compare `frame_TOTAL` to baseline. If any scene is
  >5% slower, profile and fix before declaring done.
- Walk the correctness checklist manually. Each item: render a scene
  exercising it, eyeball the output, mark verified.

Tuning targets:
- Pool size class boundaries (start with 3: tile, scope, viewbox)
- Pool high-water mark cap (start with 16 surfaces, adjust)
- Pipeline interleaving depth K (start with 4, may need to drop for
  mobile drivers)

Exit criteria: zero pixel diffs on the regression suite, perf within 5%
of baseline, correctness checklist fully verified.

### After Step 3

- Delete `tests/golden_legacy/` and the `legacy-snapshot` tag (or keep
  them if you want a historical reference)
- Update `docs/band-scheduler.md`, `docs/per-effect-refactor-v2-plan.md`,
  `docs/v2c3-subtree-cache.md` to reference the new IR
- Remove this plan doc, or move it to `docs/history/` if the project
  archives old plans

## Validation strategy

1. **Pixel snapshots** (Step 1): per-tile PNGs from the current renderer
   checked into `tests/golden_legacy/`. After rebuild, render the same
   scenes through SSA and pixel-diff against the snapshots. Zero drift
   acceptance criterion.
2. **Perf baselines** (Step 1): per-scene `perf_trace` JSON checked into
   `tests/perf_baseline/`. Budget after rebuild: ≤5% regression on any
   scene, ≤0% overall.
3. **Correctness checklist** (Step 1): every subtle behavior the renderer
   handles, written down. Manually verified at Step 3.
4. **IR validator**: debug-build pass that checks SSA invariants per
   schedule. Catches use-after-erase, leaked surfaces, dep ordering bugs.
   Runs in debug builds during Step 2 development.
5. **legacy-snapshot git tag**: kept at the pre-delete commit. If a
   pixel-diff fails mid-rebuild, `git worktree add` from the tag lets
   you render the same scene through legacy for comparison.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `save_layer` perf parity for the bracket cases | Keep `save_layer` as the dispatcher implementation for LIFO-only opacity/blend wrappers. The IR's `Composite` step dispatches either to `save_layer` (LIFO common case) or to explicit pool surfaces (cross-tile, multi-reader). Hybrid by default; revisit if profiling shows the dispatch overhead exceeds save_layer's intrinsic cost. |
| GPU memory pressure from per-frame allocation | The `SurfaceAllocator`'s pool retains drained surfaces across frames. Logical IDs are per-frame, physical Skia surfaces are recycled. Steady-state animation frames allocate zero. |
| Driver framebuffer-switch cost on mobile GL | Interleaving policy throttles concurrent in-flight surfaces. `max_concurrent_surfaces = 8` is a reasonable default. Consider `SkPicture` recording if measurements warrant. |
| Large reveal at end of Step 2 (the "big-bang risk") | (a) Prototype `SurfaceAllocator` + `Dispatcher` standalone with synthetic schedules early in Step 2 — validates the design before wiring up the full `ScheduleBuilder`. (b) The `legacy-snapshot` tag lets you `git worktree add` legacy for any scene that diffs unexpectedly during the rebuild. (c) Sub-PR carve-up inside Step 2 keeps reviewable chunks even though they all squash to one merge commit. |
| Long-tail subtle correctness bugs (drop-shadow placement on rotated stroked text, masked group composition edge cases, etc.) | Step 1's gap-fill task: the visual regression suite must cover every item on the correctness checklist before Step 2 starts. Without that, the snapshot is incomplete and pixel-diff is a weak safety net. |
| Cross-tile snapshot count under stacked-gather scenes | SSA snapshot dedup (same `(scope, tile)` → one step). Streaming kill (EraseSurface as soon as last consumer fires). |
| Cross-frame async yields (`process_animation_frame`) | Constrain yields to inter-tile boundaries (since per-tile scopes die at tile end). One-line scheduler change. |

## Out of scope

- The frontend (Penpot UI). No changes to `frontend/` of any kind.
- Liquibase / DB migrations. (Per CLAUDE.md memory: no prod DB yet.)
- Skia upstream changes. We work within what `skia-safe` exposes.

## Open questions

1. **Hybrid or full replace for `save_layer`?** Default is hybrid:
   `save_layer` backs LIFO opacity/blend wrappers, explicit pool surfaces
   back everything else. Revisit during Step 3 tuning if dispatch
   overhead shows up in profiles.
2. **`SkPicture` for shape recording?** Worth experimenting with during
   Step 3 if framebuffer-switch cost shows up in profiles. Not on the
   critical path; defer unless needed.
3. **Cross-frame TileCache invalidation under SSA IDs?** Keep today's
   shape-mutation tracking. If content hashing becomes attractive later
   (e.g. for incremental rebuilds), it slots into the `WriteTileCache`
   step naturally.

## Reference: the screenshot scenario under SSA IR

For the scene with Frame 1 (containing Frame 2/Frame 3, with Glass as a
descendant whose backdrop scope is Frame 1) plus Frame 4 in Tile (1,0),
the SSA schedule for Tile (0,0) is roughly:

```
// Producers for Glass's 3×3 sample neighborhood
Paint{frame1_body,  write=[ScopeOf(F1, T00)]}
Paint{frame2_body,  write=[ScopeOf(F2, T00)]}
Paint{rect1_body,   write=[ScopeOf(F2, T00)]}
Composite{ScopeOf(F2, T00), ScopeOf(F1, T00), paint=F2_layer}
Paint{frame3_body,  write=[ScopeOf(F3, T00)]}

// (Producers for neighboring tiles' contributions to F1 also fire here,
//  ordered by the dep graph; in this scene F1's content is all in T00 so
//  the neighborhood collapses to a single tile.)

Snapshot{ScopeOf(F1, T00), rect=glass_extent, write=Snap1}
ComposeBackdrop{Glass, read=[Snap1], extent=glass_extent, write=GlassBackdrop}
EraseSurface{Snap1}

PaintGather{Glass, backdrop=GlassBackdrop, write=ScopeOf(F3, T00)}
Paint{glass_body, write=[ScopeOf(F3, T00)]}
Paint{rect2_body, write=[ScopeOf(F3, T00)]}
EraseSurface{GlassBackdrop}

Composite{ScopeOf(F3, T00), ScopeOf(F1, T00), paint=F3_layer}
Composite{ScopeOf(F1, T00), Target, paint=SrcOver, rect=tile_00_rect}
WriteTileCache{ScopeOf(F1, T00), tile=T00}
EraseSurface{ScopeOf(F3, T00)}
EraseSurface{ScopeOf(F2, T00)}
EraseSurface{ScopeOf(F1, T00)}

// Tile (1,0) — independent, can interleave with the above where deps allow
Paint{frame4_body, write=[ScopeOf(F4, T10)]}
Composite{ScopeOf(F4, T10), Target, paint=SrcOver, rect=tile_10_rect}
WriteTileCache{ScopeOf(F4, T10), tile=T10}
EraseSurface{ScopeOf(F4, T10)}
```

Liveness ranges for Tile (0,0):

```
ScopeOf(F1, T00)  [step 1   ..  Composite-to-Target]
ScopeOf(F2, T00)  [step 2   ..  Composite-to-F1]
ScopeOf(F3, T00)  [step 5   ..  Composite-to-F1]
Snap1             [Snapshot ..  ComposeBackdrop]
GlassBackdrop     [Compose  ..  PaintGather]
```

Non-overlapping ranges (e.g. F2 ends at step ~6, F3 starts at step 5 —
slight overlap, can't share; but F2 and Snap1 don't overlap, can share)
collapse onto a smaller physical surface pool. Allocator handles this.

The allocator output for a typical tile: **4–6 physical surfaces**
backing **8–12 logical IDs**. No fixed 13-scratch allocation at startup.
