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
}

pub fn add_pool_hit() {
    POOL_HIT.with(|c| c.set(c.get() + 1));
}
pub fn add_pool_miss() {
    POOL_MISS.with(|c| c.set(c.get() + 1));
}

/// High-resolution wall clock in ms (`performance.now()` on wasm, 0 elsewhere).
pub fn now() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        web_sys::window()
            .and_then(|w| w.performance())
            .map_or(0.0, |p| p.now())
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0.0
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
        _ => 0.0,
    }
}
