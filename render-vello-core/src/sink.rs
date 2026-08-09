//! The GPU production sink — executes a `render_core::schedule::Schedule` on the Vello backend.
//!
//! render-core builds the neutral schedule (which surface each shape paints into, how surfaces
//! compose, in z-order). This sink is the backend half: it maps each logical `SurfaceRef` to a GPU
//! texture, runs each step, and presents the result on the swapchain.
//!
//! - `Paint` → render one node's body (via the `PAINT_ONLY`-scoped scene render) into the target
//!   surface; the first write to a surface clears, later writes `render_load` (so a tile's output
//!   accumulates many shapes + composited effect surfaces in z-order).
//! - `Composite` → a `SrcOver` blit ([`crate::blend`]) of one surface into another (or the
//!   swapchain). The GPU clips the blit quad to the target, so an effect surface that overlaps
//!   several tiles composites the right slice into each.
//!
//! Each step submits on its own encoder — the same ordering discipline as the tile store's
//! submit-per-tile fix, and required here because a later `Paint` into a tile must observe an
//! earlier `Composite` into it.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::rc::Rc;

use render_core::atlas::{pack_grid, shelf_pack};
use render_core::peniko::color::palette::css::TRANSPARENT;
use render_core::peniko::Color;
use render_core::schedule::{
    first_write_paints, LayerPaint, PaintOp, Schedule, Step, SurfaceRef, SurfaceRole,
};
use render_core::tile_cache::TileCache;
use render_core::tiling::{self, TileKey, TILE_BUFFER, TILE_MARGIN, TILE_SIZE};
use crate::rasterize::RasterBackend;
use vello_common::kurbo::{Affine, Rect};

use crate::blend::{Blit, Compositor, MaskedBlit};
use crate::glass::GlassPipeline;
use render_core::effect_graph::{self, GlassGeometry};

use crate::graph::{build_custom_pipeline, lower_graph, new_target, run_graph, Pass};

/// Every sink surface is composited with `SrcOver`, so a first write clears to full transparency —
/// the neutral `base_color` the backend rasterizes against.
const CLEAR: Color = TRANSPARENT;

/// Distinct custom-shader render pipelines kept before the cache is dropped. Keyed by WGSL source
/// hash, so live-editing a shader (a new source every keystroke) would otherwise grow this without
/// bound. A pipeline recompiles cheaply on the next use, so clearing when full is a fine cap.
const MAX_CUSTOM_PIPELINES: usize = 64;

struct Surface {
    #[allow(dead_code)]
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    width: u32,
    height: u32,
}

/// A texture's recyclability identity: two textures are interchangeable iff their size, format, and
/// usage all match. Derived straight from the texture, so nothing threads it through `Surface`.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct PoolKey {
    w: u32,
    h: u32,
    format: wgpu::TextureFormat,
    usage: u32,
}

impl PoolKey {
    fn of(t: &wgpu::Texture) -> Self {
        Self { w: t.width(), h: t.height(), format: t.format(), usage: t.usage().bits() }
    }
}

/// Per-key free list buckets are capped so a burst of one-off sizes can't grow the pool without bound.
const MAX_POOL_PER_KEY: usize = 32;

/// A free-list of reusable GPU textures keyed by [`PoolKey`]. The sink recycles only at frame
/// boundaries (drained before this frame renders) and on tile eviction/replacement, so every pooled
/// texture belongs to a frame whose `queue.submit` has already flushed — safe to hand back out as a
/// fresh render target without extra synchronisation.
#[derive(Default)]
struct TexturePool {
    free: HashMap<PoolKey, Vec<wgpu::Texture>>,
}

impl TexturePool {
    /// A texture matching `key`, reused from the free list or freshly created. A real allocation is
    /// timed into the `tex` profiler bucket, so `texn` counts only genuine `create_texture` calls —
    /// the metric the pool is meant to drive down.
    fn acquire(&mut self, device: &wgpu::Device, key: PoolKey, label: &str) -> wgpu::Texture {
        if let Some(t) = self.free.get_mut(&key).and_then(Vec::pop) {
            crate::prof::add_pool_hit();
            return t;
        }
        crate::prof::add_pool_miss();
        let _tt = crate::prof::now();
        let tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width: key.w, height: key.h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: key.format,
            usage: wgpu::TextureUsages::from_bits_truncate(key.usage),
            view_formats: &[],
        });
        crate::prof::add_tex(crate::prof::now() - _tt);
        tex
    }

    /// Return a texture for reuse. Its key is read back off the texture, so any texture created through
    /// [`Self::acquire`] round-trips to the right bucket. Over the per-key cap it is simply dropped.
    fn release(&mut self, texture: wgpu::Texture) {
        let bucket = self.free.entry(PoolKey::of(&texture)).or_default();
        if bucket.len() < MAX_POOL_PER_KEY {
            bucket.push(texture);
        }
    }
}

/// The scheduler's GPU production sink. Owns the per-frame surface map and the SrcOver compositor.
pub struct Sink {
    compositor: Compositor,
    glass: GlassPipeline,
    /// Physical surface per logical ref, this frame. Slice-1 allocates fresh each frame (no
    /// cross-frame reuse yet — that folds in with the tile cache later).
    surfaces: HashMap<SurfaceRef, Surface>,
    /// Surfaces written at least once this frame — first write clears, rest load.
    written: HashSet<SurfaceRef>,
    /// Device-space origin of each `Backdrop` surface (its top-left in **full-zoom** device pixels),
    /// so a `PaintGather` can map the shape's device rect into the backdrop's local texel space.
    backdrop_origin: HashMap<SurfaceRef, (f64, f64)>,
    /// Resolution-cap factor `k ∈ (0, 1]` each `Backdrop` was rendered at (device-px per full-zoom
    /// device-px). `1.0` = drawn at native zoom; `< 1.0` = the effect's reach would have exceeded the
    /// one-tile ring, so it was drawn smaller and is upscaled by `1/k` at the stamp. `PaintGather`
    /// reads it to scale the sigma / glass geometry and the stamp's source rect to match.
    backdrop_scale: HashMap<SurfaceRef, f64>,
    /// Custom-shader render pipelines, cached by WGSL-source hash so an unchanged shader compiles
    /// once, not per frame. Persists across frames (unlike the per-frame surface maps).
    custom_pipelines: HashMap<u64, Rc<wgpu::RenderPipeline>>,

    /// The cross-frame **tile cache**: each *processed* tile keyed by `TileKey`, so a pan re-renders
    /// only the newly-exposed tiles and blits the rest from here. The invalidation + eviction policy
    /// (scale change → drop all, dirty rect → drop covered, LRU beyond budget) is backend-neutral and
    /// lives in [`TileCache`]; this sink only owns the `Surface` values it stores.
    tile_cache: TileCache<Surface>,

    /// The usage every texture this frame's backend rasterizes into must carry (see
    /// [`RasterBackend::rasterize_target_usage`]). Captured at the top of [`Self::execute`] so the
    /// non-generic allocation helpers (`ensure_surface`, the atlas + scratch textures) can OR it in
    /// without threading the backend through. Hybrid renders as an attachment; classic adds storage.
    raster_usage: wgpu::TextureUsages,

    /// Recycled render-target textures, so a dirty frame reuses last frame's surfaces instead of
    /// `create_texture` per tile/effect/scratch. Fed at frame boundaries + on tile eviction/replace.
    pool: TexturePool,
    /// Textures allocated for this frame that live outside the surface map (the body/spread atlases and
    /// the accumulate scratch): held here until the next frame drains them into [`Self::pool`], so
    /// their in-flight GPU work has flushed before they are reused.
    frame_transient: Vec<wgpu::Texture>,
}

impl Sink {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        Self {
            compositor: Compositor::new(device, format),
            glass: GlassPipeline::new(device, format),
            surfaces: HashMap::new(),
            written: HashSet::new(),
            backdrop_origin: HashMap::new(),
            backdrop_scale: HashMap::new(),
            custom_pipelines: HashMap::new(),
            tile_cache: TileCache::new(),
            raster_usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            pool: TexturePool::default(),
            frame_transient: Vec::new(),
        }
    }

    /// Decide, for this frame, which visible tiles must be (re)rendered. A zoom drops the whole cache
    /// (tile pixels are scale-variant). Otherwise the edited region — the page-space rects the caller
    /// drained from the abi, or everything when `dirty_all` — is invalidated tile by tile, so an edit
    /// rebuilds only the tiles it changed. Whatever visible tiles are then uncached (the invalidated
    /// ones plus the strip a pan just exposed) are returned as dirty; the caller builds the schedule
    /// for exactly them, then calls [`Self::execute`].
    pub fn plan_frame(
        &mut self,
        full_view: Affine,
        width: u32,
        height: u32,
        dirty_all: bool,
        dirty_rects: &[Rect],
    ) -> Vec<TileKey> {
        let (dirty, invalidated) =
            self.tile_cache.plan(full_view, width, height, dirty_all, dirty_rects);
        // A moved/edited shape invalidates the tiles it covered; recycle those textures (a prior
        // frame's, already flushed) so the re-render reuses them instead of allocating fresh.
        for s in invalidated {
            self.pool.release(s.texture);
        }
        dirty
    }

    /// Execute one frame's schedule onto `surface` (the swapchain texture).
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    pub fn execute<B: RasterBackend>(
        &mut self,
        schedule: &Schedule,
        dirty: &[TileKey],
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        surface: &wgpu::Texture,
        root: Affine,
        width: u32,
        height: u32,
    ) {
        // Recycle last frame's textures. Its `queue.submit` has flushed by now, so every surface here
        // (effect/scope/mask/backdrop — tile outputs already moved to the cache) and every transient
        // (atlases, accumulate scratch) is safe to hand back out as a fresh target this frame.
        for (_, s) in self.surfaces.drain() {
            self.pool.release(s.texture);
        }
        for tex in self.frame_transient.drain(..) {
            self.pool.release(tex);
        }
        self.written.clear();
        self.backdrop_origin.clear();
        self.backdrop_scale.clear();
        self.raster_usage = backend.rasterize_target_usage();
        let full_view = crate::abi::effective_view(root);
        let format = surface.format();
        let sw_view = surface.create_view(&wgpu::TextureViewDescriptor::default());

        // The page background is not a scheduled node — clear the swapchain to it, then the
        // TileOutput→Target composites land on top.
        let bg = crate::abi::background().components;
        let mut enc =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sink clear") });
        Compositor::clear(
            &mut enc,
            &sw_view,
            [f64::from(bg[0]), f64::from(bg[1]), f64::from(bg[2]), f64::from(bg[3])],
        );
        crate::prof::inc_submit();
        queue.submit([enc.finish()]);

        // Atlas prepass: the first `Paint` into each `TileOutput` is a level-0 plain body (no outward
        // blur, mutually independent), so pack them all into ONE `renderer.render` into one atlas
        // texture and copy each cell into its tile — instead of one render + submit per tile. Returns
        // the step indices it handled; the main loop skips them. Empty below the threshold.
        let mut atlased =
            self.atlas_prepass(&schedule.steps, backend, device, queue, root, full_view, format);
        // Same idea for the per-shape spread surfaces: each blurred body is an independent render, so
        // shelf-pack them into one atlas (a gap between cells keeps each blur inside its own bounds).
        atlased.extend(
            self.atlas_effects(&schedule.steps, backend, device, queue, root, full_view, format),
        );

        // Open encoder accumulating the current run of composites; `None` when nothing is pending.
        let mut comp_enc: Option<wgpu::CommandEncoder> = None;
        for (i, step) in schedule.steps.iter().enumerate() {
            if atlased.contains(&i) {
                continue;
            }
            // A run of consecutive composites shares one encoder and one submission. Any other step
            // kind flushes it first: a `Paint` into a tile must observe an earlier `Composite` into
            // that tile, and the backend's rasterize owns its own encoder/submit, so the recorded
            // composites have to be on the queue before it runs.
            if !matches!(step, Step::Composite { .. }) {
                Self::flush_composites(&mut comp_enc, queue);
            }
            match step {
                Step::Paint { ops, clip, write_to } => {
                    crate::prof::inc_paint();
                    self.paint(ops, *write_to, *clip, backend, device, queue, root, full_view, format);
                }
                Step::Composite { from, to, paint, rect, .. } => {
                    crate::prof::inc_composite();
                    let enc = comp_enc.get_or_insert_with(|| {
                        device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                            label: Some("sink composite run"),
                        })
                    });
                    self.composite(*from, *to, *paint, *rect, device, enc, &sw_view, full_view, width, height, format);
                }
                Step::ComposeBackdrop { read_from, extent, reach, always_cap, write_to, .. } => {
                    crate::prof::inc_gather();
                    self.compose_backdrop(read_from, *extent, *reach, *always_cap, *write_to, device, queue, full_view, format);
                }
                Step::PaintGather { backdrop, clip, write_to, .. } => {
                    crate::prof::inc_gather();
                    self.paint_gather(*backdrop, *clip, *write_to, backend, device, queue, root, full_view, format);
                }
                // Snapshot / layer brackets are not emitted by the builder yet.
                _ => {}
            }
        }
        Self::flush_composites(&mut comp_enc, queue);

        // --- tile cache: harvest what we just rendered, blit what we reused ---
        self.tile_cache.advance_frame();
        let dirty_set: HashSet<TileKey> = dirty.iter().copied().collect();

        // Move each freshly-rendered dirty tile's `TileOutput` into the persistent cache. The finalize
        // composite left it retained (`erase_after: false`), and it was already blitted to the
        // swapchain by that finalize — so caching it here just makes it reusable next frame. `store`
        // keeps a `None` for an empty tile too, so `plan_frame` won't keep re-dirtying it.
        for &t in dirty {
            let key = SurfaceRef::tile_ref(SurfaceRole::TileOutput, t);
            // A re-rendered dirty tile replaces its cached surface; recycle the one it displaced. The
            // displaced tile is a prior frame's (submitted + presented), so it is safe to reuse.
            if let Some(old) = self.tile_cache.store(t, self.surfaces.remove(&key)) {
                self.pool.release(old.texture);
            }
        }

        // Composite the reused (cached, not re-rendered this frame) visible tiles onto the swapchain.
        // This is the whole point: they skipped every paint/effect pass and pay only a texture blit.
        let visible = tiling::visible_tiles(full_view, width, height);
        let mut reused_enc = device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sink reused tiles") });
        let mut reused = 0u32;
        for &t in &visible {
            if dirty_set.contains(&t) {
                continue;
            }
            // A cached content tile → blit it; a cached-empty tile (`get` → `None`) shows the cleared
            // background, nothing to blit. Clone the view first so the borrow releases before `touch`.
            let Some(view) = self.tile_cache.get(t).map(|s| s.view.clone()) else {
                continue;
            };
            self.blit_tile(device, &mut reused_enc, &sw_view, t, &view, full_view, width, height);
            self.tile_cache.touch(t);
            reused += 1;
        }
        crate::prof::inc_submit();
        queue.submit([reused_enc.finish()]);
        // Machine-readable proof of reuse (rendered, reused), read via `_last_tile_stats`.
        crate::abi::set_tile_stats(u32::try_from(dirty.len()).unwrap_or(u32::MAX), reused);

        // Evict LRU beyond budget (never a visible tile) and recycle each evicted tile's texture — a
        // cached (thus prior-frame, flushed) surface, safe to reuse.
        for s in self.tile_cache.evict(&visible) {
            self.pool.release(s.texture);
        }
    }

    /// Render the level-0 plain bodies (tile + scope buffers) as one atlas instead of one
    /// `renderer.render` per surface.
    ///
    /// Collects every `Paint` that is the *first* write to a `TileOutput` or `ScopeOf` — a plain body
    /// with no outward blur, and (being a first write) independent of every other one — packs each
    /// into its own `TILE_BUFFER`² cell of a single atlas scene, does ONE render + copies each cell
    /// into its surface, all in one submit. The rest of the schedule (composites, gathers, any second
    /// paint into a surface) then runs unchanged onto the populated, `written`-marked surfaces. Returns
    /// the handled step indices; empty (falls through to the per-paint path) below the batch threshold
    /// or if the atlas would exceed the device's max texture size.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn atlas_prepass<B: RasterBackend>(
        &mut self,
        steps: &[Step],
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        root: Affine,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) -> HashSet<usize> {
        const ATLAS_MIN: usize = 3;
        let none = HashSet::new();


        // The first Paint into each surface (render-core's SSA-order primitive), kept only for the
        // `TILE_BUFFER`-sized plain bodies: a tile output or a group's scope buffer (a scope's first
        // paint is the container background + its plain children; effect children arrive later as
        // composites). Both pack the same fixed-cell atlas.
        let mut candidates: Vec<(usize, SurfaceRef, Vec<PaintOp>)> = Vec::new();
        for i in first_write_paints(steps) {
            if let Step::Paint { ops, write_to, .. } = &steps[i] {
                if matches!(write_to.role, SurfaceRole::TileOutput | SurfaceRole::ScopeOf(_)) {
                    candidates.push((i, *write_to, ops.clone()));
                }
            }
        }
        if candidates.len() < ATLAS_MIN {
            return none;
        }

        // Pack into a near-square grid of fixed `TILE_BUFFER`² cells (backend-neutral geometry).
        let max_dim = device.limits().max_texture_dimension_2d;
        let Some(packing) = pack_grid(candidates.len(), TILE_BUFFER, max_dim) else {
            return none;
        };
        let (aw, ah) = (packing.width, packing.height);

        // Build one scene: each candidate's body drawn into its cell (its tile-local transform shifted
        // to the cell origin).
        let mut scene = backend.new_scene(aw as u16, ah as u16);
        for cell in &packing.cells {
            let (_, write_to, ops) = &candidates[cell.index];
            let Some(tile) = write_to.tile else { continue };
            let (ox, oy) = tiling::tile_device_origin(tile, full_view);
            let m = f64::from(TILE_MARGIN);
            let root_for_cell = Affine::translate((f64::from(cell.x) + m - ox, f64::from(cell.y) + m - oy)) * root;
            // Clip to this cell. Every candidate shares one atlas scene, so without it a shape bigger
            // than a tile (a board border, a large 3D bake) paints out of its own 1024² cell and into
            // the neighbours, which are then copied into *their* tiles — the shape reappearing exactly
            // `TILE_SIZE` away, once per tile. The clip is the cell itself, so the tile's margin apron
            // is untouched and the batching win is kept.
            let cell_rect = Rect::new(
                f64::from(cell.x),
                f64::from(cell.y),
                f64::from(cell.x) + f64::from(TILE_BUFFER),
                f64::from(cell.y) + f64::from(TILE_BUFFER),
            );
            backend.build_bodies_clipped(&mut scene, root_for_cell, ops, cell_rect);
        }

        let atlas_usage = self.raster_usage | wgpu::TextureUsages::COPY_SRC;
        let atlas = self.pool.acquire(
            device,
            PoolKey { w: aw, h: ah, format, usage: atlas_usage.bits() },
            "body atlas",
        );
        let atlas_view = atlas.create_view(&wgpu::TextureViewDescriptor::default());

        // ONE render of every cell (the backend owns its submit), then copy each cell into its tile on
        // a following encoder. wgpu orders submits, so the atlas is fully written before the copies
        // read it.
        backend.rasterize(&scene, device, queue, &atlas_view, aw, ah, CLEAR);
        let mut enc =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("atlas copy") });
        for cell in &packing.cells {
            let (_, write_to, _) = &candidates[cell.index];
            self.ensure_surface(*write_to, device, TILE_BUFFER, TILE_BUFFER, format);
            enc.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &atlas,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: cell.x, y: cell.y, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyTextureInfo {
                    texture: &self.surfaces[write_to].texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: 0, y: 0, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d { width: TILE_BUFFER, height: TILE_BUFFER, depth_or_array_layers: 1 },
            );
            self.written.insert(*write_to);
            crate::prof::inc_step();
        }
        let _tsu = crate::prof::now();
        crate::prof::inc_submit();
        queue.submit([enc.finish()]);
        crate::prof::add_submit(crate::prof::now() - _tsu);
        self.frame_transient.push(atlas);

        candidates.iter().map(|(i, _, _)| *i).collect()
    }

    /// Render the level-0 spread bodies (per-shape `RasterEffectOutput` surfaces) as one atlas.
    ///
    /// Like [`Self::atlas_prepass`], but these surfaces vary in size (each is its shape's extrect) and
    /// carry a blur, so they are shelf-packed with a `GAP` between cells — each shape's blur is already
    /// clipped to its own layer bounds (its extrect), and the gap absorbs any 1px kernel spill so it
    /// can't reach a neighbour. Body-only custom shaders are excluded (they need the per-surface
    /// `custom_over_body` pass) and fall through to the direct path. The following `Composite` steps
    /// read the populated, `written`-marked surfaces unchanged.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn atlas_effects<B: RasterBackend>(
        &mut self,
        steps: &[Step],
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        root: Affine,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) -> HashSet<usize> {
        const ATLAS_MIN: usize = 4;
        const GAP: u32 = 4;
        let none = HashSet::new();
        let max_dim = device.limits().max_texture_dimension_2d;

        // First write to each RasterEffectOutput, minus body-only custom shaders (they need the
        // per-surface `custom_over_body` pass and fall through to the direct path). Carry each cell's
        // device size and the (dx, dy) that places its extrect at the cell origin.
        let mut cands: Vec<(usize, SurfaceRef, Vec<PaintOp>, u32, u32, f64, f64)> = Vec::new();
        for i in first_write_paints(steps) {
            let Step::Paint { ops, write_to, clip } = &steps[i] else { continue };
            let SurfaceRole::RasterEffectOutput(id) = write_to.role else { continue };
            let has_custom = crate::abi::with_scene(|live, _, _| {
                live.get(id).is_some_and(render_core::model::Node::has_spread_shader)
            });
            if has_custom {
                continue;
            }
            let (dx, dy, dw, dh) = tiling::device_rect(full_view, *clip);
            let w = (dw.ceil() as u32).max(1);
            let h = (dh.ceil() as u32).max(1);
            if w > max_dim || h > max_dim {
                continue;
            }
            cands.push((i, *write_to, ops.clone(), w, h, dx, dy));
        }
        if cands.len() < ATLAS_MIN {
            return none;
        }

        // Shelf-pack the variable-sized cells with a gap (backend-neutral geometry); the gap keeps
        // each cell's blur inside its own bounds so it can't bleed into a neighbour.
        let sizes: Vec<(u32, u32)> = cands.iter().map(|c| (c.3, c.4)).collect();
        let Some(packing) = shelf_pack(&sizes, GAP, 2048, max_dim) else {
            return none;
        };
        let (atlas_w, atlas_h) = (packing.width, packing.height);

        let mut scene = backend.new_scene(atlas_w as u16, atlas_h as u16);
        for cell in &packing.cells {
            let (_, _, ops, _, _, dx, dy) = &cands[cell.index];
            let root_for_cell = Affine::translate((f64::from(cell.x) - dx, f64::from(cell.y) - dy)) * root;
            backend.build_bodies(&mut scene, root_for_cell, ops);
        }

        let atlas_usage = self.raster_usage | wgpu::TextureUsages::COPY_SRC;
        let atlas = self.pool.acquire(
            device,
            PoolKey { w: atlas_w, h: atlas_h, format, usage: atlas_usage.bits() },
            "spread atlas",
        );
        let atlas_view = atlas.create_view(&wgpu::TextureViewDescriptor::default());

        backend.rasterize(&scene, device, queue, &atlas_view, atlas_w, atlas_h, CLEAR);
        let mut enc = device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("spread atlas copy") });
        for cell in &packing.cells {
            let (_, write_to, _, w, h, _, _) = &cands[cell.index];
            self.ensure_surface(*write_to, device, *w, *h, format);
            enc.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &atlas,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: cell.x, y: cell.y, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyTextureInfo {
                    texture: &self.surfaces[write_to].texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: 0, y: 0, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d { width: *w, height: *h, depth_or_array_layers: 1 },
            );
            self.written.insert(*write_to);
            crate::prof::inc_step();
        }
        let _tsu = crate::prof::now();
        crate::prof::inc_submit();
        queue.submit([enc.finish()]);
        crate::prof::add_submit(crate::prof::now() - _tsu);
        self.frame_transient.push(atlas);

        cands.iter().map(|(i, _, _, _, _, _, _)| *i).collect()
    }

    /// Blit a cached tile's centre `TILE_SIZE`² square onto the swapchain at its device origin — the
    /// same placement the finalize `Composite { to: Target }` uses, factored out so a reused tile can
    /// reach the screen without going through the schedule.
    #[expect(clippy::too_many_arguments, reason = "GPU context threads through the sink")]
    fn blit_tile(
        &self,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        sw_view: &wgpu::TextureView,
        tile: TileKey,
        src_view: &wgpu::TextureView,
        full_view: Affine,
        width: u32,
        height: u32,
    ) {
        let (ox, oy) = tiling::tile_device_origin(tile, full_view);
        let m = TILE_MARGIN as f32;
        let ts = TILE_SIZE as f32;
        self.compositor.blit(
            device,
            enc,
            sw_view,
            (width as f32, height as f32),
            &Blit {
                src: src_view,
                dst: (ox as f32, oy as f32, ts, ts),
                src_rect: (m, m, ts, ts),
                src_size: (TILE_BUFFER as f32, TILE_BUFFER as f32),
                alpha: 1.0,
            },
        );
    }

    /// Bound the custom-pipeline cache before inserting a new `key`: at the cap, drop the whole map
    /// (each pipeline recompiles cheaply on next use), so a churn of distinct shader sources can't
    /// grow it without limit. A key already present is a hit and never trips the cap.
    fn cap_custom_pipelines(&mut self, key: u64) {
        if !self.custom_pipelines.contains_key(&key)
            && self.custom_pipelines.len() >= MAX_CUSTOM_PIPELINES
        {
            self.custom_pipelines.clear();
        }
    }

    fn ensure_surface(&mut self, key: SurfaceRef, device: &wgpu::Device, w: u32, h: u32, format: wgpu::TextureFormat) {
        if self.surfaces.contains_key(&key) {
            return;
        }
        // Rendered into (the compositor always writes as an attachment; the backend's rasterize may
        // need more, e.g. classic's storage binding), sampled when composited, and a copy target when
        // the atlas prepass populates a tile from its atlas cell.
        let usage = wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_DST
            | self.raster_usage;
        let texture =
            self.pool.acquire(device, PoolKey { w, h, format, usage: usage.bits() }, "sink surface");
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.surfaces.insert(key, Surface { texture, view, width: w, height: h });
    }

    /// Rasterize `scene` into `target`, accumulating over anything already there.
    ///
    /// The backend rasterize seam is deliberately *clear-only* (classic vello has no load variant), so
    /// accumulation lives here, above it: the first write clears the surface to transparent and draws;
    /// a later write draws onto a transparent scratch and `SrcOver`-composites it over the surface (the
    /// shared compositor loads the target). That is exactly what hybrid's old `render_load` did, now
    /// expressed the one way both backends can honour.
    #[expect(clippy::too_many_arguments, reason = "the GPU context threads through the sink")]
    fn rasterize_accumulate<B: RasterBackend>(
        &mut self,
        backend: &mut B,
        scene: &B::Scene,
        target: &wgpu::TextureView,
        w: u32,
        h: u32,
        first: bool,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
    ) {
        if first {
            backend.rasterize(scene, device, queue, target, w, h, CLEAR);
            return;
        }
        // Rasterized into, then sampled by the compositor blit.
        let usage = self.raster_usage | wgpu::TextureUsages::TEXTURE_BINDING;
        let scratch =
            self.pool.acquire(device, PoolKey { w, h, format, usage: usage.bits() }, "sink accumulate scratch");
        let scratch_view = scratch.create_view(&wgpu::TextureViewDescriptor::default());
        backend.rasterize(scene, device, queue, &scratch_view, w, h, CLEAR);
        let mut enc = device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sink accumulate") });
        self.compositor.blit(
            device,
            &mut enc,
            target,
            (w as f32, h as f32),
            &Blit {
                src: &scratch_view,
                dst: (0.0, 0.0, w as f32, h as f32),
                src_rect: (0.0, 0.0, w as f32, h as f32),
                src_size: (w as f32, h as f32),
                alpha: 1.0,
            },
        );
        let _tsu = crate::prof::now();
        crate::prof::inc_submit();
        queue.submit([enc.finish()]);
        crate::prof::add_submit(crate::prof::now() - _tsu);
        // Recycle next frame (not now): the submit above still reads it until the GPU drains.
        self.frame_transient.push(scratch);
    }

    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn paint<B: RasterBackend>(
        &mut self,
        ops: &[PaintOp],
        write_to: SurfaceRef,
        clip: Rect,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        root: Affine,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) {
        // Surface size + the transform that places this node's content into it.
        let (w, h, root_for_target) = match write_to.role {
            // A tile output and a group's per-tile scope buffer are the same shape — a margin-padded
            // tile buffer anchored at the tile's device origin — so they place content identically.
            SurfaceRole::TileOutput | SurfaceRole::ScopeOf(_) => {
                let Some(tile) = write_to.tile else { return };
                let (ox, oy) = tiling::tile_device_origin(tile, full_view);
                let m = f64::from(TILE_MARGIN);
                (TILE_BUFFER, TILE_BUFFER, Affine::translate((m - ox, m - oy)) * root)
            }
            SurfaceRole::RasterEffectOutput(_) => {
                let (dx, dy, dw, dh) = tiling::device_rect(full_view, clip);
                let w = (dw.ceil() as u32).max(1);
                let h = (dh.ceil() as u32).max(1);
                (w, h, Affine::translate((-dx, -dy)) * root)
            }
            _ => return,
        };

        self.ensure_surface(write_to, device, w, h, format);
        let first = self.written.insert(write_to);
        let view = self.surfaces[&write_to].view.clone();

        let mut scene = backend.new_scene(w as u16, h as u16);
        backend.build_bodies(&mut scene, root_for_target, ops);
        self.rasterize_accumulate(backend, &scene, &view, w, h, first, device, queue, format);
        crate::prof::inc_step();

        // A body-only custom shader (a spread) runs its pass over the body just rendered here,
        // replacing the effect surface with the shader's output. Backdrop-reading shaders take the
        // gather path instead and never reach this — this only fires on an isolated effect surface.
        if let SurfaceRole::RasterEffectOutput(id) = write_to.role {
            self.custom_over_body(id, write_to, device, queue, format);
        }
    }

    /// Run the shape's **spread chain** (its body-only shaders, `reads_backdrop: false`) over its
    /// freshly rendered effect surface, in application order, swapping the surface for the chain's final
    /// output. Each effect's output feeds the next as its `@binding(2)` body — `[texture, noise]` warps
    /// the body then colours the warped result — so a list of effects is one shader graph, wired
    /// output → next input. (Consecutive pointwise passes each round-trip a texture here; fusing them
    /// into a single shader where no blur/gather barrier sits between them is a later optimization.)
    fn custom_over_body(
        &mut self,
        id: u128,
        write_to: SurfaceRef,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
    ) {
        let chain: Vec<(String, Vec<f32>)> = crate::abi::with_scene(|live, _, _| {
            live.get(id)
                .map(|n| n.spread_shaders().map(|c| (c.wgsl.clone(), c.params.clone())).collect())
        })
        .unwrap_or_default();
        if chain.is_empty() {
            return;
        }
        let Some(surf) = self.surfaces.get(&write_to) else { return };
        let (w, h) = (surf.width, surf.height);

        // Thread each effect's output into the next: body → e0 → e1 → … The final surface replaces the
        // body. Every effect is a one-node custom graph over its input at `@binding(2)`.
        let mut input_view = surf.view.clone();
        let mut result: Option<(wgpu::Texture, wgpu::TextureView)> = None;
        for (wgsl, params) in chain {
            // One input texture; fold the count into the key so the cached pipeline's explicit layout
            // always matches the number of textures custom_pass binds.
            let n_inputs = 1;
            let mut hasher = DefaultHasher::new();
            wgsl.hash(&mut hasher);
            n_inputs.hash(&mut hasher);
            let key = hasher.finish();
            self.cap_custom_pipelines(key);
            let pipeline = self
                .custom_pipelines
                .entry(key)
                .or_insert_with(|| build_custom_pipeline(device, &wgsl, n_inputs, format))
                .clone();

            let mut u = vec![w as f32, h as f32];
            u.extend_from_slice(&params);
            let passes = lower_graph(&effect_graph::custom_graph(u), Some(&pipeline));
            let Some((tex, view)) =
                run_graph(&self.compositor, &self.glass, device, queue, &[&input_view], &passes, w, h, format)
            else {
                return;
            };
            input_view = view.clone();
            result = Some((tex, view));
        }
        if let Some((tex, view)) = result {
            self.surfaces.insert(write_to, Surface { texture: tex, view, width: w, height: h });
        }
    }

    /// Submit whatever composites have been recorded, if any, and close the run.
    fn flush_composites(enc: &mut Option<wgpu::CommandEncoder>, queue: &wgpu::Queue) {
        let Some(e) = enc.take() else { return };
        let _tsu = crate::prof::now();
        crate::prof::inc_submit();
        queue.submit([e.finish()]);
        crate::prof::add_submit(crate::prof::now() - _tsu);
    }

    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn composite(
        &mut self,
        from: SurfaceRef,
        to: SurfaceRef,
        paint: LayerPaint,
        rect: Rect,
        device: &wgpu::Device,
        // Composites record into a caller-owned encoder instead of submitting per step: a run of
        // consecutive composites is one submission, not one each. Passes inside an encoder still
        // execute in order and read-after-write between them is ordered, so z-order holds; the
        // caller flushes before any step that is not a composite.
        enc: &mut wgpu::CommandEncoder,
        sw_view: &wgpu::TextureView,
        full_view: Affine,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
    ) {
        // A `from` surface that was never written is a scope/effect the container had no content in
        // for this tile — the composite is a no-op (matches the builder emitting per visible tile).
        let Some(src) = self.surfaces.get(&from) else { return };
        let src_view = src.view.clone();
        let src_size = (src.width as f32, src.height as f32);
        // Blend beyond SrcOver needs a read-dst pipeline; opacity is applied here, blend is a gap.
        let alpha = paint.opacity;

        match to.role {
            SurfaceRole::Target => {
                // A tile buffer's centre → swapchain at the tile's device origin.
                let Some(tile) = from.tile else { return };
                let (ox, oy) = tiling::tile_device_origin(tile, full_view);
                let m = TILE_MARGIN as f32;
                let ts = TILE_SIZE as f32;
                self.compositor.blit(
                    device,
                    enc,
                    sw_view,
                    (width as f32, height as f32),
                    &Blit {
                        src: &src_view,
                        dst: (ox as f32, oy as f32, ts, ts),
                        src_rect: (m, m, ts, ts),
                        src_size: (TILE_BUFFER as f32, TILE_BUFFER as f32),
                        alpha,
                    },
                );
            }
            // Both a tile output and a group's scope buffer are margin-padded tile buffers; a
            // composite into either allocates + clears it on first write (an effect-only or
            // scope-only tile may never have been `Paint`ed), then blends `from` in.
            SurfaceRole::TileOutput | SurfaceRole::ScopeOf(_) => {
                let Some(tile) = to.tile else { return };
                self.ensure_surface(to, device, TILE_BUFFER, TILE_BUFFER, format);
                let to_view = self.surfaces[&to].view.clone();
                if self.written.insert(to) {
                    Compositor::clear(enc, &to_view, [0.0, 0.0, 0.0, 0.0]);
                }
                let buf = TILE_BUFFER as f32;
                let blit = if matches!(from.role, SurfaceRole::RasterEffectOutput(_)) {
                    // Effect surface → placed at its device position relative to the tile.
                    let (ox, oy) = tiling::tile_device_origin(tile, full_view);
                    let m = f64::from(TILE_MARGIN);
                    let (dx, dy, dw, dh) = tiling::device_rect(full_view, rect);
                    Blit {
                        src: &src_view,
                        dst: ((dx - ox + m) as f32, (dy - oy + m) as f32, dw as f32, dh as f32),
                        src_rect: (0.0, 0.0, src_size.0, src_size.1),
                        src_size,
                        alpha,
                    }
                } else {
                    // Scope fold: a tile-aligned buffer → the same tile's buffer, 1:1.
                    Blit {
                        src: &src_view,
                        dst: (0.0, 0.0, buf, buf),
                        src_rect: (0.0, 0.0, src_size.0, src_size.1),
                        src_size,
                        alpha,
                    }
                };
                self.compositor.blit(device, enc, &to_view, (buf, buf), &blit);
            }
            _ => {}
        }
        crate::prof::inc_step();
    }

    /// Fuse the below-z-order content over a gather's sample rect into one `Backdrop` surface (sized
    /// to the sample rect, pre-filled with the page background), by blitting each covered tile's
    /// centre into it. The backdrop is the *input* the blur samples — assembling it here, at the
    /// gather's z-position, is what freezes it to only-below content.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn compose_backdrop(
        &mut self,
        read_from: &[SurfaceRef],
        extent: Rect,
        reach: f64,
        always_cap: bool,
        write_to: SurfaceRef,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) {
        let (bdx, bdy, bw, bh) = tiling::device_rect(full_view, extent);
        // Resolution cap: keep the effect's device reach within one tile so a gather never reads/writes
        // past the current tile's one-tile ring. If `reach · zoom` exceeds a tile, draw the backdrop
        // (and every downstream pass) at `k < 1`; the stamp upscales by `1/k`. Blur is low-pass, so
        // this is near-lossless; glass loses some edge detail, the accepted cost of an unbounded zoom.
        let mut k = tiling::resolution_cap(full_view, reach);
        // A custom shader (`always_cap`) additionally gets a hard resolution ceiling from any zoom —
        // its reach/cost is unprovable, so its surface never exceeds one tile+ring in its larger dim.
        if always_cap {
            let ceiling = f64::from(TILE_BUFFER) / bw.max(bh).max(1.0);
            k = k.min(ceiling).min(1.0);
        }
        let w = ((bw * k).ceil() as u32).clamp(1, 4096);
        let h = ((bh * k).ceil() as u32).clamp(1, 4096);
        self.ensure_surface(write_to, device, w, h, format);
        self.written.insert(write_to);
        self.backdrop_origin.insert(write_to, (bdx, bdy));
        self.backdrop_scale.insert(write_to, k);
        let bd_view = self.surfaces[&write_to].view.clone();

        let mut enc = device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sink backdrop") });
        let bg = crate::abi::background().components;
        Compositor::clear(
            &mut enc,
            &bd_view,
            [f64::from(bg[0]), f64::from(bg[1]), f64::from(bg[2]), f64::from(bg[3])],
        );
        let m = TILE_MARGIN as f32;
        let ts = TILE_SIZE as f32;
        let kf = k as f32;
        for src_ref in read_from {
            let Some(tile) = src_ref.tile else { continue };
            let Some(src) = self.surfaces.get(src_ref) else { continue };
            let src_view = src.view.clone();
            let (ox, oy) = tiling::tile_device_origin(tile, full_view);
            // The tile's full-zoom centre → its place in the reduced backdrop (down-sampled by `k`).
            self.compositor.blit(
                device,
                &mut enc,
                &bd_view,
                (w as f32, h as f32),
                &Blit {
                    src: &src_view,
                    dst: (((ox - bdx) as f32) * kf, ((oy - bdy) as f32) * kf, ts * kf, ts * kf),
                    src_rect: (m, m, ts, ts),
                    src_size: (TILE_BUFFER as f32, TILE_BUFFER as f32),
                    alpha: 1.0,
                },
            );
        }
        crate::prof::inc_submit();
        queue.submit([enc.finish()]);
    }

    /// Assemble a gather effect's result once (cached under the bumped ref) via [`run_graph`], then
    /// stamp it into `write_to`'s tile — through the shape's silhouette mask for background blur, or
    /// its device rect for glass (whose SDF mask is baked into the composite). The shape's own body
    /// paints on top afterward.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn paint_gather<B: RasterBackend>(
        &mut self,
        backdrop: SurfaceRef,
        clip: Rect,
        write_to: SurfaceRef,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        root: Affine,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) {
        let SurfaceRole::Backdrop(id) = backdrop.role else { return };
        let Some(bd) = self.surfaces.get(&backdrop) else { return };
        let (bw, bh) = (bd.width, bd.height);
        let Some(&(bdx, bdy)) = self.backdrop_origin.get(&backdrop) else { return };
        // The cap factor the backdrop was assembled at: sigma / glass geometry / stamp source all live
        // in this reduced space, and the stamp upscales by `1/k` back to full zoom.
        let k = self.backdrop_scale.get(&backdrop).copied().unwrap_or(1.0);

        let is_glass = crate::abi::with_scene(|live, _, _| live.get(id).is_some_and(|n| n.glass.is_some()));
        let is_custom = crate::abi::with_scene(|live, _, _| live.get(id).is_some_and(|n| n.gather_shader().is_some()));

        // Build the reusable gather result once (cached under v1). Glass → the full 4-pass composite;
        // background blur → the blurred backdrop plus a silhouette coverage mask (v2). Every dest tile
        // stamps from these, so the expensive passes run once per gather.
        let result_ref = backdrop.bump();
        let mask_ref = backdrop.bump().bump();
        if !self.surfaces.contains_key(&result_ref) {
            // The effect is a pass-graph (data): glass = displacement→refraction→blur?→composite,
            // background blur = a two-tap separable Gaussian. `run_graph` executes either uniformly.
            let passes = if is_glass {
                self.glass_graph(id, bw, bh, bdx, bdy, full_view, k)
            } else if is_custom {
                self.custom_graph(id, bw, bh, device, format)
            } else {
                let graph = effect_graph::background_blur_graph(self.gather_sigma(id, full_view, k));
                Some(lower_graph(&graph, None))
            };
            let Some(passes) = passes else { return };
            let backdrop_view = self.surfaces[&backdrop].view.clone();
            let Some((tex, view)) = run_graph(
                &self.compositor, &self.glass, device, queue, &[&backdrop_view], &passes, bw, bh, format,
            ) else {
                return;
            };
            self.surfaces.insert(result_ref, Surface { texture: tex, view, width: bw, height: bh });

            if !is_glass {
                // Coverage mask: the shape's silhouette in white, in the backdrop's device space, so
                // the masked blit clips the blur to the outline (circle/path/rounded/rotated) — not
                // its bounding box. (Glass bakes its SDF mask into the composite, so it needs none.)
                let mask = new_target(device, bw, bh, format);
                let mask_view = mask.create_view(&wgpu::TextureViewDescriptor::default());
                // Render the silhouette into the reduced backdrop the same way the tiles mapped in:
                // full-zoom device → shifted to the backdrop origin → scaled down by `k`.
                let root_for_mask = Affine::scale(k) * Affine::translate((-bdx, -bdy)) * root;
                let mut mscene = backend.new_scene(bw as u16, bh as u16);
                backend.build_mask(&mut mscene, root_for_mask, id);
                backend.rasterize(&mscene, device, queue, &mask_view, bw, bh, CLEAR);
                self.surfaces.insert(mask_ref, Surface { texture: mask, view: mask_view, width: bw, height: bh });
            }
        }
        let result_view = self.surfaces[&result_ref].view.clone();

        let Some(tile) = write_to.tile else { return };
        let (ox, oy) = tiling::tile_device_origin(tile, full_view);
        let (sdx, sdy, sdw, sdh) = tiling::device_rect(full_view, clip);
        // Intersect the shape's device rect (a coarse bound) with this tile's device content region.
        let ts = f64::from(TILE_SIZE);
        let ix0 = sdx.max(ox);
        let iy0 = sdy.max(oy);
        let ix1 = (sdx + sdw).min(ox + ts);
        let iy1 = (sdy + sdh).min(oy + ts);
        if ix1 <= ix0 || iy1 <= iy0 {
            return;
        }
        self.ensure_surface(write_to, device, TILE_BUFFER, TILE_BUFFER, format);
        let to_view = self.surfaces[&write_to].view.clone();
        let mut enc = device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sink gather paint") });
        if self.written.insert(write_to) {
            Compositor::clear(&mut enc, &to_view, [0.0, 0.0, 0.0, 0.0]);
        }
        let m = f64::from(TILE_MARGIN);
        let buf = (TILE_BUFFER as f32, TILE_BUFFER as f32);
        let dst = ((ix0 - ox + m) as f32, (iy0 - oy + m) as f32, (ix1 - ix0) as f32, (iy1 - iy0) as f32);
        // Source rect in the *reduced* backdrop texels (full-zoom device offset × k); the blit upscales
        // it by 1/k onto the full-zoom `dst`. At k == 1 this is the identity mapping of before.
        let src_rect = (((ix0 - bdx) * k) as f32, ((iy0 - bdy) * k) as f32, ((ix1 - ix0) * k) as f32, ((iy1 - iy0) * k) as f32);
        let src_size = (bw as f32, bh as f32);
        if is_glass {
            // The glass composite already baked in the SDF mask + backdrop passthrough, so a plain
            // blit over the shape's rect is correct (outside the glass it re-lays the same backdrop).
            self.compositor.blit(device, &mut enc, &to_view, buf, &Blit { src: &result_view, dst, src_rect, src_size, alpha: 1.0 });
        } else {
            let mask_view = self.surfaces[&mask_ref].view.clone();
            self.compositor.blit_masked(device, &mut enc, &to_view, buf, &MaskedBlit { src: &result_view, mask: &mask_view, dst, src_rect, src_size, alpha: 1.0 });
        }
        crate::prof::inc_submit();
        queue.submit([enc.finish()]);
    }

    /// Device-space Gaussian sigma for a background blur (render-core's [`effect_graph::background_blur_sigma`]):
    /// the shape's page-space radius mapped through the *effective* view scale (`zoom · k`). Using the
    /// capped scale is what makes the reduced-res backdrop's blur reach fit one tile —
    /// `3σ_device ≤ TILE_SIZE` by construction of `k`.
    fn gather_sigma(&self, id: u128, full_view: Affine, k: f64) -> f32 {
        let radius = crate::abi::with_scene(|live, _, _| live.get(id).and_then(|n| n.background_blur));
        let c = full_view.as_coeffs();
        let scale = ((c[0] * c[0] + c[1] * c[1]).sqrt() * k) as f32;
        effect_graph::background_blur_sigma(radius.unwrap_or(0.0), scale)
    }

    /// Build the glass pass-graph over the assembled backdrop (input 0). The geometry→uniform math is
    /// render-core's [`effect_graph::glass_graph`]; this only reads the shape's glass params/box off
    /// the live scene and lowers the neutral graph (no custom pass, so no pipeline to resolve). Glass
    /// geometry is the shape's rounded box (axis-aligned; rotation is a gap); the composite's own SDF
    /// mask does the clip, so no silhouette mask is needed.
    fn glass_graph(&self, id: u128, bw: u32, bh: u32, bdx: f64, bdy: f64, full_view: Affine, k: f64) -> Option<Vec<Pass>> {
        let (g, geom) = crate::abi::with_scene(|live, _, modifiers| {
            live.get(id).and_then(|n| {
                n.glass.map(|g| {
                    // The lens must sit where the shape is drawn *this frame*, including the live drag
                    // modifier — the backdrop it refracts is assembled at `page_bounds(node, m)` too. Using
                    // the committed bounds left the lens at the pre-drag spot while the backdrop moved, so
                    // the refraction fell outside and the glass looked like a flat frost mid-drag.
                    let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
                    let page = render_core::schedule::page_bounds(n, m);
                    // Corner radius rides in the shape's own space; scale it by the transform so a
                    // scale-drag keeps the rounding proportional to the (now page-space) width/height.
                    let [a, b, c, d, _, _] = (m * n.effective_transform()).as_coeffs();
                    let scale = ((a * a + b * b).sqrt() + (c * c + d * d).sqrt()) / 2.0;
                    let geom = GlassGeometry {
                        center: page.center(),
                        width: page.width(),
                        height: page.height(),
                        corner_radius: n.corners.map_or(0.0, |r| r.top_left) * scale,
                        is_circle: n.kind == render_core::model::ShapeKind::Circle,
                    };
                    (g, geom)
                })
            })
        })?;
        let graph = effect_graph::glass_graph(&g, geom, (bw, bh), (bdx, bdy), full_view, k);
        Some(lower_graph(&graph, None))
    }

    /// Build the custom-shader graph: one custom pass over the assembled backdrop (input 0). The
    /// neutral graph is render-core's [`effect_graph::custom_graph`]; this resolves the shape's
    /// pipeline (compiled once per distinct WGSL source, cached by hash) and lowers with it. The
    /// uniform is the backdrop resolution followed by the shader's declared params.
    fn custom_graph(&mut self, id: u128, bw: u32, bh: u32, device: &wgpu::Device, format: wgpu::TextureFormat) -> Option<Vec<Pass>> {
        let (wgsl, params) = crate::abi::with_scene(|live, _, _| {
            live.get(id).and_then(|n| n.gather_shader().map(|c| (c.wgsl.clone(), c.params.clone())))
        })?;
        // One input texture (the assembled backdrop); key on it so the explicit layout matches.
        let n_inputs = 1;
        let mut hasher = DefaultHasher::new();
        wgsl.hash(&mut hasher);
        n_inputs.hash(&mut hasher);
        let key = hasher.finish();
        self.cap_custom_pipelines(key);
        let pipeline = self
            .custom_pipelines
            .entry(key)
            .or_insert_with(|| build_custom_pipeline(device, &wgsl, n_inputs, format))
            .clone();
        let mut u = vec![bw as f32, bh as f32];
        u.extend_from_slice(&params);
        Some(lower_graph(&effect_graph::custom_graph(u), Some(&pipeline)))
    }
}
