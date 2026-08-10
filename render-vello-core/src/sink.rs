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
    first_write_paints, GatherPlan, LayerPaint, PaintOp, Schedule, Step, SurfaceRef, SurfaceRole,
};
use render_core::tile_cache::TileCache;
use render_core::tiling::{self, TileKey, TILE_BUFFER, TILE_MARGIN, TILE_SIZE};
use crate::rasterize::RasterBackend;
use vello_common::kurbo::{Affine, Rect};

use crate::blend::{Blit, Compositor, MaskedBlit};
use crate::glass::GlassPipeline;
use render_core::effect_graph::{self, GlassGeometry};

use crate::graph::{build_custom_pipeline, lower_graph, new_target_with_usage, run_graph, Pass};
use crate::snapshot::{SnapshotKey, SnapshotPool};

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
pub(crate) struct PoolKey {
    w: u32,
    h: u32,
    format: wgpu::TextureFormat,
    usage: u32,
}

impl PoolKey {
    fn of(t: &wgpu::Texture) -> Self {
        Self { w: t.width(), h: t.height(), format: t.format(), usage: t.usage().bits() }
    }

    /// Construct a key directly — for callers outside the sink (the snapshot pool) that acquire
    /// textures of a chosen size/format/usage.
    pub(crate) fn new(w: u32, h: u32, format: wgpu::TextureFormat, usage: wgpu::TextureUsages) -> Self {
        Self { w, h, format, usage: usage.bits() }
    }
}

/// Per-key free list buckets are capped so a burst of one-off sizes can't grow the pool without bound.
const MAX_POOL_PER_KEY: usize = 32;

/// A free-list of reusable GPU textures keyed by [`PoolKey`]. The sink recycles only at frame
/// boundaries (drained before this frame renders) and on tile eviction/replacement, so every pooled
/// texture belongs to a frame whose `queue.submit` has already flushed — safe to hand back out as a
/// fresh render target without extra synchronisation.
#[derive(Default)]
pub(crate) struct TexturePool {
    free: HashMap<PoolKey, Vec<wgpu::Texture>>,
}

impl TexturePool {
    /// A texture matching `key`, reused from the free list or freshly created. A real allocation is
    /// timed into the `tex` profiler bucket, so `texn` counts only genuine `create_texture` calls —
    /// the metric the pool is meant to drive down.
    pub(crate) fn acquire(&mut self, device: &wgpu::Device, key: PoolKey, label: &str) -> wgpu::Texture {
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
    pub(crate) fn release(&mut self, texture: wgpu::Texture) {
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
    /// Frozen backdrop tiles for the batched gathers that need one — those whose sample rect is
    /// disturbed by something above, so the finished tiles no longer hold what they read. Captured at
    /// each such gather's z-position during the walk, sampled by the batch, cleared at frame end.
    snapshots: SnapshotPool,
    /// Which snapshot backs each `(batched gather index, backdrop tile)`, filled during the walk and
    /// consumed by `atlas_gather`. Cleared with the pool.
    snapshot_of: HashMap<(usize, TileKey), SnapshotKey>,

    /// DEBUG: an atlas captured this frame (view, w, h) to blit over the swapchain so the batched
    /// gather's intermediates can be inspected. Selected by `abi::debug_atlas()`.
    dbg_atlas: Option<(wgpu::TextureView, u32, u32)>,
}

/// Live backdrop snapshots allowed at once. Each is one buffered tile (`TILE_BUFFER`² RGBA8 = 4 MiB),
/// so this is a VRAM ceiling: 16 → 64 MiB. Gathers that would push past it keep the inline path rather
/// than the batch, so the bound costs passes, never correctness.
///
/// **Set to 0: the snapshot-backed tier is off.** The machinery below is complete and the freeze is
/// provably total (every read tile of every frozen gather had a live surface and was copied, 1712/1712
/// measured, and every capture produced its own entry — 1728 captures, 1728 distinct snapshots, so
/// nothing aliases). But on the bench's fringe-covered lens grid, 5 of 25 lenses still differ from
/// the inline reference: their backdrop is missing a moving shape that the inline compose reads at
/// the same z. That is unexplained, so the tier stays disabled until it is — a wrong lens is worse
/// than a slow one. Raise this to re-enable once the divergence is understood.
const SNAPSHOT_CAP: usize = 0;

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
            snapshots: SnapshotPool::new(SNAPSHOT_CAP),
            snapshot_of: HashMap::new(),
            dbg_atlas: None,
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
        // Atomic gather invalidation: a lens samples a region wider than its footprint, so any frame
        // that repaints part of its backdrop must re-render the *whole* lens — otherwise the tiles it
        // doesn't cover keep a stale half-blur and the lens tears along tile seams. Grow the dirty set
        // by every affected gather's sample rect before planning tiles.
        let rects: std::borrow::Cow<[Rect]> = if dirty_all || dirty_rects.is_empty() {
            std::borrow::Cow::Borrowed(dirty_rects)
        } else {
            let extra = crate::abi::with_scene(|scene, _, modifiers| {
                render_core::schedule::gather_dirty_expansion(scene, modifiers, full_view, dirty_rects)
            });
            if extra.is_empty() {
                std::borrow::Cow::Borrowed(dirty_rects)
            } else {
                let mut all = dirty_rects.to_vec();
                all.extend(extra);
                std::borrow::Cow::Owned(all)
            }
        };
        let (dirty, invalidated) =
            self.tile_cache.plan(full_view, width, height, dirty_all, &rects);
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
        // Frozen backdrops are frame-scoped like everything above, and released on the same "last
        // frame's submit has flushed" argument.
        self.snapshots.clear(&mut self.pool);
        self.snapshot_of.clear();
        self.written.clear();
        self.backdrop_origin.clear();
        self.backdrop_scale.clear();
        // TEMP gather-collapse projection (buckets 108-111): the analysis's verdict for this frame —
        // total gathers vs how many defer, the passes with the collapse applied vs `total` today, and
        // the batched dispatch count. Lets the bench show the projected reduction before the sink acts.
        let gp = &schedule.gather_plan;
        crate::prof::dbg_set(8, gp.total() as f64);
        crate::prof::dbg_set(9, gp.deferrable_count() as f64);
        crate::prof::dbg_set(10, gp.estimated_passes() as f64);
        crate::prof::dbg_set(11, gp.batched_dispatches() as f64);
        self.raster_usage = backend.rasterize_target_usage();
        let full_view = crate::abi::effective_view(root);
        let format = surface.format();
        let sw_view = surface.create_view(&wgpu::TextureViewDescriptor::default());

        // Steps share an encoder in **bounded batches** rather than submitting one at a time.
        //
        // A submit per step is a driver round-trip and a GPU sync point, and an effect-heavy frame ran
        // ~440 of them. But going all the way to one encoder per frame is worse: wgpu keeps every
        // resource an *unsubmitted* encoder references alive, so peak GPU memory becomes the **sum**
        // over steps instead of the max — measured at ~3.5 GB allocated on a 20k-shape effect scene,
        // which OOMed. Batching bounds both: ~440 submits collapse to ~440/BATCH, while peak memory
        // stays a small multiple of one step's.
        //
        // Ordering holds regardless: commands within an encoder run in order, and submits are ordered
        // against each other, so a `Paint` still observes an earlier `Composite` either way.
        // Steps per encoder before a submit (0 = whole frame in one encoder — the unbounded case that
        // OOMed). Runtime-tunable so the bench can sweep it and prove the memory effect. A backend
        // whose rasterize aliases GPU state across a shared submit (vello_hybrid's persistent config
        // buffer) is not batchable, so it submits per step (batch 1) regardless of the knob.
        let safe = backend.batched_submits_safe();
        let batch = if safe { crate::abi::sink_batch() } else { 1 };
        let mut frame_enc = device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sink batch") });

        // The page background is not a scheduled node — clear the swapchain to it, then the
        // TileOutput→Target composites land on top.
        let bg = crate::abi::background().components;
        Compositor::clear(
            &mut frame_enc,
            &sw_view,
            [f64::from(bg[0]), f64::from(bg[1]), f64::from(bg[2]), f64::from(bg[3])],
        );

        // Batched gather collapse: the deferrable pure-lens blur groups worth batching (>= 2). Their
        // ComposeBackdrop/PaintGather steps are skipped below and run as one atlas after the loop; the
        // finalize composites (TileOutput→Target) are held until after that scatter lands in the tiles.
        let gather_groups: Vec<Vec<usize>> = if crate::abi::gather_batch() {
            schedule.gather_plan.batched_groups()
        } else {
            Vec::new()
        };
        // Shape → its index in the plan, for the steps the walk hands to the batch instead of running.
        let batched_gathers: HashMap<u128, usize> = gather_groups
            .iter()
            .flatten()
            .map(|&gi| (schedule.gather_plan.gathers[gi].shape, gi))
            .collect();
        // Only pay for write-versioning when something will actually be frozen.
        let versioning = gather_groups
            .iter()
            .flatten()
            .any(|&gi| schedule.gather_plan.gathers[gi].needs_snapshot);

        // The per-shape spread surfaces first: each blurred body is an independent render, so shelf-pack
        // them into one atlas (a gap between cells keeps each blur inside its own bounds). Doing this
        // before the fuse means those surfaces exist to be inlined.
        let mut atlased =
            self.atlas_effects(&schedule.steps, backend, device, queue, &mut frame_enc, root, full_view, format);
        if !safe {
            Self::submit_batch(&mut frame_enc, device, queue, backend);
        }
        // Tile-fuse: a tile whose only effects are spreads draws its bodies AND those spread surfaces
        // (inlined as images) as one scene — collapsing the plain run an effect composite used to split
        // into a rasterize per segment. No-op on backends without inline images (hybrid). Consumes the
        // tile's paints + spread composites so the prepass and main loop skip them.
        atlased.extend(
            self.atlas_fuse(&schedule.steps, &batched_gathers, backend, device, queue, &mut frame_enc, root, full_view, format),
        );
        if !safe {
            Self::submit_batch(&mut frame_enc, device, queue, backend);
        }
        // Atlas prepass: the first `Paint` into each *remaining* (non-fused) `TileOutput`/`ScopeOf` is a
        // level-0 plain body, mutually independent — pack them into ONE render and copy each cell into
        // its tile. Returns the step indices it handled; the main loop skips them.
        atlased.extend(
            self.atlas_prepass(&schedule.steps, &atlased, backend, device, queue, &mut frame_enc, root, full_view, format),
        );
        if !safe {
            Self::submit_batch(&mut frame_enc, device, queue, backend);
        }

        let mut finalize: Vec<usize> = Vec::new();

        let mut batched = 0_u32;
        for (i, step) in schedule.steps.iter().enumerate() {
            if atlased.contains(&i) {
                continue;
            }
            // Deferred to the batched gather stage. Its backdrop is normally recomposed there from the
            // finished tiles; a gather whose sample something above disturbs has to have its backdrop
            // frozen *here*, at its own z, for the batch to read instead.
            if let Step::ComposeBackdrop { shape, read_from, .. } = step {
                if let Some(&gi) = batched_gathers.get(shape) {
                    if schedule.gather_plan.gathers[gi].needs_snapshot {
                        self.freeze_backdrop(gi, read_from, device, &mut frame_enc);
                    }
                    continue;
                }
            }
            if let Step::PaintGather { shape, .. } = step {
                if batched_gathers.contains_key(shape) {
                    continue;
                }
            }
            // Finalize composites wait until the gather batch has scattered into the tiles.
            if let Step::Composite { to, .. } = step {
                if to.is_target() {
                    finalize.push(i);
                    continue;
                }
            }
            match step {
                Step::Paint { ops, clip, write_to } => {
                    crate::prof::inc_paint();
                    self.paint(ops, *write_to, *clip, backend, device, queue, &mut frame_enc, root, full_view, format);
                }
                Step::Composite { from, to, paint, rect, .. } => {
                    crate::prof::inc_composite();
                    self.composite(*from, *to, *paint, *rect, device, &mut frame_enc, &sw_view, full_view, width, height, format);
                }
                Step::ComposeBackdrop { read_from, extent, reach, always_cap, write_to, .. } => {
                    crate::prof::inc_gather();
                    self.compose_backdrop(read_from, *extent, *reach, *always_cap, *write_to, device, &mut frame_enc, full_view, format);
                }
                Step::PaintGather { backdrop, clip, write_to, .. } => {
                    crate::prof::inc_gather();
                    self.paint_gather(*backdrop, *clip, *write_to, backend, device, queue, &mut frame_enc, root, full_view, format);
                }
                // Snapshot / layer brackets are not emitted by the builder yet.
                _ => {}
            }
            // Advance the version of every tile this step touched, so a later freeze of the same tile
            // takes a second copy instead of aliasing the one taken before the write.
            if versioning {
                for r in step.writes().into_iter().chain(step.rewrites()) {
                    if let Some(tile) = r.tile {
                        self.snapshots.on_write(tile);
                    }
                }
            }
            batched += 1;
            if batch != 0 && batched >= batch {
                // Submit this batch and start a fresh encoder, so at most `batch` steps' worth of
                // transient GPU memory is ever held unsubmitted.
                Self::submit_batch(&mut frame_enc, device, queue, backend);
                batched = 0;
            }
        }

        // The batched gather collapse: every deferred blur lens's backdrop composed into one atlas,
        // blurred once per radius, and scattered into its tiles — N round-trips become ~1.
        if !gather_groups.is_empty() {
            self.atlas_gather(&schedule.gather_plan, &gather_groups, backend, device, queue, &mut frame_enc, root, full_view, format);
            if !safe {
                Self::submit_batch(&mut frame_enc, device, queue, backend);
            }
        }
        // Held finalize composites now fold each tile — including the scattered blur — to the swapchain.
        for &i in &finalize {
            if let Step::Composite { from, to, paint, rect, .. } = &schedule.steps[i] {
                crate::prof::inc_composite();
                self.composite(*from, *to, *paint, *rect, device, &mut frame_enc, &sw_view, full_view, width, height, format);
            }
        }

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
            self.blit_tile(device, &mut frame_enc, &sw_view, t, &view, full_view, width, height);
            self.tile_cache.touch(t);
            reused += 1;
        }
        // Machine-readable proof of reuse (rendered, reused), read via `_last_tile_stats`.
        // DEBUG: draw the captured gather atlas over the finished frame, 1:1 at the top-left, so the
        // batched path's intermediates can be inspected directly. Must come after the finalize
        // composites, which would otherwise paint over it.
        if let Some((view, aw, ah)) = self.dbg_atlas.take() {
            self.compositor.blit(device, &mut frame_enc, &sw_view, (width as f32, height as f32), &Blit {
                src: &view,
                dst: (0.0, 0.0, aw as f32, ah as f32),
                src_rect: (0.0, 0.0, aw as f32, ah as f32),
                src_size: (aw as f32, ah as f32),
                alpha: 1.0,
            });
        }
        crate::abi::set_tile_stats(u32::try_from(dirty.len()).unwrap_or(u32::MAX), reused);

        // The frame's single submission — everything above only *recorded* into `frame_enc`.
        let _tsu = crate::prof::now();
        crate::prof::inc_submit();
        queue.submit([frame_enc.finish()]);
        crate::prof::add_submit(crate::prof::now() - _tsu);
        // Only now is it safe for a backend to recycle what this frame retired.
        backend.after_submit();

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
        already: &HashSet<usize>,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        root: Affine,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) -> HashSet<usize> {
        const ATLAS_MIN: usize = 3;
        let none = HashSet::new();


        // The first Paint into each surface (render-core's SSA-order primitive), kept only for the
        // `TILE_BUFFER`-sized plain bodies: a tile output or a group's scope buffer (a scope's first
        // paint is the container background + its plain children; effect children arrive later as
        // composites). Both pack the same fixed-cell atlas. A first-paint already consumed by the
        // tile-fuse (its tile drew all its bodies inline) is skipped.
        let mut candidates: Vec<(usize, SurfaceRef, Vec<PaintOp>)> = Vec::new();
        for i in first_write_paints(steps) {
            if already.contains(&i) {
                continue;
            }
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
        backend.rasterize(&scene, device, queue, enc, &atlas_view, aw, ah, CLEAR);
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
        enc: &mut wgpu::CommandEncoder,
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
        crate::prof::dbg_set(0, cands.len() as f64); // TEMP: atlas_effects candidate count
        if cands.len() < ATLAS_MIN {
            return none;
        }

        // Shelf-pack the variable-sized cells with a gap (backend-neutral geometry); the gap keeps
        // each cell's blur inside its own bounds so it can't bleed into a neighbour.
        let sizes: Vec<(u32, u32)> = cands.iter().map(|c| (c.3, c.4)).collect();
        crate::prof::dbg_set(1, sizes.iter().map(|s| u64::from(s.0)).max().unwrap_or(0) as f64); // TEMP: widest cell
        crate::prof::dbg_set(2, sizes.iter().map(|s| u64::from(s.1)).max().unwrap_or(0) as f64); // TEMP: tallest cell
        let Some(packing) = shelf_pack(&sizes, GAP, 2048, max_dim) else {
            crate::prof::dbg_set(3, 1.0); // TEMP: shelf_pack declined
            return none;
        };
        crate::prof::dbg_set(4, packing.height as f64); // TEMP: atlas height
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

        backend.rasterize(&scene, device, queue, enc, &atlas_view, atlas_w, atlas_h, CLEAR);
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
        crate::prof::add_submit(crate::prof::now() - _tsu);
        self.frame_transient.push(atlas);

        cands.iter().map(|(i, _, _, _, _, _, _)| *i).collect()
    }

    /// The tile-fuse: render a whole tile — its plain bodies **and** its spread effect surfaces inlined
    /// as images — as ONE scene, so an effect composite no longer splits the tile's plain run into a
    /// fresh rasterize each. This is the Skia-style single-scene-per-tile: instead of `paint · composite
    /// spread · paint · …` (a rasterize per segment), one cell draws `body · image(spread) · body · …`
    /// in z-order, and the fixed-cell atlas batches many such tiles into one render.
    ///
    /// Only for backends that can [inline images](RasterBackend::inline_images_supported) (classic).
    /// A tile qualifies only if every step touching it is a plain `Paint` or a spread `Composite`
    /// (`RasterEffectOutput → TileOutput`) whose source surface is already rendered — any gather, scope,
    /// or layer touching the tile disqualifies it, and it falls back to the unchanged per-step path.
    /// Returns the handled step indices (all consumed paints + spread composites).
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn atlas_fuse<B: RasterBackend>(
        &mut self,
        steps: &[Step],
        batched_gathers: &HashMap<u128, usize>,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        root: Affine,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) -> HashSet<usize> {
        let none = HashSet::new();
        if !backend.inline_images_supported() {
            return none;
        }

        // One entry per tile-touching step, in schedule (z) order.
        enum Op {
            Plain(usize, Vec<PaintOp>, Rect),
            Spread(usize, SurfaceRef, Rect, f32),
        }
        let mut per_tile: std::collections::HashMap<TileKey, Vec<Op>> = std::collections::HashMap::new();
        let mut order: Vec<TileKey> = Vec::new();
        let mut disq: HashSet<TileKey> = HashSet::new();

        for (i, step) in steps.iter().enumerate() {
            match step {
                Step::Paint { ops, clip, write_to } => {
                    if matches!(write_to.role, SurfaceRole::TileOutput) {
                        if let Some(t) = write_to.tile {
                            if !per_tile.contains_key(&t) {
                                order.push(t);
                            }
                            per_tile.entry(t).or_default().push(Op::Plain(i, ops.clone(), *clip));
                        }
                    }
                }
                Step::Composite { from, to, paint, rect, .. } => match to.role {
                    SurfaceRole::TileOutput => {
                        if let Some(t) = to.tile {
                            if matches!(from.role, SurfaceRole::RasterEffectOutput(_))
                                && self.surfaces.contains_key(from)
                            {
                                if !per_tile.contains_key(&t) {
                                    order.push(t);
                                }
                                per_tile.entry(t).or_default()
                                    .push(Op::Spread(i, *from, *rect, paint.opacity));
                            } else {
                                // scope fold, or a spread whose surface isn't pre-rendered → fall back.
                                disq.insert(t);
                            }
                        }
                    }
                    _ => {} // → Target (finalize): left to the main loop.
                },
                // A gather handed to the end-of-frame batch neither reads nor writes its tiles during
                // the walk, and the deferral rule already guarantees nothing is painted over its
                // output — so the tile's bodies still fuse into one render and the blur lands on top
                // afterwards. This is what stops a screenful of lenses from shattering the fuse into
                // one rasterize per run of shapes between them.
                Step::ComposeBackdrop { shape, .. } | Step::PaintGather { shape, .. }
                    if batched_gathers.contains_key(shape) => {}
                // Anything else involving a gather / snapshot / layer disqualifies every tile it uses.
                Step::ComposeBackdrop { .. }
                | Step::PaintGather { .. }
                | Step::Snapshot { .. }
                | Step::BeginLayer { .. }
                | Step::EndLayer { .. } => {
                    for r in step.reads().into_iter().chain(step.writes()) {
                        if let Some(t) = r.tile {
                            disq.insert(t);
                        }
                    }
                }
                _ => {}
            }
        }

        // Keep only tiles that survived and actually carry a spread (a plain-only tile stays on the
        // cheaper first-write atlas prepass).
        let fused_tiles: Vec<TileKey> = order
            .into_iter()
            .filter(|t| !disq.contains(t))
            .filter(|t| per_tile[t].iter().any(|op| matches!(op, Op::Spread(..))))
            .collect();
        if fused_tiles.is_empty() {
            return none;
        }

        let max_dim = device.limits().max_texture_dimension_2d;
        let Some(packing) = pack_grid(fused_tiles.len(), TILE_BUFFER, max_dim) else {
            return none;
        };
        let (aw, ah) = (packing.width, packing.height);

        // Register every spread surface these tiles inline, once, for the whole atlas render.
        let mut handles: std::collections::HashMap<SurfaceRef, u64> = std::collections::HashMap::new();
        for t in &fused_tiles {
            for op in &per_tile[t] {
                if let Op::Spread(_, from, _, _) = op {
                    if !handles.contains_key(from) {
                        let tex = self.surfaces[from].texture.clone();
                        handles.insert(*from, backend.register_inline_image(&tex));
                    }
                }
            }
        }

        // One scene: each fused tile's ordered bodies + inlined spread surfaces drawn into its cell.
        let m = f64::from(TILE_MARGIN);
        let mut scene = backend.new_scene(aw as u16, ah as u16);
        for cell in &packing.cells {
            let t = fused_tiles[cell.index];
            let (ox, oy) = tiling::tile_device_origin(t, full_view);
            let root_for_cell = Affine::translate((f64::from(cell.x) + m - ox, f64::from(cell.y) + m - oy)) * root;
            let cell_rect = Rect::new(
                f64::from(cell.x),
                f64::from(cell.y),
                f64::from(cell.x) + f64::from(TILE_BUFFER),
                f64::from(cell.y) + f64::from(TILE_BUFFER),
            );
            for op in &per_tile[&t] {
                match op {
                    Op::Plain(_, ops, _) => {
                        backend.build_bodies_clipped(&mut scene, root_for_cell, ops, cell_rect);
                    }
                    Op::Spread(_, from, rect, alpha) => {
                        let (dx, dy, dw, dh) = tiling::device_rect(full_view, *rect);
                        let x0 = f64::from(cell.x) + (dx - ox + m);
                        let y0 = f64::from(cell.y) + (dy - oy + m);
                        let handle = handles[from];
                        backend.draw_inline_image(&mut scene, handle, Rect::new(x0, y0, x0 + dw, y0 + dh), *alpha);
                    }
                }
            }
        }

        let atlas_usage = self.raster_usage | wgpu::TextureUsages::COPY_SRC;
        let atlas = self.pool.acquire(
            device,
            PoolKey { w: aw, h: ah, format, usage: atlas_usage.bits() },
            "fuse atlas",
        );
        let atlas_view = atlas.create_view(&wgpu::TextureViewDescriptor::default());
        backend.rasterize(&scene, device, queue, enc, &atlas_view, aw, ah, CLEAR);

        // Copy each cell into its tile output, and mark it written so the finalize composite reads it.
        for cell in &packing.cells {
            let t = fused_tiles[cell.index];
            let write_to = SurfaceRef::tile_ref(SurfaceRole::TileOutput, t);
            self.ensure_surface(write_to, device, TILE_BUFFER, TILE_BUFFER, format);
            enc.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &atlas,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: cell.x, y: cell.y, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyTextureInfo {
                    texture: &self.surfaces[&write_to].texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: 0, y: 0, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d { width: TILE_BUFFER, height: TILE_BUFFER, depth_or_array_layers: 1 },
            );
            self.written.insert(write_to);
            crate::prof::inc_step();
        }
        self.frame_transient.push(atlas);

        // Release the registrations now that the atlas render is recorded.
        for (_, handle) in handles {
            backend.unregister_inline_image(handle);
        }

        // Every plain paint + spread composite we consumed is handled; the main loop skips them.
        let mut handled = HashSet::new();
        for t in &fused_tiles {
            for op in &per_tile[t] {
                match op {
                    Op::Plain(i, _, _) | Op::Spread(i, _, _, _) => {
                        handled.insert(*i);
                    }
                }
            }
        }
        handled
    }

    /// The batched background-blur gather stage — **the collapse**. Instead of a backdrop-compose +
    /// blur pass *per* deferrable blur lens (a GPU round-trip each, the ~90 ms cost), it composes every
    /// lens's backdrop into one atlas, blurs the atlas **once** per radius group, rasterizes every
    /// silhouette into one mask atlas (one `backend.rasterize`), and scatters each cell through its mask
    /// into the lens's tiles. So N lenses cost ~1 blur-graph run + 1 mask render instead of N of each.
    ///
    /// Runs after the main loop has painted all non-deferred content, so recomposing each backdrop from
    /// the finished `TileOutput`s is pixel-identical to reading it at the lens's z — the sample-rect
    /// deferrability rule (see render-core's `gather_plan`) guarantees nothing above ever touched it.
    /// `groups` are the pre-filtered [`GatherPlan::deferrable_blur_groups`] the main loop skipped.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn atlas_gather<B: RasterBackend>(
        &mut self,
        plan: &GatherPlan,
        groups: &[Vec<usize>],
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        root: Affine,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) {
        // A gap between cells so no cell's kernel taps reach a neighbour. Each cell already carries its
        // `reach` (3σ) padding — the sample rect — so the silhouette region samples only within its own
        // cell; the gap just keeps the discarded padding fringe from touching the next cell.
        const GAP: u32 = 8;
        let max_dim = device.limits().max_texture_dimension_2d;
        let bg = crate::abi::background().components;
        let bgc = [f64::from(bg[0]), f64::from(bg[1]), f64::from(bg[2]), f64::from(bg[3])];

        // One (device backdrop rect, cap factor, cell size) per gather in the group.
        struct Cell {
            gi: usize,
            bdx: f64,
            bdy: f64,
            dw: f64,
            dh: f64,
            k: f64,
            w: u32,
            h: u32,
        }
        for group in groups {
            let mut cells: Vec<Cell> = Vec::with_capacity(group.len());
            for &gi in group {
                let g = &plan.gathers[gi];
                let (bdx, bdy, dw, dh) = tiling::device_rect(full_view, g.sample);
                let k = tiling::resolution_cap(full_view, g.reach);
                let w = ((dw * k).ceil() as u32).clamp(1, 4096);
                let h = ((dh * k).ceil() as u32).clamp(1, 4096);
                if w > max_dim || h > max_dim {
                    continue;
                }
                cells.push(Cell { gi, bdx, bdy, dw, dh, k, w, h });
            }
            if cells.is_empty() {
                continue;
            }
            let sizes: Vec<(u32, u32)> = cells.iter().map(|c| (c.w, c.h)).collect();
            let Some(packing) = shelf_pack(&sizes, GAP, 2048, max_dim) else { continue };
            let (aw, ah) = (packing.width, packing.height);

            // (1) Backdrop atlas: compose each lens's backdrop into its cell (the same tile-centre blits
            // `compose_backdrop` does, offset to the cell). Needs to be a render target *and* a sampled
            // input for the blur.
            let bd_usage =
                wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC;
            let bd_atlas = self.pool.acquire(device, PoolKey { w: aw, h: ah, format, usage: bd_usage.bits() }, "gather backdrop atlas");
            let bd_view = bd_atlas.create_view(&wgpu::TextureViewDescriptor::default());
            Compositor::clear(enc, &bd_view, bgc);
            let m = f64::from(TILE_MARGIN);
            let stages = crate::abi::gather_stages();
            for cell in &packing.cells {
                if stages & 1 == 0 {
                    break;
                }
                let c = &cells[cell.index];
                for &tile in &plan.gathers[c.gi].reads {
                    let src_ref = SurfaceRef::tile_ref(SurfaceRole::TileOutput, tile);
                    // A frozen copy if this gather took one for this tile (something above was going to
                    // overwrite what it read), otherwise the live or cached tile.
                    let frozen = self
                        .snapshot_of
                        .get(&(c.gi, tile))
                        .and_then(|k| self.snapshots.view(*k))
                        .cloned();
                    let Some(src_view) = frozen.or_else(|| self.backdrop_source(&src_ref)) else { continue };
                    let (ox, oy) = tiling::tile_device_origin(tile, full_view);
                    // Clip the tile to *this* lens's backdrop rect. Unlike `compose_backdrop`, whose
                    // target is the lens's own surface and so clips the overhang for free, the atlas
                    // is shared: an unclipped tile blit runs past its cell and paints the neighbour's,
                    // which makes that lens blur another region of the page.
                    let Some((ix0, iy0, iw, ih)) = tiling::tile_clip_device(tile, full_view, (c.bdx, c.bdy, c.dw, c.dh))
                    else {
                        continue;
                    };
                    self.compositor.blit(device, enc, &bd_view, (aw as f32, ah as f32), &Blit {
                        src: &src_view,
                        dst: (
                            cell.x as f32 + ((ix0 - c.bdx) * c.k) as f32,
                            cell.y as f32 + ((iy0 - c.bdy) * c.k) as f32,
                            (iw * c.k) as f32,
                            (ih * c.k) as f32,
                        ),
                        src_rect: ((m + ix0 - ox) as f32, (m + iy0 - oy) as f32, iw as f32, ih as f32),
                        src_size: (TILE_BUFFER as f32, TILE_BUFFER as f32),
                        alpha: 1.0,
                    });
                }
            }

            if crate::abi::debug_atlas() == 1 {
                self.dbg_atlas = Some((bd_view.clone(), aw, ah));
            }
            // The blur graph submits its own encoder, so the backdrop-atlas blits (recorded into `enc`,
            // along with the tile writes they read) must be flushed first or the blur reads stale
            // pixels — the same flush the inline gather path gets from crossing a submit batch.
            Self::submit_batch(enc, device, queue, backend);

            // (2) Blur the whole atlas ONCE. Every cell in the group shares σ (same radius, same cap),
            // so one separable Gaussian over the atlas blurs them all; padding keeps cells independent.
            let sigma = self.gather_sigma(plan.gathers[cells[0].gi].shape, full_view, cells[0].k);
            let passes = if stages & 2 == 0 { Vec::new() } else { lower_graph(&effect_graph::background_blur_graph(sigma), None) };
            let Some((blur_atlas, blur_view)) =
                run_graph(&self.compositor, &self.glass, device, queue, &[&bd_view], &passes, aw, ah, format)
            else {
                self.frame_transient.push(bd_atlas);
                continue;
            };

            if crate::abi::debug_atlas() == 2 {
                self.dbg_atlas = Some((blur_view.clone(), aw, ah));
            }
            // (3) Mask atlas: every lens's silhouette rasterized into its cell in ONE pass.
            let mask_atlas = new_target_with_usage(device, aw, ah, format, self.raster_usage);
            let mask_view = mask_atlas.create_view(&wgpu::TextureViewDescriptor::default());
            let mut mscene = backend.new_scene(aw as u16, ah as u16);
            for cell in &packing.cells {
                let c = &cells[cell.index];
                // Full-zoom device → shifted to the backdrop origin → scaled by cap k → offset to cell,
                // matching how the backdrop tiles mapped in (so mask and blur align in the cell).
                let root_for_cell = Affine::translate((f64::from(cell.x), f64::from(cell.y)))
                    * Affine::scale(c.k)
                    * Affine::translate((-c.bdx, -c.bdy))
                    * root;
                backend.build_mask(&mut mscene, root_for_cell, plan.gathers[c.gi].shape);
            }
            if stages & 4 != 0 {
                backend.rasterize(&mscene, device, queue, enc, &mask_view, aw, ah, CLEAR);
            }

            if crate::abi::debug_atlas() == 3 {
                self.dbg_atlas = Some((mask_view.clone(), aw, ah));
            }
            // (4) Scatter: masked-blit each blurred cell through its mask cell into the lens's tiles.
            for cell in &packing.cells {
                if stages & 8 == 0 {
                    break;
                }
                let c = &cells[cell.index];
                let g = &plan.gathers[c.gi];
                for &tile in &g.writes {
                    let (ox, oy) = tiling::tile_device_origin(tile, full_view);
                    let (sdx, sdy, sdw, sdh) = tiling::device_rect(full_view, g.output);
                    let tsz = f64::from(TILE_SIZE);
                    let ix0 = sdx.max(ox);
                    let iy0 = sdy.max(oy);
                    let ix1 = (sdx + sdw).min(ox + tsz);
                    let iy1 = (sdy + sdh).min(oy + tsz);
                    if ix1 <= ix0 || iy1 <= iy0 {
                        continue;
                    }
                    let write_to = SurfaceRef::tile_ref(SurfaceRole::TileOutput, tile);
                    self.ensure_surface(write_to, device, TILE_BUFFER, TILE_BUFFER, format);
                    let to_view = self.surfaces[&write_to].view.clone();
                    if self.written.insert(write_to) {
                        Compositor::clear(enc, &to_view, [0.0, 0.0, 0.0, 0.0]);
                    }
                    let mf = f64::from(TILE_MARGIN);
                    let buf = (TILE_BUFFER as f32, TILE_BUFFER as f32);
                    let dst = ((ix0 - ox + mf) as f32, (iy0 - oy + mf) as f32, (ix1 - ix0) as f32, (iy1 - iy0) as f32);
                    // Source rect inside the atlas cell: the shape sub-rect in reduced (×k) texels,
                    // offset to the cell origin. `blit_masked` samples blur and mask at the same rect.
                    let src_rect = (
                        cell.x as f32 + ((ix0 - c.bdx) * c.k) as f32,
                        cell.y as f32 + ((iy0 - c.bdy) * c.k) as f32,
                        ((ix1 - ix0) * c.k) as f32,
                        ((iy1 - iy0) * c.k) as f32,
                    );
                    let src_size = (aw as f32, ah as f32);
                    self.compositor.blit_masked(device, enc, &to_view, buf, &MaskedBlit {
                        src: &blur_view,
                        mask: &mask_view,
                        dst,
                        src_rect,
                        src_size,
                        alpha: 1.0,
                    });
                }
            }
            self.frame_transient.push(bd_atlas);
            self.frame_transient.push(blur_atlas);
            self.frame_transient.push(mask_atlas);
        }
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

    /// Freeze the backdrop of one batched gather at its own z-position, for the batch to read at end
    /// of frame.
    ///
    /// Only tiles with a **live** surface are copied. A tile the frame is not re-rendering cannot
    /// change between here and the batch, so its cached pixels are already a valid freeze and
    /// [`Self::backdrop_source`] will serve them directly — the copy is only needed where this frame
    /// is still going to paint over what the gather read.
    fn freeze_backdrop(
        &mut self,
        gi: usize,
        read_from: &[SurfaceRef],
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
    ) {
        let live: Vec<(TileKey, wgpu::Texture)> = read_from
            .iter()
            .filter_map(|r| Some((r.tile?, self.surfaces.get(r)?.texture.clone())))
            .collect();
        for (tile, texture) in live {
            let key = self.snapshots.capture(tile, &texture, device, &mut self.pool, enc);
            self.snapshot_of.insert((gi, tile), key);
        }
    }

    /// The pixels to read for one backdrop source tile: this frame's live surface if the tile is being
    /// re-rendered, otherwise the tile cache's copy.
    ///
    /// A gather's sample rect routinely reaches into tiles the frame is not touching. Their content is
    /// unchanged and already on the GPU, so serving it from the cache is what lets an edit next to a
    /// lens repaint only what actually changed instead of every tile the lens happens to read.
    fn backdrop_source(&self, src_ref: &SurfaceRef) -> Option<wgpu::TextureView> {
        if let Some(s) = self.surfaces.get(src_ref) {
            return Some(s.view.clone());
        }
        // Only a plain tile output has a cached counterpart; a scope/effect surface is frame-local.
        if !matches!(src_ref.role, SurfaceRole::TileOutput) {
            return None;
        }
        self.tile_cache.get(src_ref.tile?).map(|s| s.view.clone())
    }

    fn ensure_surface(&mut self, key: SurfaceRef, device: &wgpu::Device, w: u32, h: u32, format: wgpu::TextureFormat) {
        if self.surfaces.contains_key(&key) {
            return;
        }
        // Rendered into (the compositor always writes as an attachment; the backend's rasterize may
        // need more, e.g. classic's storage binding), sampled when composited, a copy target when the
        // atlas prepass populates a tile from its atlas cell, and a copy *source* so an effect surface
        // can be `register_texture`'d and inlined by the tile-fuse (`register_texture` requires COPY_SRC).
        let usage = wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_DST
            | wgpu::TextureUsages::COPY_SRC
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
        enc: &mut wgpu::CommandEncoder,
        format: wgpu::TextureFormat,
    ) {
        if first {
            backend.rasterize(scene, device, queue, enc, target, w, h, CLEAR);
            return;
        }
        // Rasterized into, then sampled by the compositor blit.
        let usage = self.raster_usage | wgpu::TextureUsages::TEXTURE_BINDING;
        let scratch =
            self.pool.acquire(device, PoolKey { w, h, format, usage: usage.bits() }, "sink accumulate scratch");
        let scratch_view = scratch.create_view(&wgpu::TextureViewDescriptor::default());
        backend.rasterize(scene, device, queue, enc, &scratch_view, w, h, CLEAR);
        self.compositor.blit(
            device,
            enc,
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
        enc: &mut wgpu::CommandEncoder,
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
        self.rasterize_accumulate(backend, &scene, &view, w, h, first, device, queue, enc, format);
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

    /// Submit `frame_enc` and swap in a fresh encoder in its place, then let the backend reclaim what
    /// the submitted batch retired. The single point every batch boundary goes through.
    fn submit_batch<B: RasterBackend>(
        frame_enc: &mut wgpu::CommandEncoder,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        backend: &mut B,
    ) {
        let fresh = device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sink batch") });
        let done = std::mem::replace(frame_enc, fresh);
        let _tsu = crate::prof::now();
        crate::prof::inc_submit();
        queue.submit([done.finish()]);
        crate::prof::add_submit(crate::prof::now() - _tsu);
        backend.after_submit();
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
        enc: &mut wgpu::CommandEncoder,
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
        let bg = crate::abi::background().components;
        Compositor::clear(
            enc,
            &bd_view,
            [f64::from(bg[0]), f64::from(bg[1]), f64::from(bg[2]), f64::from(bg[3])],
        );
        let m = TILE_MARGIN as f32;
        let ts = TILE_SIZE as f32;
        let kf = k as f32;
        for src_ref in read_from {
            let Some(tile) = src_ref.tile else { continue };
            let Some(src_view) = self.backdrop_source(src_ref) else { continue };
            let (ox, oy) = tiling::tile_device_origin(tile, full_view);
            // The tile's full-zoom centre → its place in the reduced backdrop (down-sampled by `k`).
            self.compositor.blit(
                device,
                enc,
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
        enc: &mut wgpu::CommandEncoder,
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
            // `run_graph` submits its own encoder, so the `compose_backdrop` blits that filled this
            // backdrop (recorded into `enc`) must be flushed first — otherwise the blur reads stale
            // pixels (a recycled backdrop texture holding the pre-edit frame). The batched atlas path
            // does the identical flush; the inline path must not rely on a submit-batch boundary
            // happening to fall between the compose and the gather (at the default batch of 32 it does
            // not, and the gather freezes on incremental edits).
            Self::submit_batch(enc, device, queue, backend);
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
                // The mask is filled via `backend.rasterize` (classic writes it from a compute shader),
                // so it needs the backend's rasterize usage — `STORAGE_BINDING` on classic. Without it
                // the compute bind group is invalid and the whole blur is dropped.
                let mask = new_target_with_usage(device, bw, bh, format, self.raster_usage);
                let mask_view = mask.create_view(&wgpu::TextureViewDescriptor::default());
                // Render the silhouette into the reduced backdrop the same way the tiles mapped in:
                // full-zoom device → shifted to the backdrop origin → scaled down by `k`.
                let root_for_mask = Affine::scale(k) * Affine::translate((-bdx, -bdy)) * root;
                let mut mscene = backend.new_scene(bw as u16, bh as u16);
                backend.build_mask(&mut mscene, root_for_mask, id);
                backend.rasterize(&mscene, device, queue, enc, &mask_view, bw, bh, CLEAR);
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
        if self.written.insert(write_to) {
            Compositor::clear(enc, &to_view, [0.0, 0.0, 0.0, 0.0]);
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
            self.compositor.blit(device, enc, &to_view, buf, &Blit { src: &result_view, dst, src_rect, src_size, alpha: 1.0 });
        } else {
            let mask_view = self.surfaces[&mask_ref].view.clone();
            self.compositor.blit_masked(device, enc, &to_view, buf, &MaskedBlit { src: &result_view, mask: &mask_view, dst, src_rect, src_size, alpha: 1.0 });
        }
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
