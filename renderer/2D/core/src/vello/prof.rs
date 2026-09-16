//! Temporary per-frame phase profiler for the scheduler sink. Accumulates wall-clock ms in each
//! phase across frames; the host resets, renders K frames, reads the totals, and divides. Kept
//! deliberately coarse (five buckets) so the `now()` calls don't dominate what they measure.
//!
//! Buckets: `build` (render-core schedule construction), `scene` (Vello `Scene::new` +
//! `scene_source.render` tessellation of one node), `render` (Vello `renderer.render` prepare +
//! encode, and blit encodes), `submit` (`queue.submit`), `tex` (`device.create_texture` in
//! `ensure_surface`). `steps` counts executed schedule steps, `texn` counts textures created.

use std::cell::Cell;

thread_local! {
    static BUILD: Cell<f64> = const { Cell::new(0.0) };
    static SCENE: Cell<f64> = const { Cell::new(0.0) };
    static RENDER: Cell<f64> = const { Cell::new(0.0) };
    static SUBMIT: Cell<f64> = const { Cell::new(0.0) };
    static TEX: Cell<f64> = const { Cell::new(0.0) };
    static STEPS: Cell<u32> = const { Cell::new(0) };
    static TEXN: Cell<u32> = const { Cell::new(0) };
    static RENDERS: Cell<u32> = const { Cell::new(0) };
    static POOL_HIT: Cell<u32> = const { Cell::new(0) };
    static POOL_MISS: Cell<u32> = const { Cell::new(0) };
    static TRANSIENT_PEAK: Cell<u32> = const { Cell::new(0) };
    static TRANSIENT_SUM: Cell<u32> = const { Cell::new(0) };
    static PAINTS: Cell<u32> = const { Cell::new(0) };
    static COMPOSITES: Cell<u32> = const { Cell::new(0) };
    static GATHERS: Cell<u32> = const { Cell::new(0) };
    static SUBMITS: Cell<u32> = const { Cell::new(0) };
    static GRAPHS: Cell<u32> = const { Cell::new(0) };
    /// The three phases that used to fall outside every bucket, so the frame's measured wall time
    /// had a large unexplained remainder. `plan` is the tile-cache plan + gather dirty expansion;
    /// `blit` is the compositor path (uniform + bind group + render pass per composite, and there
    /// are hundreds per frame); `present` is the swapchain acquire + present around the frame.
    static PLAN: Cell<f64> = const { Cell::new(0.0) };
    static BLIT: Cell<f64> = const { Cell::new(0.0) };
    static PRESENT: Cell<f64> = const { Cell::new(0.0) };
    /// Real GPU execution time for the frame, in ms, read back from a wgpu timestamp query that
    /// brackets every pass the sink records. Zero when the device lacks `TIMESTAMP_QUERY`. This is
    /// the only bucket here that is NOT CPU wall clock — everything else measures how long the CPU
    /// took to *describe* the work, which is a different quantity entirely.
    static GPU: Cell<f64> = const { Cell::new(0.0) };
    static GPUN: Cell<u32> = const { Cell::new(0) };
}

pub fn add_plan(ms: f64) {
    PLAN.with(|c| c.set(c.get() + ms));
}
pub fn add_blit(ms: f64) {
    BLIT.with(|c| c.set(c.get() + ms));
}
pub fn add_present(ms: f64) {
    PRESENT.with(|c| c.set(c.get() + ms));
}
/// Record one frame's resolved GPU span. Readback lags the frame that produced it by a frame or
/// two (the map is async), so this accumulates like the rest and the host divides by the frame
/// count — over a steady-state run the lag washes out.
pub fn add_gpu(ms: f64) {
    GPU.with(|c| c.set(c.get() + ms));
    GPUN.with(|c| c.set(c.get() + 1));
}

pub fn add_pool_hit() {
    POOL_HIT.with(|c| c.set(c.get() + 1));
}
/// Record one whole-viewport effect node's scratch count as it is recycled at its boundary: feeds the
/// peak (max over nodes = residency WITH recycling) and the sum (residency WITHOUT it).
pub fn note_node_scratch(n: usize) {
    let n = n as u32;
    TRANSIENT_SUM.with(|c| c.set(c.get() + n));
    TRANSIENT_PEAK.with(|c| c.set(c.get().max(n)));
}
pub fn add_pool_miss() {
    POOL_MISS.with(|c| c.set(c.get() + 1));
}

/// High-resolution wall clock in ms: `performance.now()` on wasm, a process-start-relative
/// `Instant` elsewhere. Native must be real (not a 0.0 stub) or every `dbg_add` interval below
/// collapses to zero and the native perf harnesses can't attribute CPU time at all.
pub fn now() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        web_sys::window()
            .and_then(|w| w.performance())
            .map_or(0.0, |p| p.now())
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        use std::time::Instant;
        thread_local! {
            static EPOCH: Instant = Instant::now();
        }
        EPOCH.with(|e| e.elapsed().as_secs_f64() * 1000.0)
    }
}

pub fn add_build(ms: f64) {
    BUILD.with(|c| c.set(c.get() + ms));
}
pub fn add_scene(ms: f64) {
    SCENE.with(|c| c.set(c.get() + ms));
}
pub fn add_render(ms: f64) {
    RENDER.with(|c| c.set(c.get() + ms));
}
pub fn add_submit(ms: f64) {
    SUBMIT.with(|c| c.set(c.get() + ms));
}
pub fn add_tex(ms: f64) {
    TEX.with(|c| c.set(c.get() + ms));
    TEXN.with(|c| c.set(c.get() + 1));
}
pub fn inc_step() {
    STEPS.with(|c| c.set(c.get() + 1));
}
/// Break the step count down by kind, and count the *queue submissions* they cost. A step that
/// submits on its own turns into a driver round-trip and a GPU sync point, so `submits` climbing
/// with `steps` is the thing to watch — it is what makes an effect-heavy frame expensive.
pub fn inc_paint() {
    PAINTS.with(|c| c.set(c.get() + 1));
}
pub fn inc_composite() {
    COMPOSITES.with(|c| c.set(c.get() + 1));
}
pub fn inc_gather() {
    GATHERS.with(|c| c.set(c.get() + 1));
}
pub fn inc_submit() {
    SUBMITS.with(|c| c.set(c.get() + 1));
}
/// Count one effect **pass-graph run** (`run_graph`) — a gather's blur/glass/custom, the render-pass
/// round-trip the batched gather stage is meant to collapse. This is the number `renders`
/// (backend.rasterize) does NOT show, so it is the honest before/after for the collapse.
pub fn inc_graph() {
    GRAPHS.with(|c| c.set(c.get() + 1));
}

thread_local! {
    /// TEMP scratch buckets for ad-hoc diagnostics, read via `prof_read(100 + i)`. Indices 0..15 are
    /// the tiled-path gather/atlas diagnostics; 16..28 are the per-pass GPU profiler's accumulators
    /// (16..27 pass/phase deltas, 28 = profiled-frame count) — a different render path, so no clash;
    /// 26..31 the plan executor's CPU phases; 40..47 the executor's fine windows by work kind
    /// (scale, warp, blur, scatter, pointwise, draw, paint, mixed) in GPU ms; 48 frames whose
    /// front-end overflowed a pool; 49/50 the tile and bin records the last front-end was sized for.
    static DBG: std::cell::RefCell<[f64; DBG_N]> = const { std::cell::RefCell::new([0.0; DBG_N]) };
}
/// Debug buckets available to `dbg_set`/`dbg_add`, read via `prof_read(100..100 + DBG_N)`.
pub const DBG_N: usize = 64;
/// TEMP: set diagnostic bucket `i`, read via `prof_read(100 + i)`.
pub fn dbg_set(i: usize, v: f64) {
    DBG.with(|c| { if i < DBG_N { c.borrow_mut()[i] = v; } });
}
/// Accumulate into a debug bucket (reset per frame like the rest), for counting occurrences.
pub fn dbg_add(i: usize, v: f64) {
    DBG.with(|c| { if i < DBG_N { c.borrow_mut()[i] += v; } });
}
/// Count one `renderer.render` call — with the atlas, one render covers many steps, so this drops
/// below `steps` and is the number the atlas is meant to shrink.
pub fn inc_render() {
    RENDERS.with(|c| c.set(c.get() + 1));
}

pub fn reset() {
    BUILD.with(|c| c.set(0.0));
    SCENE.with(|c| c.set(0.0));
    RENDER.with(|c| c.set(0.0));
    SUBMIT.with(|c| c.set(0.0));
    TEX.with(|c| c.set(0.0));
    STEPS.with(|c| c.set(0));
    TEXN.with(|c| c.set(0));
    RENDERS.with(|c| c.set(0));
    POOL_HIT.with(|c| c.set(0));
    POOL_MISS.with(|c| c.set(0));
    TRANSIENT_PEAK.with(|c| c.set(0));
    TRANSIENT_SUM.with(|c| c.set(0));
    PAINTS.with(|c| c.set(0));
    COMPOSITES.with(|c| c.set(0));
    GATHERS.with(|c| c.set(0));
    SUBMITS.with(|c| c.set(0));
    GRAPHS.with(|c| c.set(0));
    PLAN.with(|c| c.set(0.0));
    BLIT.with(|c| c.set(0.0));
    PRESENT.with(|c| c.set(0.0));
    GPU.with(|c| c.set(0.0));
    GPUN.with(|c| c.set(0));
    DBG.with(|c| *c.borrow_mut() = [0.0; DBG_N]);
}

/// Read a bucket: 0 build, 1 scene, 2 render, 3 submit, 4 tex, 5 steps, 6 texn (ms except counts).
pub fn read(which: u32) -> f64 {
    match which {
        0 => BUILD.with(Cell::get),
        1 => SCENE.with(Cell::get),
        2 => RENDER.with(Cell::get),
        3 => SUBMIT.with(Cell::get),
        4 => TEX.with(Cell::get),
        5 => f64::from(STEPS.with(Cell::get)),
        6 => f64::from(TEXN.with(Cell::get)),
        7 => f64::from(RENDERS.with(Cell::get)),
        8 => f64::from(POOL_HIT.with(Cell::get)),
        9 => f64::from(POOL_MISS.with(Cell::get)),
        10 => f64::from(PAINTS.with(Cell::get)),
        11 => f64::from(COMPOSITES.with(Cell::get)),
        12 => f64::from(GATHERS.with(Cell::get)),
        13 => f64::from(SUBMITS.with(Cell::get)),
        14 => f64::from(GRAPHS.with(Cell::get)),
        15 => PLAN.with(Cell::get),
        16 => BLIT.with(Cell::get),
        17 => PRESENT.with(Cell::get),
        18 => GPU.with(Cell::get),
        19 => f64::from(GPUN.with(Cell::get)),
        20 => f64::from(TRANSIENT_PEAK.with(Cell::get)),
        21 => f64::from(TRANSIENT_SUM.with(Cell::get)),
        100..=163 => DBG.with(|c| c.borrow()[(which - 100) as usize]),
        _ => 0.0,
    }
}
