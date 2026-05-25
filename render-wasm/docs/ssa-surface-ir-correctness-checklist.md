# SSA Surface IR — Correctness Checklist

Authoritative list of subtle behaviors the renderer must preserve through
the SSA rewrite (Step 2). Each row pairs:

- a description of the behavior
- where it lives in today's code (file:line or commit reference)
- the visual-regression cell that exercises it (or `GAP` if no cell
  covers it yet)
- known-broken status (legacy bug we don't have to preserve)

Step 1 produces this list and ensures every `GAP` is filled before Step 2
starts deleting code. Step 3 walks this list manually as final acceptance.

`tests/golden_legacy/` (= `skia-rs-wasm/test/visual/baselines/`) holds the
pixel snapshots; this doc says what each snapshot is testing.

## Status legend

- **Covered** — visual cell exists, pixel-diff catches regression
- **GAP** — no cell exercises this behavior; **must be filled before Step 2**
- **EXPECTED_FAIL** — known-broken in legacy; SSA pixel-diff failure here
  is acceptable (and SSA is encouraged to fix it)
- **BLOCKING** — SSA must not regress this; pixel-diff failure blocks Step 2

## A. Bracket-step semantics (collapse into IR in Step 2)

| Behavior | Today's code | Cell | Status |
|---|---|---|---|
| `SetTileBand` sets `current_tile` + `render_area` for downstream coord math | `run_schedule` at `tile_grid/mod.rs:2510+` | every cell | BLOCKING |
| `FinalizeBand{Intermediate}` flushes Current→Target so next band's gather sees coherent backdrop | `run_schedule` Intermediate arm | `iso_glass_3frames_overlap` | BLOCKING |
| `FinalizeBand{LastContent}` composites Current onto final canvas + drops interband cache | `run_schedule` LastContent arm | every cell | BLOCKING |
| `FinalizeBand{LastBg}` paints bg directly on Target for empty tiles | `run_schedule` LastBg arm | tiles outside content | BLOCKING |
| Interband Current snapshot/restore between bands of same tile | `snapshot_current_for_interband` / `restore_current_from_interband` | `iso_glass_*` cells | BLOCKING |
| Enter/Exit brackets keep clip+transform stack balanced | `render_shape_enter` / `render_shape_exit` | `nested_d3_b5_no_fx`, `iso_groups_100` | BLOCKING |
| `Enter.skip_body_paint=true` skips ancestor body re-paint in gather bands | `Enter` dispatch at `tile_grid/mod.rs:3300+` | `iso_glass_3frames_overlap` | BLOCKING |
| `Enter.has_external_layer=true` suppresses inline save_layer when BeginLayer preceded | same | `iso_opacity_500`, `iso_layer_blur_200` | BLOCKING |
| `Enter.has_external_gather=true` skips inline gather render in dispatcher when PaintGather preceded | same | `iso_glass_*` | BLOCKING |
| `BeginLayer/EndLayer` pair around opacity/blend/frame-blur correctly composites with paint | `BeginLayer` / `EndLayer` arms | `iso_opacity_500`, `iso_groups_100` | BLOCKING |
| `BuildCache(Gather)` runs at head of gather's band, after upstream content flushed to Target | `BuildCache` arm | `iso_glass_*`, `iso_bg_blur_100` | BLOCKING |
| `BuildCache(Scatter)` runs once per frame, dedup'd via `emitted_caches` | same | `iso_texture_200` | BLOCKING |
| `BuildCache(LocalBlur)` runs once per frame for layer-blurred shapes | same | `iso_layer_blur_200` | EXPECTED_FAIL (legacy blank) |
| `FreeCache` releases per-frame caches at end-of-schedule | tail of `build_schedule` | every cell | BLOCKING |

## B. Per-tile scope mechanics (P3-P6 V3 work; reshape in Step 2)

| Behavior | Today's code | Cell | Status |
|---|---|---|---|
| `PushScope(F)` allocates `scope_F` sized to F's viewbox-clipped world bbox | `handle_push_scope` in `tile_grid/mod.rs` | `iso_glass_3frames_overlap` | BLOCKING |
| `PushScope(F)` stashes Current's content region as `parent_stash` | same | same | BLOCKING |
| `PushScope(F)` clears Current to TRANSPARENT (not bg) so PopScope SrcOver leaves prior pixels alone | comment at `handle_push_scope` | `iso_glass_*` | BLOCKING |
| `PopScope(F, is_final_tile=false)` captures Current's tile slice onto scope_F at world offset | `handle_pop_scope` | `iso_glass_3frames_overlap` | BLOCKING |
| `PopScope(F, is_final_tile=false)` restores Current = parent_stash ⊕ tile_content via SrcOver | `restore_current_from_scope` | same | BLOCKING |
| `PopScope(F, is_final_tile=true)` drops scope_F allocation | same | last tile of F's coverage | BLOCKING |
| `mark_final_pop_scopes` backward pass flips last PopScope per shape-id | end of `build_schedule` | every scoped cell | BLOCKING |
| Offscreen-bail in PushScope (empty world_bbox) — PopScope no-ops | `handle_push_scope` early returns | scoped frame fully outside viewbox | GAP |
| Nested scopes (G inside F, both scoped) — scope chain composition | `build_gather_backdrop_scoped` walks `open_scopes` | GAP — no cell has 2-deep scoped frames with gathers in each | GAP |
| Self-scope gather (gather IS the scope frame, e.g. root-level glass on a frame) | `is_self_scope` branch in `scheduler_render_effects` | `iso_glass_solo_child` (partial) | BLOCKING |
| Per-tile gather backdrop rebuild for scoped descendants | `needs_per_tile_rebuild` branch | reverted at `b0ab42ae71`; was fixed at `5bee92d2eb` | EXPECTED_FAIL (currently broken because revert was kept) |
| Root-level gather samples Target as full-surface snapshot | `is_root_level` branch + `snapshot_source` | `iso_bg_blur_100`, `iso_glass_100` | BLOCKING |
| Scoped gather samples Target ⊕ scope_F mirrors ⊕ Current composite | `build_gather_backdrop_scoped` | `iso_glass_3frames_overlap`, `iso_glass_solo_child` | BLOCKING |

## C. Per-effect render correctness

| Behavior | Today's code | Cell | Status |
|---|---|---|---|
| Body fill — solid, gradient, image | `render_shape_into_target` → `render::shape_body` | `flat_baseline`, `iso_gradient_500` | BLOCKING |
| Strokes — caps, joins, alignment | `render::strokes` | `iso_stroke_500` | BLOCKING |
| Drop shadow — silhouette + image_filter + SrcOver under fill | `render_element_drop_shadows_and_composite` | `iso_drop_shadow_200`, `flat_1shadow`, `flat_6shadows` | BLOCKING |
| Inner shadow — SrcATop clipped to shape alpha | `render_inner_shadows` | `iso_inner_shadow_200` | BLOCKING |
| Inner shadow overlay-below-strokes (e.g. `render_overlay_below_strokes=true`) | composite order in `v1.rs:778+` | GAP — no cell toggles this explicitly | GAP |
| Layer blur on leaf shape — cached output blitted at world position | `LocalKind::paint_cached` + `BuildCache(LocalBlur)` | `iso_layer_blur_200` | EXPECTED_FAIL (legacy blank) |
| Frame-clip layer blur (clip=true + blur) | `frame_clip_layer_blur` in `shape.rs` | GAP | GAP |
| Background blur (gather variant) | `render_background_blur` | `iso_bg_blur_100` | BLOCKING |
| Glass refraction (gather variant) | `render::glass::render_glass_with_backdrop` | `iso_glass_100`, `iso_glass_3frames_overlap`, `iso_glass_solo_child` | BLOCKING |
| Scatter (texture displacement) | `Scatter` cache + `ScatterFx::Blit` | `iso_texture_200` | BLOCKING |
| Scatter + drop shadows combo | scatter dispatcher in `scheduler_render_effects` | GAP | GAP |
| Scatter container-with-children body is the cached image, descendants NOT also blitted | `emit_cache_build_for_shape` recursion guard | GAP — need a scatter container with child shapes | GAP |
| Text rendering — paragraph layout, per-glyph drops | `render::text` | `iso_text_200` | BLOCKING |
| Text drop shadow — per-glyph silhouette filter | `render_text_silhouette_into_target` | GAP — `iso_text_200` doesn't add shadows | GAP |
| Rotated text with stroke + drop shadow | shape transform path | GAP | GAP |
| SVG render — vector dom render at shape transform | `render::svg` | `iso_svg_50` | EXPECTED_FAIL (legacy blank) |
| Masked group two-pass — outer SrcOver + inner DstIn brackets mask child | `emit_masked_group_steps` | `iso_masked_50` | EXPECTED_FAIL (legacy blank) |
| Masked group with nested content (multi-shape mask body) | same | GAP | GAP |

## D. Tile-cache and viewbox

| Behavior | Today's code | Cell | Status |
|---|---|---|---|
| Tile cache fast-path: blit cached image when no shape touching tile changed | `cached_tile_blit` path in dispatcher | `iso_groups_100__pan` (cached tiles for pan) | BLOCKING |
| Tile cache invalidation on shape mutation | `invalidate_tile` + `update_touched` | every cell that mutates state | BLOCKING |
| Zoom invalidates tile cache (because scale changes) | `resize_cache` in `start_render_loop` | `iso_groups_100__zoom`, `iso_opacity_500__zoom` | BLOCKING |
| Pan reuses tile cache for tiles already painted | tile DAG topo sort + cached blit | `iso_groups_100__pan` | BLOCKING |
| Viewbox shifts during pan don't re-render unchanged tiles | same | same | BLOCKING |

## E. Z-order and dependency edges

| Behavior | Today's code | Cell | Status |
|---|---|---|---|
| Cross-tile dependency: gather in tile A waits for content from tile B if A samples B's region | `build_dependency_graph` in `tile_grid/mod.rs` | `iso_glass_3frames_overlap` (Glass crosses tile boundaries in this cell) | BLOCKING |
| Z-stacked gathers: gather B above gather A → B reads A's output (serialized) | dep graph ordering | GAP — no cell has 2 vertically-stacked gathers | GAP |
| Multiple sibling gathers in same tile, independent neighborhoods → can interleave | dep graph parallel paths | GAP | GAP |
| Multiple sibling gathers with overlapping sample neighborhoods | dep graph cross-edges | GAP — `iso_glass_3frames_overlap` is the closest but isn't quite this | partial; mark GAP |

## F. Optimization fast-paths

| Behavior | Today's code | Cell | Status |
|---|---|---|---|
| `save_layer` skip when `opacity == 1.0` and `blend == SrcOver` (no-op layer) | Skia internal; relevant for SSA to preserve | implicit in every cell | BLOCKING (perf) |
| Speculative band steps rolled back if no child emits | `emit_shape_steps_checked` truncate-on-no-child-emitted | every nested cell | BLOCKING |
| `emitted_caches` rolled back on speculative truncate | same | every cell with gathers behind containers | BLOCKING |
| Empty-tile detection: skip schedule for tiles with no shapes | `build_schedule` empty-tile tail | tiles outside content area | BLOCKING |
| Yield-between-tiles in async render (`process_animation_frame`) | `yield_check` in `run_schedule` | implicit; not pixel-testable | BLOCKING |

## G. Legacy bugs (do not regress, but fixing is welcome)

| Cell | Symptom | Root cause |
|---|---|---|
| `iso_opacity_500__idle__f30` | blank | Leaf-opacity slow path in `render_shape` produces no pixels under tile scheduler |
| `iso_opacity_500__zoom__f30` | partial | Same as above; opaque squares instead of alpha-composited |
| `iso_layer_blur_200__idle__f30` | blank | Layer blur slow path; `needs_layer()` true but blit chain blank |
| `iso_masked_50__idle__f30` | blank | Masked group two-pass plumbing incomplete; mask doesn't DstIn-clip |
| `iso_svg_50__idle__f30` | blank | SVG `dom.render()` paints at viewBox origin; no shape transform mapped |
| `nested_d3_b5_no_fx__idle__f30` | blank | Container clip + leaf-grid layout puts leaves outside selrect; bench layout issue, not scheduler |
| `mixed_kitchen_sink__idle__f30` | blank | Combined nested-layout + heterogeneous shadows |
| Per-tile gather backdrop rebuild for scoped descendants | overlay/refraction wrong on non-first tile in scoped scenes | `5bee92d2eb` was reverted by `b0ab42ae71`; fix not in current code |

Status: EXPECTED_FAIL for SSA pixel-diff. If SSA happens to render these
correctly, great — file a celebratory note. If it renders them blank
(matching legacy), also acceptable. If it renders something visibly wrong
that wasn't blank in legacy, that's a regression we care about.

## H. Gap-fill plan

Items marked `GAP` above need a visual cell before Step 2 starts. Each
gap addition:

1. Add a scene to `render-wasm/src/test_fixtures.rs` (new preset ID)
2. Mirror it in `skia-rs-wasm/test/perf/scenes.ts` (same name, next ID)
3. Add a cell to `skia-rs-wasm/test/visual/cells.ts`
4. Run `pnpm visual:baseline` to capture the PNG
5. Verify the cell renders something non-blank (or note if legacy is broken)

### Concrete gap list (12 cells to add)

| ID | Name | Exercises |
|---|---|---|
| 25 | `iso_offscreen_scope` | Scoped frame fully outside viewbox — PushScope offscreen-bail |
| 26 | `iso_nested_scopes_2deep_gathers` | Frame G inside frame F, each with a gather descendant; nested scope chain |
| 27 | `iso_inner_shadow_below_strokes` | Inner shadow rendering with `overlay_below_strokes=true` |
| 28 | `iso_frame_clip_layer_blur` | clip=true + layer blur — frame-clip blur path |
| 29 | `iso_scatter_with_shadow` | Texture displacement + drop shadow combo |
| 30 | `iso_scatter_container_with_children` | Recursive scatter shape with child shapes (must not double-blit) |
| 31 | `iso_text_with_drop_shadow` | Text with per-glyph drop shadow filter |
| 32 | `iso_rotated_text_stroked_shadowed` | Rotated text + stroke + shadow (transform pipeline) |
| 33 | `iso_masked_group_nested` | Masked group with multi-shape mask body |
| 34 | `iso_z_stacked_gathers` | Two glass shapes vertically stacked; upper samples lower's output |
| 35 | `iso_sibling_gathers_disjoint` | Two glass shapes side-by-side, non-overlapping neighborhoods |
| 36 | `iso_sibling_gathers_overlapping` | Two glass shapes adjacent, sample neighborhoods overlap |

Each is ~30 LOC of scene code + 1 LOC of cell registration.

After all gaps filled and baselines re-captured: tag `legacy-snapshot`.
