# Classic-Vello (WebGPU-compute) as a third backend — migration plan

Goal: add the classic `vello` renderer (compute-based, WebGPU-only, coarse rasterization on the
GPU) as a third backend alongside Skia and vello_hybrid, so a capable device can skip the CPU coarse
cost we measured (~308 ms on the 600-blur cold frame) without giving up the WebGL fallback.

Classic vello is **already vendored** at `vello/vello/` (v0.9.0) — no external fork is needed; the new
crate depends on the local path. It requires WebGPU compute shaders (no WebGL path).

## What is already shared (no work)

- **render-core** — model, tiling (incl. `device_rect`/`resolution_cap`), `tile_cache`, `atlas`,
  `effect_graph`, `schedule`, blur, gradient, text. All backend-neutral.
- **Our own effect executor** — `blend.rs` (compositor: blit/blit_masked/clear/blur1d), `glass.rs`,
  `graph.rs` (`run_graph`, `gaussian_blur`, `custom_pass`). This is **device-generic wgpu** — it
  takes a `wgpu::Device`/`Queue` and runs *our* pipelines; it never touches vello_hybrid. It works
  against classic vello's device unchanged.
- **`scene.rs`** — written against the `RenderingContext` trait (`vello_example_scenes`), not a
  concrete `Scene`. The paint *decisions* (fills, strokes, paths, layers, text, drop shadows) are
  already abstracted.

## What actually differs between hybrid and classic — the entire seam

1. **The `Scene` container + drawing API.** `vello_hybrid::Scene` is stateful (`fill_path`,
   `fill_rect`, set-transform-then-draw). Classic `vello::Scene` is immediate (`fill(style,
   transform, brush, path)`, `draw_glyphs`, `push_layer`). `scene.rs` abstracts this via
   `RenderingContext` — **but that trait only spans the sparse-strips family (hybrid + `vello_cpu`).
   It has no impl for classic `vello::Scene`.** Providing that impl is the single biggest work item.
2. **The rasterize call.** hybrid: `Renderer::render(&scene, resources, device, queue, &mut encoder,
   size, view, &TextureBindings)` — caller owns the encoder. classic:
   `Renderer::render_to_texture(device, queue, &scene, view, &RenderParams)` — manages its own
   encoder + submit internally. A one-method `SceneRasterizer` seam abstracts this.
3. **Effect / filter layers.** hybrid has a built-in filter atlas (the CPU-coarse path that costs the
   308 ms). Classic vello has **no** built-in filters — which is fine, because we already run every
   effect (blur, glass, shadow, custom) through our own `run_graph` on our own pipelines. On classic
   we route *all* effects through `run_graph` and never touch a built-in filter path. This is the
   `blur1d`-spread lever, forced by the backend.
4. **Capability.** Classic requires WebGPU compute — no WebGL fallback. It is only ever *offered*
   when WebGPU is present; hybrid (WebGPU or its WebGL renderer) stays the fallback. This is the
   standing reason not to drop Skia/hybrid.

## The ABI decision (chosen)

`SceneState` + wire decoders → **render-core**; the FFI shell → a **shared vello crate**.

- **0a — host state.** Move `SceneState` (scene, `current` cursor, `Viewport`, dirty tracking,
  `modifiers`) + `Viewport::transform` to `render_core::host`. Pure over `render_core::model` +
  `affected_page_rect` (already lifted).
- **0b — wire decoders.** Move `parse_paragraph`, `parse_filter_graph`, `argb_to_color`,
  `uuid_u128`, `font_alias`, `paint_from_raw` to `render_core::wire` (bytes → `render_core::model`).
  Skia has parallel decoders it could eventually dedupe against these — not on this critical path.
- **0c — FFI shell stays vello.** render-vello's `abi.rs` keeps only the `#[unsafe(no_mangle)]
  extern "C"` exports (calling into `render_core::host` + `render_core::wire`) and the vello-typed
  staging (`ImageId`, pending images/fonts). It must NOT go to render-core (render-core also compiles
  for the emscripten Skia build; the Vello FFI + wgpu-typed staging don't belong there). This shell
  is shared by both Vello backends.

## Phased plan (each phase lands green against the existing hybrid backend before the next)

- **Phase 0 — ABI lift to render-core.** 0a + 0b above. `abi.rs` shrinks to the FFI shell.
  Landable now, no behavior change; verify hybrid still renders (digest + a screenshot).
- **Phase 1 — carve `render-vello-core`.** Extract the shared Vello layer: the FFI shell, `scene.rs`,
  the `graph`/`blend`/`glass` executor, `prof`, and the sink *orchestration* (tile cache, atlas
  packing, the step-execution loop). Define two seams:
  - `SceneRasterizer::rasterize(scene, device, queue, target, size, base_color)` — hybrid impl wraps
    `Renderer::render`; each impl owns its encoder/submit.
  - the `RenderingContext` impl for the flavor's Scene (hybrid impl already exists upstream).
  hybrid becomes a thin backend crate = `SceneRasterizer` impl + its `RenderingContext`. Green,
  no behavior change.
- **Phase 2 — `vello-gpu-renderer` crate (classic).** New cdylib depending on `render-vello-core`,
  classic `vello`, and render-core. Implement `RenderingContext` for `vello::Scene` (the big item)
  and the classic `SceneRasterizer` (`render_to_texture`). Add `build-vello-gpu.sh` →
  `public/wasm-vello-gpu/`, selected by `?renderer=vello-gpu`. Gate on WebGPU presence.
- **Phase 3 — route effects + verify.** All effects through `run_graph` (no hybrid filter path).
  Verify parity: cross-backend digest + screenshot parity (plain, blur+shadow, background-blur,
  glass, custom) hybrid vs classic. Measure the cold-frame delta (does GPU-coarse actually erase the
  ~308 ms?).

## Risks / open unknowns (spike these before committing to Phase 2)

- **R1 — `RenderingContext` for classic `vello::Scene`.** The primitive APIs exist
  (`fill`/`stroke`/`push_layer`/`draw_image`/`draw_glyphs`), so an impl is feasible, but clip/blend
  layer and text-run semantics may not map 1:1. **Biggest unknown; spike this first** with a
  single-shape + one-group render before building the crate.
- **R2 — atlas batching vs `render_to_texture`.** The hybrid atlas prepass renders N cells in one
  scene + one `render` + copies on one encoder. classic `render_to_texture` submits internally, so
  the "one render, many copies on one encoder" shape doesn't translate directly — atlas batching may
  be hybrid-only, or need per-cell `render_to_texture` (N submits, losing the batch win). Decide:
  accept per-surface renders on classic, or render the atlas scene once and copy in a following
  encoder.
- **R3 — wgpu state bleed.** Classic vello runs compute passes on the shared device; they may leave
  state that trips our render-pass pipelines (cf. the Skia shared-GL sampler-leak that caused the 3D
  "quilt"). Watch for it between vello's passes and our `run_graph`/blit passes.
- **R4 — no WebGL fallback.** Product gate: offer classic only when WebGPU is present; hybrid stays
  the universal fallback. Do not wire classic as a default.

## Sequencing note

Phase 0 and the R1 spike are independent and can go in parallel: Phase 0 is mechanical (lift
state+decoders, no new backend), R1 is the exploratory de-risk. Only start Phase 2 once R1 shows the
`RenderingContext` impl is viable.
