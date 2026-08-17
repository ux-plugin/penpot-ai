//! The GPU production sink — executes a `crate::schedule::Schedule` on the Vello backend.
//!
//! render-core builds the neutral schedule (which surface each shape paints into, how surfaces
//! compose, in z-order). This sink is the backend half: it maps each logical `SurfaceRef` to a GPU
//! texture, runs each step, and presents the result on the swapchain.
//!
//! - `Paint` → render one node's body (via the `PAINT_ONLY`-scoped scene render) into the target
//!   surface; the first write to a surface clears, later writes `render_load` (so a tile's output
//!   accumulates many shapes + composited effect surfaces in z-order).
//! - `Composite` → a `SrcOver` blit ([`crate::vello::blend`]) of one surface into another (or the
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

use crate::atlas::{pack_grid, shelf_pack};
use crate::model::TileMode;
use crate::peniko::color::palette::css::TRANSPARENT;
use crate::peniko::Color;
use crate::effect::{Compose, Source};
use crate::schedule::{
    first_write_paints, GatherPlan, LayerPaint, PaintOp, Schedule, Step, SurfaceRef, SurfaceRole,
};
use crate::tile_cache::TileCache;
use crate::tiling::{self, TileKey, TILE_BUFFER, TILE_MARGIN, TILE_SIZE};
use crate::vello::rasterize::RasterBackend;
use vello_common::kurbo::{Affine, Rect, Shape};
// DEBUG bisection: `atlas_fuse`'s single-clip path drives the scene's `RenderingContext` clip directly.
use vello_example_scenes::RenderingContext;

use crate::vello::blend::{BlendComposite, Blit, Compositor, MaskedBlit};
use crate::vello::glass::GlassPipeline;
use crate::effect_graph::{self, GlassGeometry};

use crate::vello::graph::{build_custom_pipeline, lower_graph, new_target_with_usage, run_graph, run_graph_into, Pass};

/// Every sink surface is composited with `SrcOver`, so a first write clears to full transparency —
/// the neutral `base_color` the backend rasterizes against.
const CLEAR: Color = TRANSPARENT;

/// The **`acceptable_downscale`** of a solid-coverage blur (a shadow silhouette or a layer-blurred body)
/// of the given DEVICE sigma — the *downscale* input, NOT the final scale. A Gaussian is low-pass, so it
/// can render at its band limit `2/3σ` (mirroring `builder::blur_policy_downscale`) and upscale on the
/// composite; floored at 0.5 so the bilinear upscale never over-softens, `1.0` for a near-sharp blur.
/// Safe for solid coverage (no sharp detail to alias — unlike a gather's backdrop, where the policy is
/// off). This is only the *downscale*; the caller still combines it with the memory *limit*
/// (`tiling::resolution_cap`) via `min` to get the render scale `k`, exactly like the gather path.
/// The device-pixel box a page-space effect rect occupies, snapped outward to whole pixels and
/// clamped to the viewport. `None` when it lands fully off-screen (nothing to render).
///
/// This is what lets a whole-viewport effect pass be **extent-cropped**: instead of rasterizing and
/// blurring a shape's silhouette across the entire viewport (which a ~500px shape on a 4K screen does
/// at ~20× the necessary pixels), the pass runs in a surface the size of this box and composites back
/// at its origin. Mirrors the tiled path's `device_rect` + the gather path's scoped bbox.
fn wv_device_box(page: crate::kurbo::Rect, full_view: Affine, width: u32, height: u32) -> Option<(u32, u32, u32, u32)> {
    use crate::kurbo::Point;
    let pts = [
        full_view * Point::new(page.x0, page.y0),
        full_view * Point::new(page.x1, page.y0),
        full_view * Point::new(page.x0, page.y1),
        full_view * Point::new(page.x1, page.y1),
    ];
    let bx = pts.iter().map(|p| p.x).fold(f64::INFINITY, f64::min).floor().clamp(0.0, f64::from(width)) as u32;
    let by = pts.iter().map(|p| p.y).fold(f64::INFINITY, f64::min).floor().clamp(0.0, f64::from(height)) as u32;
    let ex = pts.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max).ceil().clamp(0.0, f64::from(width)) as u32;
    let ey = pts.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max).ceil().clamp(0.0, f64::from(height)) as u32;
    let (bw, bh) = (ex.saturating_sub(bx), ey.saturating_sub(by));
    (bw > 0 && bh > 0).then_some((bx, by, bw, bh))
}

fn blur_acceptable_downscale(device_sigma: f32) -> f32 {
    if device_sigma <= f32::EPSILON {
        return 1.0;
    }
    // Keep at least ~2px of sigma AT THE REDUCED RESOLUTION: `sigma·k >= 2`, so `k >= 2/sigma`.
    //
    // Deriving this from the 3-sigma *reach* instead saturates — `2/(3·sigma)` is already below the
    // 0.5 floor for any sigma over 1.33, so every blur got halved, a radius-4 the same as a
    // radius-24. That is fine for a wide blur, whose own softness hides the coarser grid, but a
    // narrow one leaves the shape's half-resolution silhouette visible at the edge. Sigma is the
    // right scale to measure against: it is what says how much detail the blur actually destroys.
    (2.0 / device_sigma).clamp(0.5, 1.0)
}

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

}

/// Effect-node kinds the whole-viewport driver dispatches on. `FX_GATHER` is a pure gather (its body
/// stays in the shared walk); `FX_STACK` carries a non-box shadow, a layer blur or a spread shader, so
/// its body is excluded from the walk and its whole ordered stack runs at the boundary.
const FX_GATHER: u8 = 0;
const FX_STACK: u8 = 1;

/// One whole-viewport effect surface, resolved to geometry: which node/kind it belongs to, the device
/// crop box it covers, the render scale `k`, the surface size at that scale, and its device sigma.
#[derive(Clone, Copy)]
struct WvCell {
    key: (u128, u8, usize),
    bx: u32,
    by: u32,
    bw: u32,
    bh: u32,
    kw: u32,
    kh: u32,
    k: f32,
    sigma: f32,
}

/// Per-key free list buckets are capped so a burst of one-off sizes can't grow the pool without bound.
const MAX_POOL_PER_KEY: usize = 32;

/// A free-list of reusable GPU textures keyed by [`PoolKey`]. Fed at frame boundaries (drained before
/// this frame renders), on tile eviction/replacement, AND — for the whole-viewport effect path — at
/// each effect-node boundary MID-frame (see [`Sink::recycle_node_transient`]), so a node's scratch is
/// reused by the next node instead of every node's intermediates staying resident until the one submit.
/// Handing a texture back out as a fresh render target needs no extra synchronisation: a target is
/// always fully overwritten (its render pass clears or the effect graph writes every texel), and wgpu's
/// automatic hazard tracking serialises the write-after-read against any still-pending prior use —
/// in-encoder for the collapsed path, cross-submit on the same queue for the per-segment path.
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
            crate::vello::prof::add_pool_hit();
            return t;
        }
        crate::vello::prof::add_pool_miss();
        let _tt = crate::vello::prof::now();
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
        crate::vello::prof::add_tex(crate::vello::prof::now() - _tt);
        tex
    }

    /// Pooled drop-in for [`crate::vello::graph::new_target_with_usage`]: a `RENDER_ATTACHMENT |
    /// TEXTURE_BINDING | extra` target of `w×h`, reused from the free list when a matching one was
    /// released last frame. Used for the whole-viewport scratch and the effect-graph pass surfaces so
    /// they stop paying `create_texture` every frame.
    pub(crate) fn acquire_target(
        &mut self,
        device: &wgpu::Device,
        w: u32,
        h: u32,
        format: wgpu::TextureFormat,
        extra: wgpu::TextureUsages,
        label: &str,
    ) -> wgpu::Texture {
        let usage = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | extra;
        self.acquire(device, PoolKey { w, h, format, usage: usage.bits() }, label)
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
    /// Effect-graph scratch VIEWS that must outlive the frame's single submit (their textures ride in
    /// `frame_transient`). Only used by the folded whole-viewport gather path, where `run_graph_into`
    /// records into the frame encoder instead of self-submitting. Dropped (cleared) each frame.
    frame_transient_views: Vec<wgpu::TextureView>,

    /// Whole-viewport effect surfaces materialised by [`Self::wv_atlas_prepass`], keyed by
    /// `(node, kind, index)` — kind `0` a drop-shadow silhouette, `1` the node's isolated body.
    ///
    /// Every one of these used to be its own `backend.rasterize`, i.e. its own full vello front-end
    /// (~13 dispatches) for a handful of geometry. The prepass draws them all into ONE shelf-packed
    /// atlas with a single front-end and copies each cell out, so the per-surface cost collapses to a
    /// texture copy. Rebuilt every frame; drained into `frame_transient` when the frame ends.
    wv_atlas: HashMap<(u128, u8, usize), (wgpu::Texture, wgpu::TextureView)>,

    /// DEBUG: an atlas captured this frame (view, w, h) to blit over the swapchain so the batched
    /// gather's intermediates can be inspected. Selected by `abi::debug_atlas()`.
    dbg_atlas: Option<(wgpu::TextureView, u32, u32)>,

    /// Real GPU execution time for the frame, bracketed across every pass this sink records. `None`
    /// when the device lacks `TIMESTAMP_QUERY`. Built lazily on the first `execute` because the
    /// queue (needed for the tick period) is not available at construction.
    gpu_timer: Option<crate::vello::gputime::GpuTimer>,
    gpu_timer_tried: bool,

    /// Per-pass GPU timing for the effect graph (glass displacement/refraction/blur/composite), when
    /// `abi::prof_passes()` is set. Shares the lazy build with `gpu_timer`. Threaded into
    /// `run_graph_into` so each gather's passes are bracketed individually.
    pass_prof: Option<crate::vello::gputime::PassProfiler>,

    /// Present-on-demand retained canvas: the last composited whole-viewport frame, kept across frames
    /// (NOT pooled) so a frame where nothing changed can re-present it instead of re-rendering. Tuple
    /// is `(texture, view, width, height)`. `canvas_view` is the device view it was rendered at, so a
    /// pan/zoom (view change) invalidates it. Only used when `abi::present_on_demand()`.
    canvas: Option<(wgpu::Texture, wgpu::TextureView, u32, u32)>,
    canvas_view: Option<Affine>,

    /// The view the *previous* frame ran at, for zoom/pan-proxy settle detection: a frame whose view
    /// differs from this is "actively navigating" and gets a cheap transformed re-blit of the retained
    /// canvas; a frame whose view matches it has settled, so the real render runs and re-sharpens.
    last_view: Option<Affine>,

    /// A reusable `TILE_BUFFER²` scratch for the non-`SrcOver` `Composite` path: the target tile buffer
    /// is copied here so the blend shader can sample the destination it is about to overwrite (WebGL2
    /// forbids reading the live render target). Persists across frames (kept, not pooled); a run of
    /// consecutive blend composites in one encoder reuses it in order, which is safe because passes in
    /// an encoder execute in submission order. `(texture, format)` so a format change rebuilds it.
    blend_scratch: Option<(wgpu::Texture, wgpu::TextureFormat)>,
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
            frame_transient_views: Vec::new(),
            wv_atlas: HashMap::new(),
            dbg_atlas: None,
            gpu_timer: None,
            gpu_timer_tried: false,
            pass_prof: None,
            canvas: None,
            canvas_view: None,
            last_view: None,
            blend_scratch: None,
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
            let extra = crate::vello::abi::with_scene(|scene, _, modifiers| {
                crate::schedule::gather_dirty_expansion(scene, modifiers, full_view, dirty_rects)
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
        // Their paired effect-graph views (whole-viewport gather path) are just dropped — last frame's
        // submit has flushed, so the passes that referenced them are done.
        self.frame_transient_views.clear();
        // Frozen backdrops are frame-scoped like everything above, and released on the same "last
        // frame's submit has flushed" argument.
        self.written.clear();
        self.backdrop_origin.clear();
        self.backdrop_scale.clear();
        // TEMP gather-collapse projection (buckets 108-111): the analysis's verdict for this frame —
        // total gathers vs how many defer, the passes with the collapse applied vs `total` today, and
        // the batched dispatch count. Lets the bench show the projected reduction before the sink acts.
        let gp = &schedule.gather_plan;
        crate::vello::prof::dbg_set(8, gp.total() as f64);
        crate::vello::prof::dbg_set(9, gp.deferrable_count() as f64);
        crate::vello::prof::dbg_set(10, gp.estimated_passes() as f64);
        crate::vello::prof::dbg_set(11, gp.batched_dispatches() as f64);
        self.raster_usage = backend.rasterize_target_usage();
        let full_view = crate::vello::abi::effective_view(root);
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
        let batch = if safe { crate::vello::abi::sink_batch() } else { 1 };
        let mut frame_enc = device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sink batch") });

        if !self.gpu_timer_tried {
            self.gpu_timer_tried = true;
            self.gpu_timer = crate::vello::gputime::GpuTimer::new(device, queue);
        }
        // Claim this frame's ring slot before recording any pass, so `start_writes` below can stamp
        // into it. Leaves the frame untimed (no free slot) rather than stalling on a readback.
        if let Some(t) = self.gpu_timer.as_mut() {
            t.begin();
        }

        // The page background is not a scheduled node — clear the swapchain to it, then the
        // TileOutput→Target composites land on top. This is also the frame's first GPU pass, so it
        // carries the opening timestamp of the GPU span.
        let bg = crate::vello::abi::background().components;
        Compositor::clear(
            &mut frame_enc,
            &sw_view,
            [f64::from(bg[0]), f64::from(bg[1]), f64::from(bg[2]), f64::from(bg[3])],
            self.gpu_timer.as_ref().and_then(crate::vello::gputime::GpuTimer::start_writes),
        );

        // Batched gather collapse: the deferrable pure-lens blur groups worth batching (>= 2). Their
        // ComposeBackdrop/PaintGather steps are skipped below and run as one atlas after the loop; the
        // finalize composites (TileOutput→Target) are held until after that scatter lands in the tiles.
        let gather_groups: Vec<Vec<usize>> = if crate::vello::abi::gather_batch() {
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
        // The per-shape spread surfaces first: each blurred body is an independent render, so shelf-pack
        // them into one atlas (a gap between cells keeps each blur inside its own bounds). Doing this
        // before the fuse means those surfaces exist to be inlined.
        let mut atlased =
            self.atlas_effects(&schedule.steps, backend, device, queue, &mut frame_enc, root, full_view, format);
        crate::vello::prof::dbg_set(5, atlased.len() as f64);
        if !safe {
            Self::submit_batch(&mut frame_enc, device, queue, backend);
        }
        // Tile-fuse: a tile whose only effects are spreads draws its bodies AND those spread surfaces
        // (inlined as images) as one scene — collapsing the plain run an effect composite used to split
        // into a rasterize per segment. No-op on backends without inline images (hybrid). Consumes the
        // tile's paints + spread composites so the prepass and main loop skip them.
        let fused = if crate::vello::abi::no_fuse() {
            HashSet::new()
        } else {
            self.atlas_fuse(&schedule.steps, &batched_gathers, backend, device, queue, &mut frame_enc, root, full_view, format)
        };
        crate::vello::prof::dbg_set(6, fused.len() as f64);
        atlased.extend(fused);
        if !safe {
            Self::submit_batch(&mut frame_enc, device, queue, backend);
        }
        // Atlas prepass: the first `Paint` into each *remaining* (non-fused) `TileOutput`/`ScopeOf` is a
        // level-0 plain body, mutually independent — pack them into ONE render and copy each cell into
        // its tile. Returns the step indices it handled; the main loop skips them.
        let prepassed = self.atlas_prepass(&schedule.steps, &atlased, backend, device, queue, &mut frame_enc, root, full_view, format);
        crate::vello::prof::dbg_set(7, prepassed.len() as f64);
        atlased.extend(prepassed);
        if !safe {
            Self::submit_batch(&mut frame_enc, device, queue, backend);
        }
        // Diagnostic: schedule composition (12-14; 8-11 are the gather projection), so the bench can
        // attribute where renders come from.
        crate::vello::prof::dbg_set(12, schedule.steps.len() as f64);
        crate::vello::prof::dbg_set(13, schedule.steps.iter().filter(|s| matches!(s, Step::Paint { .. })).count() as f64);
        crate::vello::prof::dbg_set(14, schedule.steps.iter().filter(|s| matches!(s, Step::Composite { .. })).count() as f64);

        let mut finalize: Vec<usize> = Vec::new();

        let mut batched = 0_u32;
        for (i, step) in schedule.steps.iter().enumerate() {
            if atlased.contains(&i) {
                continue;
            }
            // Deferred to the batched gather stage — its backdrop is recomposed there from the finished
            // tiles. (A gather whose sample is disturbed by something above is excluded from the batch
            // by `batched_groups` and stays inline, so nothing needs freezing here.)
            if let Step::ComposeBackdrop { shape, .. } = step {
                if batched_gathers.contains_key(shape) {
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
                    crate::vello::prof::inc_paint();
                    self.paint(ops, *write_to, *clip, backend, device, queue, &mut frame_enc, root, full_view, format);
                }
                Step::Composite { from, to, paint, rect, .. } => {
                    crate::vello::prof::inc_composite();
                    let _tbl = crate::vello::prof::now();
                    self.composite(*from, *to, *paint, *rect, device, &mut frame_enc, &sw_view, full_view, width, height, format);
                    crate::vello::prof::add_blit(crate::vello::prof::now() - _tbl);
                }
                Step::ComposeBackdrop { read_from, extent, reach, always_cap, acceptable_downscale, tile_mode, write_to, .. } => {
                    crate::vello::prof::inc_gather();
                    self.compose_backdrop(read_from, *extent, *reach, *always_cap, f64::from(*acceptable_downscale), *tile_mode, *write_to, device, &mut frame_enc, full_view, format);
                }
                Step::PaintGather { backdrop, clip, write_to, .. } => {
                    crate::vello::prof::inc_gather();
                    self.paint_gather(*backdrop, *clip, *write_to, backend, device, queue, &mut frame_enc, root, full_view, format);
                }
                Step::Snapshot { from, write_to } => {
                    self.snapshot(*from, *write_to, device, &mut frame_enc);
                }
                Step::PaintPathShadow { shape, shadow, sigma, extent, write_to, .. } => {
                    self.paint_path_shadow(*shape, *shadow, *sigma, *extent, *write_to, backend, device, queue, &mut frame_enc, root, full_view, format);
                }
                Step::PaintInnerShadow { shape, shadow, sigma, extent, write_to, .. } => {
                    self.paint_inner_shadow(*shape, *shadow, *sigma, *extent, *write_to, backend, device, queue, &mut frame_enc, root, full_view, format);
                }
                // Layer brackets are not emitted by the builder yet.
                _ => {}
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
                crate::vello::prof::inc_composite();
                let _tbl = crate::vello::prof::now();
                self.composite(*from, *to, *paint, *rect, device, &mut frame_enc, &sw_view, full_view, width, height, format);
                crate::vello::prof::add_blit(crate::vello::prof::now() - _tbl);
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
        crate::vello::abi::set_tile_stats(u32::try_from(dirty.len()).unwrap_or(u32::MAX), reused);

        // Close the GPU span over everything recorded above and resolve it into the readback
        // buffer. Both have to land in this encoder, before the submit.
        if let Some(t) = self.gpu_timer.as_mut() {
            t.end(&mut frame_enc, &sw_view);
            t.resolve(&mut frame_enc);
        }

        // The frame's single submission — everything above only *recorded* into `frame_enc`.
        let _tsu = crate::vello::prof::now();
        crate::vello::prof::inc_submit();
        queue.submit([frame_enc.finish()]);
        crate::vello::prof::add_submit(crate::vello::prof::now() - _tsu);
        // Only now is it safe for a backend to recycle what this frame retired.
        backend.after_submit();
        if let Some(t) = self.gpu_timer.as_mut() {
            t.after_submit();
        }

        // Evict LRU beyond budget (never a visible tile) and recycle each evicted tile's texture — a
        // cached (thus prior-frame, flushed) surface, safe to reuse.
        for s in self.tile_cache.evict(&visible) {
            self.pool.release(s.texture);
        }
    }

    /// Whole-viewport render (vello-native compile): draw the ENTIRE document as one (or a few) vello
    /// scenes, bypassing the tile schedule / coalesce / atlas passes. No gather → ONE `render_full`
    /// (one setup). With gathers → phase at top-level gather roots: render the content *below* a gather
    /// into an accumulator, run the gather's effect graph on it, composite the lens, then keep drawing
    /// above — a few `render_full`s sharing the frame's one submit (the in-fine single-render fork is
    /// still deferred). Gated by `abi::whole_viewport()`. This is a NEW path; the tiled capped
    /// `paint_gather` is left intact for the incremental/cache case.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    pub fn render_whole_viewport<B: RasterBackend>(
        &mut self,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target: &wgpu::Texture,
        root: Affine,
        width: u32,
        height: u32,
        // Whether the host signalled a content edit since the last frame. Drained from the abi by the
        // caller (renderer.rs) so it stays the single consumer of the dirty state; present-on-demand
        // gates on this plus a view/dims change to decide whether a real render is needed at all.
        content_dirty: bool,
    ) {
        // vello writes an Rgba8Unorm storage texture; the compositor blit converts to the swapchain's
        // own format, exactly as the tiled path blits its Rgba8Unorm tiles onto the bgra swapchain.
        let format = wgpu::TextureFormat::Rgba8Unorm;
        self.raster_usage = backend.rasterize_target_usage();
        // Recycle last frame's scratch into the pool. This path bypasses `execute` (which drains for the
        // tiled path), so without this the whole-viewport scratch would never be released — a leak — and
        // the pool would have nothing to hand back. Last frame's submit has flushed, so reuse is safe.
        for tex in self.frame_transient.drain(..) {
            self.pool.release(tex);
        }
        self.frame_transient_views.clear();
        let full_view = crate::vello::abi::effective_view(root);
        let sz = (width as f32, height as f32);
        let sw_view = target.create_view(&wgpu::TextureViewDescriptor::default());

        // Present-on-demand: if nothing changed (no content edit signalled AND the view is unchanged
        // AND the target dims match the retained canvas), skip the entire render — including the
        // per-shape gather scan below — and just re-present the retained canvas. Falls through to a
        // normal render (and re-retains) when dirty or the canvas is empty.
        if crate::vello::abi::present_on_demand() {
            let view_changed = self.canvas_view != Some(full_view);
            let dims_changed = self.canvas.as_ref().is_none_or(|c| c.2 != width || c.3 != height);
            if !(content_dirty || view_changed || dims_changed) {
                if let Some((_, cv, _, _)) = self.canvas.as_ref() {
                    let cv = cv.clone();
                    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                        label: Some("wv present-on-demand"),
                    });
                    self.blit_full(&mut enc, device, &sw_view, &cv, sz);
                    crate::vello::prof::inc_submit();
                    queue.submit([enc.finish()]);
                    backend.after_submit();
                    crate::vello::prof::dbg_add(24, 1.0); // skipped-frame count (bench: skippedFrames)
                    self.last_view = Some(full_view);
                    return;
                }
            }
        }

        // Zoom/pan proxy: on a frame that is actively navigating (view differs from the previous frame)
        // and only the view changed (no content edit, dims match, a retained canvas exists), present a
        // cheap re-blit of that canvas transformed by the view delta instead of a full render. The sharp
        // render lands the frame the view settles (`moving` goes false). Pan/zoom are uniform (no
        // rotation), so `delta = full_view · canvas_view⁻¹` reduces to a scale+translate dst rect.
        if crate::vello::abi::present_on_demand() && crate::vello::abi::zoom_proxy() {
            let moving = self.last_view.is_some_and(|v| v != full_view);
            let dims_ok = self.canvas.as_ref().is_some_and(|c| c.2 == width && c.3 == height);
            if moving && !content_dirty && dims_ok {
                if let (Some((_, cv, _, _)), Some(cview)) = (self.canvas.as_ref(), self.canvas_view) {
                    let cv = cv.clone();
                    let d = (full_view * cview.inverse()).as_coeffs(); // [a,b,c,d,e,f]
                    let (a, dd, e, f) = (d[0] as f32, d[3] as f32, d[4] as f32, d[5] as f32);
                    let bg = crate::vello::abi::background().components;
                    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                        label: Some("wv zoom-proxy"),
                    });
                    // Clear first so the margin a zoom-out / pan exposes shows the page background, not
                    // stale swapchain content; then blit the retained canvas at its transformed rect.
                    Compositor::clear(&mut enc, &sw_view,
                        [f64::from(bg[0]), f64::from(bg[1]), f64::from(bg[2]), f64::from(bg[3])], None);
                    self.compositor.blit(device, &mut enc, &sw_view, sz, &Blit {
                        src: &cv,
                        dst: (e, f, a * width as f32, dd * height as f32),
                        src_rect: (0.0, 0.0, sz.0, sz.1),
                        src_size: sz,
                        alpha: 1.0,
                    });
                    crate::vello::prof::inc_submit();
                    queue.submit([enc.finish()]);
                    backend.after_submit();
                    crate::vello::prof::dbg_add(25, 1.0); // proxy-frame count (bench: proxyFrames)
                    self.last_view = Some(full_view);
                    return;
                }
            }
        }
        self.last_view = Some(full_view);

        // Top-level effect roots that force a segment boundary, in z-order. Two kinds, tagged by the
        // trailing `bool` (`true` = path drop shadow, `false` = gather): a GATHER (background blur /
        // glass / custom backdrop shader) reads the accumulator and stamps its lens back; a non-box
        // PATH drop shadow composites a blurred silhouette UNDER the body. Both split the frame at the
        // node's z so the effect runs between fine segments. (Name kept `gathers` for minimal churn.)
        // DIAG (bucket 26): scans every root (a `live.get(id)` HashMap lookup per root) — scales with
        // shape count, a suspect for the untimed `other` bucket.
        let _tgd = crate::vello::prof::now();
        // Two effect-node kinds. FX_GATHER = a PURE gather (background blur / glass / backdrop shader and
        // nothing else): it reads the accumulator, stamps its lens, and leaves its body in the shared walk
        // (drawn ABOVE the boundary, over the lens) — the verified stacked-gather path, untouched.
        // FX_STACK = any node carrying a non-box drop/inner shadow, a layer blur, or a body/spread custom
        // shader (optionally combined, and optionally also a gather): its body is EXCLUDED from the walk
        // and its whole effect stack runs at the boundary in z-order — drops → gather → body[+spread
        // +blur] → inner — so effects on one shape combine exactly as the tiled path already composes them
        // (`PaintPathShadow` → `custom_over_body`/`layer_blur_over_body` → `PaintInnerShadow`).
        let gathers: Vec<(usize, u128, u8)> = crate::vello::abi::with_scene(|live, _, _| {
            live.roots()
                .iter()
                .enumerate()
                .filter_map(|(i, &id)| {
                    let n = live.get(id)?;
                    let non_box = matches!(n.kind, crate::model::ShapeKind::Path | crate::model::ShapeKind::Text);
                    let has_gather = n.background_blur.is_some() || n.glass.is_some() || n.gather_shader().is_some();
                    // Box drop/inner shadows draw inline in the walk (native blurred-rounded-rect), so only
                    // NON-box shadows need the sink's silhouette stack.
                    let has_silhouette_shadow = non_box && !n.shadows.is_empty();
                    let needs_stack = has_silhouette_shadow || n.blur.is_some() || n.has_spread_shader();
                    if needs_stack {
                        Some((i, id, FX_STACK))
                    } else if has_gather {
                        Some((i, id, FX_GATHER))
                    } else {
                        None
                    }
                })
                .collect()
        });
        let root_count = crate::vello::abi::with_scene(|live, _, _| live.roots().len());
        crate::vello::prof::dbg_add(26, crate::vello::prof::now() - _tgd);

        let mut enc =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("whole-viewport") });

        // No gather → the fast path: one scene, one rasterize, blit to the swapchain.
        if gathers.is_empty() {
            let inter = self.pool.acquire_target(
                device, width, height, format,
                self.raster_usage | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING,
                "wv inter",
            );
            let inter_view = inter.create_view(&wgpu::TextureViewDescriptor::default());
            let mut scene = backend.new_scene(width as u16, height as u16);
            backend.draw_whole_scene(&mut scene, root);
            // Phased proof: render the one scene as TWO draw-range phases sharing a single front-end/
            // setup (the collapse the gather path will use), instead of one `render_full`. The two
            // ranges are complementary — [0, k) then [k, ∞) drawn over it — so the composited result
            // must equal the single full render, and `renders` stays 1. Gated by `wvPhased`.
            if crate::vello::abi::wv_phased() && backend.phased_supported() {
                let n = backend.draw_object_count(&scene);
                let phases: Vec<(u32, u32)> = if n >= 2 {
                    vec![(0, n / 2), (n / 2, u32::MAX)]
                } else {
                    vec![(0, u32::MAX)]
                };
                // One target texture per phase — each is a fine storage-write target AND the next
                // phase's sampled base, so it needs STORAGE_BINDING | TEXTURE_BINDING. The LAST phase's
                // target is `inter` (blitted to the swapchain below); earlier phases get scratch
                // textures held as frame-transient.
                let phase_usage = self.raster_usage
                    | wgpu::TextureUsages::COPY_SRC
                    | wgpu::TextureUsages::TEXTURE_BINDING;
                let mut inter_texs: Vec<wgpu::Texture> = Vec::new();
                let mut phase_views: Vec<wgpu::TextureView> = Vec::new();
                for pi in 0..phases.len() {
                    if pi + 1 == phases.len() {
                        break; // last phase → inter_view, appended after the loop
                    }
                    let t = self.pool.acquire_target(device, width, height, format, phase_usage, "wv phase");
                    phase_views.push(t.create_view(&wgpu::TextureViewDescriptor::default()));
                    inter_texs.push(t);
                }
                let mut target_refs: Vec<&wgpu::TextureView> = phase_views.iter().collect();
                target_refs.push(&inter_view);
                backend.rasterize_phased(&scene, device, queue, &mut enc, &target_refs, width, height, crate::vello::abi::background(), &phases);
                drop(target_refs);
                for t in inter_texs {
                    self.frame_transient.push(t);
                }
            } else {
                backend.rasterize(&scene, device, queue, &mut enc, &inter_view, width, height, crate::vello::abi::background());
            }
            self.present_final(&mut enc, device, &sw_view, &inter_view, width, height, format, sz, full_view);
            crate::vello::prof::inc_submit();
            queue.submit([enc.finish()]);
            backend.after_submit();
            self.frame_transient.push(inter);
            return;
        }

        // Collapsed gather path: drive ONE persistent phased session (front-end once, one setup) and
        // record each gather's effect BETWEEN phases into the same encoder. `wvPhased` gates it; it
        // needs the phased backend. Each phase writes its own texture, the gather's effect stamps its
        // lens onto that texture in place (a compositor render pass, ordered after the fine compute
        // write within the encoder), and the next phase loads it as its fine base. The whole gather
        // frame is one vello setup + a few cheap effect passes, versus one `render_full` per gather.
        if crate::vello::abi::wv_phased() && backend.phased_supported() {
            // Bracket the whole frame's GPU execution with a timestamp span (this path is one submit,
            // so the span = total GPU-busy time for the frame). `begin_pass` opens it since the first
            // real op is a vello compute pass we can't stamp directly.
            if !self.gpu_timer_tried {
                self.gpu_timer_tried = true;
                self.gpu_timer = crate::vello::gputime::GpuTimer::new(device, queue);
                if crate::vello::abi::prof_passes() {
                    self.pass_prof = crate::vello::gputime::PassProfiler::new(device, queue);
                }
            }
            if let Some(t) = self.gpu_timer.as_mut() {
                t.begin();
                t.begin_pass(&mut enc, &sw_view);
            }
            if let Some(p) = self.pass_prof.as_mut() {
                p.begin();
            }
            // Encode the whole document ONCE, recording each gather's draw-index boundary (draw objects
            // in roots [0, gi)) during that single walk — no separate prefix re-encode per gather. The
            // phased render's ranges index this same scene. DIAG (bucket 30) times the whole encode;
            // bucket 29 (the old redundant re-encode) is gone — it now reads 0.
            let _tenc = crate::vello::prof::now();
            let mut scene = backend.new_scene(width as u16, height as u16);
            // Boundaries: the draw-count prefix below each gather. With `cmd_effect` on, the SAME
            // segmented walk also emits a native CMD_EFFECT marker at each gather (the front-end carries
            // `effect_id` + the lens coverage into the PTCL). The boundary is snapshotted BEFORE the
            // marker, so a fine phase's `[drawn_upto, b)` still spans only backdrop geometry and each
            // marker falls at the head of the NEXT phase, where fine steps over it. `pre_final` is the
            // draw count just before the above-content segment (past every marker), so the final-phase
            // guard tests for real geometry above the last gather, not for a trailing marker — otherwise
            // a pure-lens top would run an all-marker phase that clears the frame to black. Effect
            // stamping is unchanged, so the frame is pixel-identical to `cmd_effect` off.
            // One walk builds the boundaries for BOTH paths; `cmd_effect` only decides whether a native
            // CMD_EFFECT marker is also emitted at each boundary (the front-end-once fine needs them; the
            // coarse-per-phase path doesn't). A layer blur's whole subtree is rendered isolated in the
            // loop, so it is skipped from this shared walk entirely; gather/shadow keep their body here.
            let use_markers = crate::vello::abi::cmd_effect();
            let (boundaries, pre_final): (Vec<u32>, u32) = {
                let mut b = Vec::with_capacity(gathers.len());
                let mut cursor = 0usize;
                for &(gi, gid, kind) in &gathers {
                    if gi > cursor {
                        backend.draw_scene_range(&mut scene, root, cursor, gi);
                        cursor = gi;
                    }
                    b.push(backend.draw_object_count(&scene));
                    if use_markers {
                        // effect_id: 0 glass, 1 background blur, 2 custom gather, 6 = effect stack. The
                        // marker is only a boundary today (fine steps over it); the sink dispatches by the
                        // node, so the id is informational.
                        let effect_id = if kind == FX_STACK {
                            6u32
                        } else {
                            crate::vello::abi::with_scene(|live, _, _| {
                                live.get(gid).map_or(1u32, |n| {
                                    if n.glass.is_some() { 0 } else if n.gather_shader().is_some() { 2 } else { 1 }
                                })
                            })
                        };
                        backend.draw_effect_marker(&mut scene, root, gid, effect_id, [0.0; 4]);
                    }
                    if kind == FX_STACK {
                        // Exclude the whole stack node's subtree from the shared walk — `wv_paint_stack`
                        // renders its body isolated (so blur/spread apply) and composites the full stack.
                        cursor = gi + 1;
                    }
                }
                let pf = backend.draw_object_count(&scene);
                backend.draw_scene_range(&mut scene, root, cursor, usize::MAX);
                (b, pf)
            };
            let total_draws = backend.draw_object_count(&scene);
            crate::vello::prof::dbg_add(30, crate::vello::prof::now() - _tenc);

            // A fine PHASE is only worth running when it actually draws geometry — i.e. when the
            // draw-range is non-empty. Stacked gathers share one backdrop level (their lens bodies emit
            // no draws), so their boundaries collapse to the same index; emitting an empty-range phase
            // between each would run `fine_area_load` over an all-empty PTCL, which clears its target to
            // transparent instead of copying the base — blacking out the frame. Instead we render each
            // DISTINCT non-empty backdrop segment once and chain the gather stamps directly on the
            // running accumulator `cur`. At most k+1 fine phases (one per distinct segment + the final
            // above-content), plus k cheap effect stamps.
            let phase_usage = self.raster_usage
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::TEXTURE_BINDING;
            let n_slots = gathers.len() + 1;
            let texs: Vec<wgpu::Texture> = (0..n_slots)
                .map(|_| self.pool.acquire_target(device, width, height, format, phase_usage, "wv phase"))
                .collect();
            let views: Vec<wgpu::TextureView> =
                texs.iter().map(|t| t.create_view(&wgpu::TextureViewDescriptor::default())).collect();

            // DIAG (bucket 31): vello's CPU-side resolve + shared-buffer allocation over the encoding
            // (front-end setup on the CPU). Scales with encoding size ≈ shape count — a prime suspect
            // for the untimed `other` bucket.
            let _tpb = crate::vello::prof::now();
            backend.phased_begin(&scene, device, queue, &mut enc, width, height, crate::vello::abi::background());
            crate::vello::prof::dbg_add(31, crate::vello::prof::now() - _tpb);

            // Front-end-once: with CMD_EFFECT markers in the encoding, build ONE shared PTCL — coarse
            // runs a single time over the whole draw range — and paint each backdrop segment with a
            // lone `fine` dispatch (seg_target), instead of re-running the flatten/bin/coarse stack per
            // draw-window. `seg_mode` mirrors the marker gate used to build `boundaries` above, so the
            // markers `fine` counts are present. With it off, the loop below drives the original
            // coarse-per-phase path unchanged — the A/B that proves the two produce identical pixels.
            let seg_mode = crate::vello::abi::cmd_effect();
            if seg_mode {
                backend.phased_frontend_full(device, queue, &mut enc);
            }
            let n_gathers = gathers.len() as u32;

            // DIAG (bucket 27): the phase loop + gather stamps + finish + swap blit — the CPU cost of
            // recording the actual render commands, closing the remaining `other`.
            let _tpl = crate::vello::prof::now();
            let mut drawn_upto = 0u32; // draws already rendered into `cur`
            let mut cur: Option<usize> = None; // slot holding the current accumulator
            let mut next_slot = 0usize; // next fine-phase output slot
            // Checkpoint the frame keepalives so each node's effect scratch can be recycled back into
            // the pool at its boundary (the phase `texs`/`views` slots are held locally, not here, so
            // they are untouched). Peak memory = phase slots + accumulator + one node, not Σ(nodes).
            let (tex_cp, view_cp) = (self.frame_transient.len(), self.frame_transient_views.len());
            for (j, &(gi, gid, kind)) in gathers.iter().enumerate() {
                let b = boundaries[j];
                if b > drawn_upto {
                    // Render the backdrop segment below gather j over the running accumulator (the very
                    // first phase has no base: `fine_area` clears to the page background). Segmented:
                    // `fine` paints segment j of the shared PTCL (bounded by gather j's marker). Windowed:
                    // re-run coarse over draws [drawn_upto, b). Both cover the same backdrop geometry.
                    let base = cur.map(|c| &views[c]);
                    if seg_mode {
                        backend.phased_fine_segment(device, queue, &mut enc, j as u32, base, &views[next_slot]);
                    } else {
                        backend.phased_phase(device, queue, &mut enc, drawn_upto, b, base, &views[next_slot]);
                    }
                    cur = Some(next_slot);
                    next_slot += 1;
                    drawn_upto = b;
                } else if cur.is_none() {
                    // A gather sits at draw index 0 (nothing below it): seed the accumulator with the
                    // page background so its effect has a backdrop to read.
                    let bg = crate::vello::abi::background().components;
                    Compositor::clear(&mut enc, &views[next_slot],
                        [f64::from(bg[0]), f64::from(bg[1]), f64::from(bg[2]), f64::from(bg[3])], None);
                    cur = Some(next_slot);
                    next_slot += 1;
                }
                // Effect j runs into the accumulator, recorded into the SAME frame encoder as the phases.
                // No flush needed: wgpu orders the fine→effect read-after-write with an in-encoder
                // barrier, and the whole frame is one `queue.submit` at the end. A gather reads the
                // accumulator and stamps its lens back in place; a path shadow composites a blurred
                // silhouette under the body the NEXT fine segment paints over `cur`.
                let ci = cur.expect("accumulator seeded");
                match kind {
                    FX_STACK => self.wv_paint_stack(backend, device, queue, &mut enc, &views[ci], root, full_view, gid, gi, width, height, format, sz),
                    _ => self.wv_stamp_gather(backend, device, queue, &mut enc, &views[ci], root, full_view, gid, width, height, format, sz),
                }
                // This node's result is now composited into `views[ci]`; its scratch is dead — recycle
                // it so the next node reuses the same GPU textures instead of the frame holding all.
                self.recycle_node_transient(tex_cp, view_cp);
            }
            // Final phase: the gather bodies + everything above the last backdrop segment, over the last
            // stamp — but ONLY if there is real geometry left to draw. When the topmost gathers are pure
            // lenses (no body draws), `[pre_final, total)` is empty (or holds only inert markers);
            // running that phase would black the frame (no real tiles → the fresh target is never
            // written), so we blit the accumulator directly instead. Testing against `pre_final` — not
            // `drawn_upto` — is what keeps a trailing CMD_EFFECT marker from being mistaken for geometry.
            let final_slot = if total_draws > pre_final {
                let base = cur.map(|c| &views[c]);
                if seg_mode {
                    // The final segment (index == marker count) is everything above the last gather.
                    backend.phased_fine_segment(device, queue, &mut enc, n_gathers, base, &views[next_slot]);
                } else {
                    backend.phased_phase(device, queue, &mut enc, drawn_upto, u32::MAX, base, &views[next_slot]);
                }
                next_slot
            } else {
                cur.expect("no geometry and no gather seeded an accumulator")
            };
            backend.phased_finish(device, queue, &mut enc);
            crate::vello::prof::dbg_add(27, crate::vello::prof::now() - _tpl);

            // Swap-blit pair (M, N): M anchored on the final accumulator (written by the last phase), N
            // on the swapchain (written by the blit). N−M = the present-time full-viewport blit; both
            // deltas are dependency-ordered. M's interval (final phase etc.) is OTHER; N's is SWAP_BLIT.
            // The vello render = gpuSpan − Σ(gather regions) − swapBlit (i.e. the OTHER bucket + head).
            if let Some(p) = self.pass_prof.as_mut() {
                p.stamp(&mut enc, &views[final_slot], crate::vello::graph::prof_bucket::OTHER);
            }
            self.present_final(&mut enc, device, &sw_view, &views[final_slot], width, height, format, sz, full_view);
            if let Some(p) = self.pass_prof.as_mut() {
                p.stamp(&mut enc, &sw_view, crate::vello::graph::prof_bucket::SWAP_BLIT);
            }
            // Close the GPU timestamp span (empty end pass + resolve) before the one submit.
            if let Some(t) = self.gpu_timer.as_mut() {
                t.end(&mut enc, &sw_view);
                t.resolve(&mut enc);
            }
            if let Some(p) = self.pass_prof.as_mut() {
                p.resolve(&mut enc);
            }
            drop(views);
            crate::vello::prof::inc_submit();
            queue.submit([enc.finish()]);
            backend.after_submit();
            if let Some(t) = self.gpu_timer.as_mut() {
                t.after_submit();
            }
            if let Some(p) = self.pass_prof.as_mut() {
                p.after_submit();
            }
            for t in texs {
                self.frame_transient.push(t);
            }
            return;
        }

        // Phased path. `acc` accumulates the viewport in z-order: cleared to the page background, then
        // each below-gather segment is src-over-composited in, and each gather's effect is stamped.
        let acc = self.pool.acquire_target(
            device, width, height, format,
            self.raster_usage | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING,
            "wv acc",
        );
        let acc_view = acc.create_view(&wgpu::TextureViewDescriptor::default());
        let bg = crate::vello::abi::background().components;
        Compositor::clear(&mut enc, &acc_view, [f64::from(bg[0]), f64::from(bg[1]), f64::from(bg[2]), f64::from(bg[3])], None);

        // Rasterize every effect surface for the frame in ONE scene, before any node runs. Each node's
        // helpers then sample a ready cell instead of standing up their own vello front-end.
        self.wv_atlas_prepass(&gathers, backend, device, queue, &mut enc, root, full_view, width, height, format);
        // Checkpoint the keepalives so each node's effect scratch is recycled at its boundary (see
        // `recycle_node_transient`) — bounding peak memory to acc + one node instead of acc + Σ(nodes).
        // Taken AFTER the prepass so the atlas cells, which every node reads, are never recycled.
        let (tex_cp, view_cp) = (self.frame_transient.len(), self.frame_transient_views.len());
        let mut seg_start = 0usize;
        for (gi, gid, kind) in gathers {
            // 1) Everything below this effect (a stack node's own body is rendered isolated in the stack,
            //    so it is NOT drawn here; a pure gather keeps its body for the next segment, over the lens).
            if gi > seg_start {
                self.wv_paint_segment(backend, device, queue, &mut enc, &acc_view, root, seg_start, gi, width, height, format, sz);
            }
            // 2) The effect reads finished pixels — flush the `acc` writes before `run_graph`.
            crate::vello::prof::inc_submit();
            let fresh = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("whole-viewport") });
            queue.submit([std::mem::replace(&mut enc, fresh).finish()]);
            backend.after_submit();
            // 3) Run the effect over `acc`: a pure gather stamps its lens (its body paints in the next
            //    segment, over it); a stack node runs its whole ordered effect stack (drops → gather →
            //    body[+spread+blur] → inner) with its body rendered isolated.
            match kind {
                FX_STACK => self.wv_paint_stack(backend, device, queue, &mut enc, &acc_view, root, full_view, gid, gi, width, height, format, sz),
                _ => self.wv_stamp_gather(backend, device, queue, &mut enc, &acc_view, root, full_view, gid, width, height, format, sz),
            }
            // A pure gather keeps its body for the next segment (over the lens); a stack node consumed its
            // whole subtree into the isolated stack, so skip it.
            seg_start = if kind == FX_STACK { gi + 1 } else { gi };
            // The node's scratch is composited into `acc` and (via the flush) submitted — recycle it so
            // the next node reuses the same GPU textures rather than the frame holding every node's.
            self.recycle_node_transient(tex_cp, view_cp);
        }
        // Final segment: the topmost gather's body + everything above the last gather.
        if root_count > seg_start {
            self.wv_paint_segment(backend, device, queue, &mut enc, &acc_view, root, seg_start, root_count, width, height, format, sz);
        }
        self.present_final(&mut enc, device, &sw_view, &acc_view, width, height, format, sz, full_view);
        crate::vello::prof::inc_submit();
        queue.submit([enc.finish()]);
        backend.after_submit();
        self.frame_transient.push(acc);
    }

    /// Release every frame-transient texture (and its view) acquired since the `tex_cp`/`view_cp`
    /// checkpoint back into the pool. Called at each whole-viewport effect-node boundary, once the
    /// node's result is already composited into the accumulator so all of its scratch is dead.
    ///
    /// Without this, the frame keeps EVERY node's intermediates resident until the single submit — a
    /// node fully loaded with effects allocates ~19 full-viewport textures, so peak memory is Σ(nodes)
    /// (~7 GB at 4K × 12 heavy nodes, which spills GPU memory). With it, the next node REUSES the same
    /// GPU textures via the pool free-list, so peak is `accumulator + one node`.
    ///
    /// Safe because the node's last read of each scratch texture is already RECORDED (the composite
    /// into the accumulator) before the next node re-acquires and writes it: wgpu's hazard tracking —
    /// in-encoder for the collapsed path, cross-submit on the same queue for the per-segment path —
    /// serialises the write-after-read on the recycled texture. The pool holds the handle between
    /// release and re-acquire, so the resource is never dropped while commands still reference it.
    fn recycle_node_transient(&mut self, tex_cp: usize, view_cp: usize) {
        crate::vello::prof::note_node_scratch(self.frame_transient.len().saturating_sub(tex_cp));
        self.frame_transient_views.truncate(view_cp);
        for tex in self.frame_transient.drain(tex_cp..) {
            self.pool.release(tex);
        }
    }

    /// A full-viewport 1:1 src-over blit of `src` onto `target`.
    fn blit_full(&self, enc: &mut wgpu::CommandEncoder, device: &wgpu::Device, target: &wgpu::TextureView, src: &wgpu::TextureView, sz: (f32, f32)) {
        self.compositor.blit(device, enc, target, sz, &Blit {
            src, dst: (0.0, 0.0, sz.0, sz.1), src_rect: (0.0, 0.0, sz.0, sz.1), src_size: sz, alpha: 1.0,
        });
    }

    /// (Re)allocate the retained present-on-demand canvas when missing or the viewport resized. The
    /// canvas is persistent (survives frames, never pooled) and holds the last composited frame.
    fn ensure_canvas(&mut self, device: &wgpu::Device, width: u32, height: u32, format: wgpu::TextureFormat) {
        let ok = self.canvas.as_ref().is_some_and(|c| c.2 == width && c.3 == height && c.0.format() == format);
        if !ok {
            let tex = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("retained canvas"),
                size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
            self.canvas = Some((tex, view, width, height));
            self.canvas_view = None; // fresh canvas: no valid prior content
        }
    }

    /// Present the finished whole-viewport frame `final_view` to the swapchain. With present-on-demand
    /// on, first RETAIN it into the persistent canvas (so a later unchanged frame can re-present it)
    /// and record the view it was rendered at, then blit canvas → swapchain. Off: a single direct blit,
    /// byte-identical to the original path.
    #[expect(clippy::too_many_arguments, reason = "the GPU context + present bookkeeping travel together")]
    fn present_final(
        &mut self,
        enc: &mut wgpu::CommandEncoder,
        device: &wgpu::Device,
        sw_view: &wgpu::TextureView,
        final_view: &wgpu::TextureView,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
        full_view: Affine,
    ) {
        if crate::vello::abi::present_on_demand() {
            self.ensure_canvas(device, width, height, format);
            let cv = self.canvas.as_ref().expect("canvas ensured").1.clone();
            // The retain must REPLACE, not composite. The canvas persists across frames, and the blit
            // is premultiplied SrcOver — so without clearing first, this frame would stack over the last
            // retained one and any semi-transparent region (edges, gaps, a translucent background) would
            // accumulate and brighten. Cleared to transparent, the SrcOver over dst=0 lands `final`
            // exactly.
            Compositor::clear(enc, &cv, [0.0, 0.0, 0.0, 0.0], None);
            self.blit_full(enc, device, &cv, final_view, sz); // retain (exact over the cleared canvas)
            // Present straight from `final` so a real-render frame is byte-identical to the non-retained
            // path; a later skip re-presents the (identical) canvas.
            self.blit_full(enc, device, sw_view, final_view, sz);
            self.canvas_view = Some(full_view);
        } else {
            self.blit_full(enc, device, sw_view, final_view, sz);
        }
    }

    /// Render root subtrees `[start, end)` into a fresh viewport target (transparent base) and
    /// src-over-composite it onto the accumulator.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn wv_paint_segment<B: RasterBackend>(
        &mut self,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        acc_view: &wgpu::TextureView,
        root: Affine,
        start: usize,
        end: usize,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
    ) {
        let seg = self.pool.acquire_target(
            device, width, height, format,
            self.raster_usage | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING,
            "wv seg",
        );
        let seg_view = seg.create_view(&wgpu::TextureViewDescriptor::default());
        let mut scene = backend.new_scene(width as u16, height as u16);
        backend.draw_scene_range(&mut scene, root, start, end);
        backend.rasterize(&scene, device, queue, enc, &seg_view, width, height, TRANSPARENT);
        self.blit_full(enc, device, acc_view, &seg_view, sz);
        self.frame_transient.push(seg);
    }

    /// Run a gather's effect graph over the whole-viewport backdrop (`acc`) and stamp the result back
    /// onto `acc` through the shape's silhouette — the whole-viewport counterpart of the tiled
    /// `paint_gather`, at full res (no `k` cap, backdrop origin `(0,0)`).
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn wv_stamp_gather<B: RasterBackend>(
        &mut self,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        acc_view: &wgpu::TextureView,
        root: Affine,
        full_view: Affine,
        id: u128,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
    ) {
        let is_glass = crate::vello::abi::with_scene(|live, _, _| live.get(id).is_some_and(|n| n.glass.is_some()));
        let is_custom = crate::vello::abi::with_scene(|live, _, _| live.get(id).is_some_and(|n| n.gather_shader().is_some()));
        // Default gather path: run the effect over just the lens's device bbox (scaling GPU with the
        // lens area, not the viewport). Glass + background blur have a bounded blur reach; custom
        // shaders may sample the whole backdrop, so they stay full-viewport.
        if crate::vello::abi::wv_scope() && !is_custom {
            self.wv_stamp_gather_scoped(backend, device, queue, enc, acc_view, root, full_view, id, is_glass, width, height, format, sz);
            return;
        }
        let passes = if is_glass {
            self.glass_graph(id, width, height, 0.0, 0.0, full_view, 1.0)
        } else if is_custom {
            self.custom_graph(id, width, height, device, format)
        } else {
            Some(lower_graph(&effect_graph::background_blur_graph(self.gather_sigma(id, full_view, 1.0)), None))
        };
        let Some(passes) = passes else { return };
        // Fold the effect graph into the frame encoder `enc` (no self-submit): its passes read the
        // backdrop that a prior phase's fine wrote into the same encoder, ordered by wgpu's in-encoder
        // barrier. All scratch textures/views live in the frame keepalives until the one submit.
        let Some((rtex, rview)) = run_graph_into(
            &self.compositor, &self.glass, device, enc, &[acc_view], &passes, width, height, format,
            &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views,
            self.pass_prof.as_mut(),
        ) else {
            return;
        };
        if is_glass {
            // Glass baked its SDF mask + backdrop passthrough, so a plain blit over the viewport re-lays
            // the backdrop everywhere and the glass inside its silhouette.
            self.blit_full(enc, device, acc_view, &rview, sz);
        } else {
            // Background blur / custom: clip the blurred result to the shape's silhouette.
            let mask = self.pool.acquire_target(device, width, height, format, self.raster_usage, "wv mask");
            let mask_view = mask.create_view(&wgpu::TextureViewDescriptor::default());
            let mut mscene = backend.new_scene(width as u16, height as u16);
            backend.build_mask(&mut mscene, root, id);
            backend.rasterize(&mscene, device, queue, enc, &mask_view, width, height, TRANSPARENT);
            self.compositor.blit_masked(device, enc, acc_view, sz, &MaskedBlit {
                src: &rview, mask: &mask_view, dst: (0.0, 0.0, sz.0, sz.1), src_rect: (0.0, 0.0, sz.0, sz.1), src_size: sz, alpha: 1.0,
            });
            self.frame_transient.push(mask);
            self.frame_transient_views.push(mask_view);
        }
        self.frame_transient.push(rtex);
        self.frame_transient_views.push(rview);
    }

    /// Every effect surface a whole-viewport node needs, resolved to geometry, in ONE pass over the
    /// node's unified effect list ([`crate::effect::effect_stack`]).
    ///
    /// This used to be three planners — one for drop silhouettes, one for the inner-shadow flood and
    /// punch, one for the body — each re-deriving its own extent and render scale from a different
    /// authoring field. They are the same computation: take the shape's page bounds, let the effect's
    /// own pipeline displace and spread them ([`Effect::footprint`]), snap to device pixels, and pick
    /// a render scale. Asking the effect instead of asking which field it came from collapses all
    /// three into this loop, and a new effect kind needs no new planner.
    ///
    /// Backdrop readers are skipped: a gather samples the accumulator, which does not exist yet when
    /// the prepass runs, so it cannot be batched into it.
    ///
    /// Cell keys stay `(node, kind, index)` with kind `0` drop silhouette, `1` body, `2` inner flood,
    /// `3` inner punch, because that is what the consuming helpers look up.
    fn wv_effect_cells(&self, id: u128, full_view: Affine, width: u32, height: u32) -> Vec<WvCell> {
        let Some((base, stack)) = crate::vello::abi::with_scene(|live, _, modifiers| {
            let node = live.get(id)?;
            let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
            Some((crate::schedule::page_bounds(node, m), crate::effect::effect_stack(node)))
        }) else {
            return Vec::new();
        };
        let c = full_view.as_coeffs();
        let view_scale = (c[0] * c[0] + c[1] * c[1]).sqrt() as f32;
        let (mut drop_i, mut inner_i) = (0usize, 0usize);
        let mut out = Vec::new();
        let mut has_body = false;
        for effect in &stack {
            if effect.reads_backdrop() {
                continue;
            }
            // Which surfaces this effect materialises, and under which keys.
            let kinds: &[u8] = match (&effect.source, effect.compose) {
                (Source::Coverage { .. }, Compose::Under) => &[0],
                (Source::Coverage { .. }, Compose::Over) => &[2, 3],
                (Source::Body, _) => &[1],
                _ => continue,
            };
            let Some((bx, by, bw, bh)) = wv_device_box(effect.footprint(base), full_view, width, height) else {
                continue;
            };
            // Render scale = memory LIMIT ∩ effect DOWNSCALE. A trailing blur's band limit supersedes
            // any sharper requirement before it; with no blur, the strictest shader floor decides.
            let device_sigma = effect
                .governing_blur()
                .map(|r| crate::blur::radius_to_sigma(r) * view_scale)
                .filter(|s| *s >= 0.5);
            let k = match device_sigma {
                Some(sigma) => (tiling::resolution_cap(full_view, 3.0 * f64::from(sigma / view_scale))
                    .min(f64::from(blur_acceptable_downscale(sigma)))) as f32,
                None => (tiling::resolution_cap(full_view, 0.0)
                    .min(f64::from(effect.shader_downscale_floor()))) as f32,
            };
            let (kw, kh) = (((bw as f32 * k).round() as u32).max(1), ((bh as f32 * k).round() as u32).max(1));
            let index = match kinds[0] {
                0 => drop_i,
                2 => inner_i,
                _ => 0,
            };
            for &kind in kinds {
                out.push(WvCell { key: (id, kind, index), bx, by, bw, bh, kw, kh, k, sigma: device_sigma.unwrap_or(0.0) });
            }
            match kinds[0] {
                0 => drop_i += 1,
                2 => inner_i += 1,
                _ => has_body = true,
            }
        }
        // A stack node's body is excluded from the shared walk, so it ALWAYS needs a surface — even
        // with no body effect at all (a shape carrying only shadows still has to be drawn). The loop
        // above only emits one when some effect reads `Source::Body`, so cover the rest here.
        if !has_body {
            if let Some((bx, by, bw, bh)) = wv_device_box(base, full_view, width, height) {
                let k = tiling::resolution_cap(full_view, 0.0) as f32;
                let (kw, kh) = (((bw as f32 * k).round() as u32).max(1), ((bh as f32 * k).round() as u32).max(1));
                out.push(WvCell { key: (id, 1, 0), bx, by, bw, bh, kw, kh, k, sigma: 0.0 });
            }
        }
        out
    }

    /// Rasterize EVERY effect surface in the frame in one go.
    ///
    /// Each surface is a cell of one shelf-packed atlas, drawn by a single scene and so a single vello
    /// front-end, then copied out into its own pooled texture. That replaces one full front-end per
    /// surface (~13 dispatches each) with one for the whole frame plus N cheap texture copies. Cells are
    /// sized to their own device extent and separated by `GAP`, so neither geometry nor a blur kernel
    /// can reach a neighbouring cell — the same containment `atlas_effects` relies on.
    #[expect(clippy::too_many_arguments, reason = "GPU context threaded through the sink")]
    fn wv_atlas_prepass<B: RasterBackend>(
        &mut self,
        gathers: &[(usize, u128, u8)],
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        root: Affine,
        full_view: Affine,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
    ) {
        const GAP: u32 = 4;
        // Last frame's cells go back to the pool, not the floor — otherwise every cell is a fresh
        // `create_texture` each frame and the prepass trades front-ends for allocations.
        for (_, (tex, _)) in std::mem::take(&mut self.wv_atlas) {
            self.pool.release(tex);
        }
        let max_dim = device.limits().max_texture_dimension_2d;
        // Collect every surface the frame's stack nodes will need, with its root index for the body.
        let mut cells: Vec<(WvCell, usize)> = Vec::new();
        for &(gi, gid, kind) in gathers {
            if kind != FX_STACK {
                continue;
            }
            for c in self.wv_effect_cells(gid, full_view, width, height) {
                cells.push((c, gi));
            }
        }
        cells.retain(|(c, _)| c.kw <= max_dim && c.kh <= max_dim);
        if cells.len() < 2 {
            return; // nothing to amortise a shared front-end over
        }
        let sizes: Vec<(u32, u32)> = cells.iter().map(|(c, _)| (c.kw, c.kh)).collect();
        let Some(packing) = shelf_pack(&sizes, GAP, 2048, max_dim) else { return };
        let (aw, ah) = (packing.width, packing.height);

        // ONE scene, ONE front-end, for every surface in the frame.
        let mut scene = backend.new_scene(aw as u16, ah as u16);
        for cell in &packing.cells {
            let (c, root_index) = &cells[cell.index];
            // Place the cell's crop box at the cell origin, at the surface's own scale.
            let m = Affine::translate((f64::from(cell.x), f64::from(cell.y)))
                * Affine::scale(f64::from(c.k))
                * Affine::translate((-f64::from(c.bx), -f64::from(c.by)))
                * root;
            match c.key.1 {
                0 => backend.build_shadow_silhouette(&mut scene, m, c.key.0, c.key.2, false, true),
                2 => backend.build_shadow_silhouette(&mut scene, m, c.key.0, c.key.2, true, false),
                3 => backend.build_shadow_silhouette(&mut scene, m, c.key.0, c.key.2, true, true),
                _ => backend.draw_scene_range(&mut scene, m, *root_index, *root_index + 1),
            }
        }
        let atlas_usage = self.raster_usage | wgpu::TextureUsages::COPY_SRC;
        let atlas = self.pool.acquire(
            device,
            PoolKey { w: aw, h: ah, format, usage: atlas_usage.bits() },
            "wv effect atlas",
        );
        let atlas_view = atlas.create_view(&wgpu::TextureViewDescriptor::default());
        backend.rasterize(&scene, device, queue, enc, &atlas_view, aw, ah, TRANSPARENT);

        // Copy each cell into its own surface, so every consumer keeps sampling a private texture.
        for cell in &packing.cells {
            let (c, _) = &cells[cell.index];
            let tex = self.pool.acquire_target(
                device, c.kw, c.kh, format,
                self.raster_usage | wgpu::TextureUsages::COPY_DST,
                "wv atlas cell",
            );
            enc.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &atlas,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: cell.x, y: cell.y, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyTextureInfo {
                    texture: &tex,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: 0, y: 0, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d { width: c.kw, height: c.kh, depth_or_array_layers: 1 },
            );
            let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
            self.wv_atlas.insert(c.key, (tex, view));
        }
        self.frame_transient.push(atlas);
    }

    /// Composite a node's drop shadows into the whole-viewport accumulator, UNDER the body.
    ///
    /// Geometry comes from [`Self::wv_effect_cells`] — the same planner the atlas prepass used — so
    /// the crop box, render scale and device sigma are derived once and cannot drift between the
    /// surface that was rasterized and the composite that places it. This helper is now only the GPU
    /// half: take the prepared silhouette, blur it, and stamp it at its box.
    ///
    /// Offset, colour and spread ride on the node and were applied when the silhouette was drawn, so
    /// nothing here reads the shadow list.
    #[expect(clippy::too_many_arguments, reason = "GPU context threaded through the sink")]
    fn wv_paint_path_shadow<B: RasterBackend>(
        &mut self,
        cell: WvCell,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        acc_view: &wgpu::TextureView,
        root: Affine,
        id: u128,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
    ) {
        {
            let WvCell { bx, by, bw, bh, kw, kh, k, sigma, key } = cell;
            let (bxf, byf, bwf, bhf) = (bx as f32, by as f32, bw as f32, bh as f32);
            // The prepass rasterized this silhouette as an atlas cell; fall back to a private vello
            // front-end only when it declined (too few surfaces, or the packing did not fit).
            let sil_view = if let Some((_, v)) = self.wv_atlas.get(&key) {
                v.clone()
            } else {
                let crop = Affine::translate((-f64::from(bx), -f64::from(by))) * root;
                let sil = self.pool.acquire_target(device, kw, kh, format, self.raster_usage, "wv path shadow silhouette");
                let v = sil.create_view(&wgpu::TextureViewDescriptor::default());
                let mut sscene = backend.new_scene(kw as u16, kh as u16);
                backend.build_shadow_silhouette(&mut sscene, Affine::scale(f64::from(k)) * crop, id, key.2, false, true);
                backend.rasterize(&sscene, device, queue, enc, &v, kw, kh, TRANSPARENT);
                self.frame_transient.push(sil);
                self.frame_transient_views.push(v.clone());
                v
            };
            let (kwf, khf) = (kw as f32, kh as f32);
            if sigma >= 0.5 {
                // Blur at the reduced scale (reduced sigma), then upscale on the composite.
                let passes = lower_graph(&effect_graph::background_blur_graph(sigma * k), None);
                let blurred = run_graph_into(
                    &self.compositor, &self.glass, device, enc, &[&sil_view], &passes, kw, kh, format,
                    &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views, self.pass_prof.as_mut(),
                );
                let Some((tex, view)) = blurred else { return };
                self.compositor.blit(device, enc, acc_view, sz, &Blit {
                    src: &view, dst: (bxf, byf, bwf, bhf), src_rect: (0.0, 0.0, kwf, khf), src_size: (kwf, khf), alpha: 1.0,
                });
                self.frame_transient.push(tex);
                self.frame_transient_views.push(view);
            } else {
                // Sub-half-pixel blur: the sharp silhouette IS the shadow.
                self.compositor.blit(device, enc, acc_view, sz, &Blit {
                    src: &sil_view, dst: (bxf, byf, bwf, bhf), src_rect: (0.0, 0.0, kwf, khf), src_size: (kwf, khf), alpha: 1.0,
                });
            }
        }
    }


    /// Composite a node's inner (inset) shadows over the whole-viewport accumulator, on top of the
    /// body already painted below this boundary.
    ///
    /// The band is built entirely in textures: the shadow-coloured silhouette at the shape's own
    /// position is the flood (already clipped to the outline because it IS the outline), the same
    /// silhouette offset and blurred is the punch, and `DestOut` of the punch from the flood leaves
    /// colour only in the band on the offset side.
    ///
    /// Geometry comes from [`Self::wv_effect_cells`], the same planner the atlas prepass used, so the
    /// flood and the punch are guaranteed to share one box — which they must, since the `DestOut`
    /// aligns them 1:1.
    #[expect(clippy::too_many_arguments, reason = "GPU context threaded through the sink")]
    fn wv_paint_inner_shadow<B: RasterBackend>(
        &mut self,
        cell: WvCell,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        acc_view: &wgpu::TextureView,
        root: Affine,
        id: u128,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
    ) {
        // `cell` is the flood (kind 2); its punch (kind 3) shares the same box and index.
        {
            let WvCell { bx, by, bw, bh, kw, kh, k, sigma, key } = cell;
            let i = key.2;
            let ksz = (kw as f32, kh as f32);
            let full_src = (0.0, 0.0, ksz.0, ksz.1);
            let crop = Affine::translate((-f64::from(bx), -f64::from(by))) * root;
            let scaled_root = Affine::scale(f64::from(k)) * crop;
            // 1. The flood, and 2. the punch — both from the prepass when it ran.
            let mut fetch = |sink: &mut Self, kind: u8, apply_offset: bool, backend: &mut B, enc: &mut wgpu::CommandEncoder| {
                if let Some((_, v)) = sink.wv_atlas.get(&(id, kind, i)) {
                    return v.clone();
                }
                let label = if apply_offset { "wv inner shadow punch" } else { "wv inner shadow band" };
                let tex = sink.pool.acquire_target(device, kw, kh, format, sink.raster_usage, label);
                let v = tex.create_view(&wgpu::TextureViewDescriptor::default());
                let mut scene = backend.new_scene(kw as u16, kh as u16);
                backend.build_shadow_silhouette(&mut scene, scaled_root, id, i, true, apply_offset);
                backend.rasterize(&scene, device, queue, enc, &v, kw, kh, TRANSPARENT);
                sink.frame_transient.push(tex);
                sink.frame_transient_views.push(v.clone());
                v
            };
            let band_view = fetch(self, 2, false, backend, enc);
            let punch_view = fetch(self, 3, true, backend, enc);
            // 3. Punch the (blurred) offset silhouette out of the flood: band = band·(1 − punch.a).
            if sigma >= 0.5 {
                let passes = lower_graph(&effect_graph::background_blur_graph(sigma * k), None);
                let blur_out = run_graph_into(
                    &self.compositor, &self.glass, device, enc, &[&punch_view], &passes, kw, kh, format,
                    &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views, self.pass_prof.as_mut(),
                );
                let Some((ptex, pview)) = blur_out else { return };
                self.compositor.blit_dstout(device, enc, &band_view, ksz, &Blit {
                    src: &pview, dst: (0.0, 0.0, ksz.0, ksz.1), src_rect: full_src, src_size: ksz, alpha: 1.0,
                });
                self.frame_transient.push(ptex);
                self.frame_transient_views.push(pview);
            } else {
                self.compositor.blit_dstout(device, enc, &band_view, ksz, &Blit {
                    src: &punch_view, dst: (0.0, 0.0, ksz.0, ksz.1), src_rect: full_src, src_size: ksz, alpha: 1.0,
                });
            }
            // 4. Upscale-composite the band back at its box, over the body drawn below.
            self.compositor.blit(device, enc, acc_view, sz, &Blit {
                src: &band_view, dst: (bx as f32, by as f32, bw as f32, bh as f32), src_rect: full_src, src_size: ksz, alpha: 1.0,
            });
        }
    }


    /// Run a stack node's WHOLE ordered effect stack over the whole-viewport accumulator, at the node's
    /// z. Its body is excluded from the shared walk, so this composites the full stack in the same order
    /// the tiled path does — **drops (under) → gather lens → body[+spread shaders +layer blur] (over) →
    /// inner shadows (over)** — which is what lets several effects on ONE shape (and several of the same
    /// kind) combine correctly. Each sub-effect reuses the same building block the single-effect path did.
    #[expect(clippy::too_many_arguments, reason = "GPU context threaded through the sink")]
    fn wv_paint_stack<B: RasterBackend>(
        &mut self,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        acc_view: &wgpu::TextureView,
        root: Affine,
        full_view: Affine,
        id: u128,
        root_index: usize,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
    ) {
        let stack = crate::vello::abi::with_scene(|live, _, _| {
            live.get(id).map(crate::effect::effect_stack).unwrap_or_default()
        });
        let cells = self.wv_effect_cells(id, full_view, width, height);
        let find = |kind: u8, idx: usize| cells.iter().find(|c| c.key.1 == kind && c.key.2 == idx).copied();

        // The list IS the order. Each effect says what it reads and where its result goes, so the
        // sequence here is the authored sequence rather than four phases hardcoded in this function.
        let (mut drop_i, mut inner_i) = (0usize, 0usize);
        let mut body_done = false;
        for effect in &stack {
            match (&effect.source, effect.compose) {
                // Under the body: a drop shadow's blurred silhouette.
                (Source::Coverage { .. }, Compose::Under) => {
                    if let Some(c) = find(0, drop_i) {
                        self.wv_paint_path_shadow(c, backend, device, queue, enc, acc_view, root, id, format, sz);
                    }
                    drop_i += 1;
                }
                // Reads the accumulator (backdrop + whatever composited under it) and stamps its lens.
                (Source::Backdrop, _) => {
                    self.wv_stamp_gather(backend, device, queue, enc, acc_view, root, full_view, id, width, height, format, sz);
                }
                // The body itself: isolated render, then its own shader chain and layer blur.
                (Source::Body, _) => {
                    if let Some(c) = find(1, 0) {
                        self.wv_composite_body(c, &effect.ops, backend, device, queue, enc, acc_view, root, id, root_index, format, sz);
                    }
                    body_done = true;
                }
                // Over the body — so the body has to exist first. A node with only shadows carries no
                // `Source::Body` effect, yet its body is excluded from the shared walk and still needs
                // drawing; painting it here keeps the inner band on top of it either way.
                (Source::Coverage { .. }, Compose::Over) => {
                    if !body_done {
                        if let Some(c) = find(1, 0) {
                            self.wv_composite_body(c, &[], backend, device, queue, enc, acc_view, root, id, root_index, format, sz);
                        }
                        body_done = true;
                    }
                    if let Some(c) = find(2, inner_i) {
                        self.wv_paint_inner_shadow(c, backend, device, queue, enc, acc_view, root, id, format, sz);
                    }
                    inner_i += 1;
                }
                _ => {}
            }
        }
        // Nothing composited over the body (or there were no effects at all) — draw it now.
        if !body_done {
            if let Some(c) = find(1, 0) {
                self.wv_composite_body(c, &[], backend, device, queue, enc, acc_view, root, id, root_index, format, sz);
            }
        }
    }

    /// Render a stack node's subtree isolated, run its body-only custom (spread) shaders and its layer
    /// blur over it in order, then SrcOver-composite the result onto the accumulator. The front-end-once
    /// analogue of the tiled `build_bodies` → `custom_over_body` → `layer_blur_over_body` chain. Each
    /// transform threads the running body texture through `run_graph_into` into the frame encoder;
    /// intermediates go to the frame keepalive. Full-viewport; extent-crop is a later opt.
    #[expect(clippy::too_many_arguments, reason = "GPU context threaded through the sink")]
    fn wv_composite_body<B: RasterBackend>(
        &mut self,
        cell: WvCell,
        ops: &[crate::effect::Op],
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        acc_view: &wgpu::TextureView,
        root: Affine,
        id: u128,
        root_index: usize,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
    ) {
        // Geometry from the shared planner, so the surface the prepass rasterized and the composite
        // that places it are sized by one derivation. The planner also resolves the render scale:
        // a trailing layer blur governs it (applied last, it softens everything before it, so the
        // whole chain tolerates its band limit); with no blur the strictest shader floor decides.
        let WvCell { bx, by, bw, bh, kw, kh, k, sigma, .. } = cell;
        let blur_sigma = (sigma >= 0.5).then_some(sigma);
        let crop = Affine::translate((-f64::from(bx), -f64::from(by))) * root;
        let (bxf, byf, bwf, bhf) = (bx as f32, by as f32, bw as f32, bh as f32);
        let ksz = (kw as f32, kh as f32);

        // 1. The node's whole subtree, isolated at `k`. Taken from the frame's atlas prepass when it
        //    rasterized this body as a cell; otherwise rendered here with its own front-end.
        let mut cur_view = if let Some((_, v)) = self.wv_atlas.get(&(id, 1, 0)) {
            v.clone()
        } else {
            let sub = self.pool.acquire_target(device, kw, kh, format, self.raster_usage, "wv stack body");
            let v = sub.create_view(&wgpu::TextureViewDescriptor::default());
            let mut scene = backend.new_scene(kw as u16, kh as u16);
            backend.draw_scene_range(&mut scene, Affine::scale(f64::from(k)) * crop, root_index, root_index + 1);
            backend.rasterize(&scene, device, queue, enc, &v, kw, kh, TRANSPARENT);
            self.frame_transient.push(sub);
            self.frame_transient_views.push(v.clone());
            v
        };

        // 2. Body-only (spread) custom shaders, in application order — body → e0 → e1 → … (mirrors the
        //    tiled `custom_over_body`). Run at the body's `k` (the shader's resolution is `u[0].xy`).
        // The shader chain is this effect's own ops, in order — no second read of the node.
        let chain: Vec<(String, Vec<f32>, u32)> = ops
            .iter()
            .filter_map(|op| match op {
                crate::effect::Op::Shader(c) => Some((c.wgsl.clone(), c.params.clone(), c.param_vec4s)),
                _ => None,
            })
            .collect();
        for (wgsl, params, param_vec4s) in chain {
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
            let mut u = vec![ksz.0, ksz.1];
            u.extend_from_slice(&params);
            let passes = lower_graph(&effect_graph::custom_graph(u, param_vec4s), Some(&pipeline));
            let out = run_graph_into(
                &self.compositor, &self.glass, device, enc, &[&cur_view], &passes, kw, kh, format,
                &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views, None,
            );
            let Some((tex, view)) = out else { break };
            self.frame_transient.push(tex);
            self.frame_transient_views.push(cur_view);
            cur_view = view;
        }

        // 3. Layer blur at the reduced scale (reduced sigma), matching the tiled `layer_blur_over_body`.
        if let Some(sigma) = blur_sigma {
            let passes = lower_graph(&effect_graph::background_blur_graph(sigma * k), None);
            if let Some((tex, view)) = run_graph_into(
                &self.compositor, &self.glass, device, enc, &[&cur_view], &passes, kw, kh, format,
                &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views, self.pass_prof.as_mut(),
            ) {
                self.frame_transient.push(tex);
                self.frame_transient_views.push(cur_view);
                cur_view = view;
            }
        }

        // 4. Upscale-composite the finished body back at the crop box, at the node's z.
        self.compositor.blit(device, enc, acc_view, sz, &Blit {
            src: &cur_view, dst: (bxf, byf, bwf, bhf), src_rect: (0.0, 0.0, ksz.0, ksz.1), src_size: ksz, alpha: 1.0,
        });
        self.frame_transient_views.push(cur_view);
    }

    /// Bbox-scoped gather stamp (the default gather path): crop the backdrop to the lens's device
    /// bounding box (expanded by the effect's blur reach, clamped to the viewport), run the effect
    /// graph at that size/origin, and stamp the small result back THROUGH the shape silhouette. Effect
    /// GPU work then scales with the lens area instead of the viewport area. Glass bakes its SDF mask,
    /// so an opaque bbox blit re-lays backdrop+lens; background blur clips with a bbox-local coverage
    /// mask. The effect passes stay rectangular (a blur must read a neighbourhood) — the silhouette is
    /// honoured at the composite, and the tight bbox is near-optimal for a convex lens.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn wv_stamp_gather_scoped<B: RasterBackend>(
        &mut self,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        acc_view: &wgpu::TextureView,
        root: Affine,
        full_view: Affine,
        id: u128,
        is_glass: bool,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
        sz: (f32, f32),
    ) {
        use crate::kurbo::Point;
        // Lens box in page space (with the live drag modifier), then to device space via `full_view`.
        let Some(page) = crate::vello::abi::with_scene(|live, _, modifiers| {
            let n = live.get(id)?;
            let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
            Some(crate::schedule::page_bounds(n, m))
        }) else {
            return;
        };
        // Reach = 3σ of the effect's blur (glass adds slack for refraction), so the blur near the
        // silhouette edge still has correct neighbours inside the cropped backdrop.
        let cs = full_view.as_coeffs();
        let scale = (cs[0] * cs[0] + cs[1] * cs[1]).sqrt() as f32;
        let reach = if is_glass {
            // Glass reaches by its frost blur (3σ) plus a modest refraction-displacement margin. (A
            // residual ~0.6% edge-ring diff vs full-viewport is intrinsic — the SDF/specular evaluated
            // at a bbox offset differs sub-pixel at the antialiased lens edge — NOT a crop-clip, so a
            // wider margin does not help; keep it tight for the GPU win.)
            let sigma = crate::vello::abi::with_scene(|live, _, _| {
                live.get(id).and_then(|n| n.glass).map_or(0.0, |g| g.total_blur_sigma() * scale)
            });
            3.0 * f64::from(sigma) + 20.0
        } else {
            3.0 * f64::from(self.gather_sigma(id, full_view, 1.0)) + 6.0
        };
        let pts = [
            full_view * Point::new(page.x0, page.y0),
            full_view * Point::new(page.x1, page.y0),
            full_view * Point::new(page.x0, page.y1),
            full_view * Point::new(page.x1, page.y1),
        ];
        let minx = pts.iter().map(|p| p.x).fold(f64::INFINITY, f64::min) - reach;
        let miny = pts.iter().map(|p| p.y).fold(f64::INFINITY, f64::min) - reach;
        let maxx = pts.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max) + reach;
        let maxy = pts.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max) + reach;
        let bx = minx.floor().clamp(0.0, f64::from(width)) as u32;
        let by = miny.floor().clamp(0.0, f64::from(height)) as u32;
        let ex = maxx.ceil().clamp(0.0, f64::from(width)) as u32;
        let ey = maxy.ceil().clamp(0.0, f64::from(height)) as u32;
        let (bw, bh) = (ex.saturating_sub(bx), ey.saturating_sub(by));
        if bw == 0 || bh == 0 {
            return;
        }

        // Crop the backdrop region [bx,bx+bw)×[by,by+bh) of `acc` into a bbox-sized surface.
        let bd = self.pool.acquire_target(
            device, bw, bh, format,
            self.raster_usage | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING,
            "wv scoped backdrop",
        );
        let bd_view = bd.create_view(&wgpu::TextureViewDescriptor::default());
        // Gather-region open stamp (A), anchored on `acc_view` which the prior fine phase wrote — the
        // read dependency forces this stamp to order AFTER that phase, so A→(next stamp) = the crop
        // blit, and A→Z (the close stamp below) is the whole gather's GPU time. Everything OUTSIDE
        // [A, Z] and the swap-blit pair is the vello document render (the residual). A's own interval
        // (whatever preceded it — a phase or the previous gather's tail) is charged to OTHER.
        if let Some(p) = self.pass_prof.as_mut() {
            p.stamp(enc, acc_view, crate::vello::graph::prof_bucket::OTHER);
        }
        self.compositor.blit(device, enc, &bd_view, (bw as f32, bh as f32), &Blit {
            src: acc_view,
            dst: (0.0, 0.0, bw as f32, bh as f32),
            src_rect: (bx as f32, by as f32, bw as f32, bh as f32),
            src_size: sz,
            alpha: 1.0,
        });

        // Build the effect over the cropped backdrop at the bbox origin/size.
        let passes = if is_glass {
            self.glass_graph(id, bw, bh, f64::from(bx), f64::from(by), full_view, 1.0)
        } else {
            Some(lower_graph(&effect_graph::background_blur_graph(self.gather_sigma(id, full_view, 1.0)), None))
        };
        let Some(passes) = passes else { return };
        let Some((rtex, rview)) = run_graph_into(
            &self.compositor, &self.glass, device, enc, &[&bd_view], &passes, bw, bh, format,
            &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views,
            self.pass_prof.as_mut(),
        ) else {
            return;
        };

        if is_glass {
            // Glass baked its SDF mask + backdrop passthrough → an opaque blit over the bbox re-lays the
            // backdrop identically and the lens inside its silhouette.
            self.compositor.blit(device, enc, acc_view, sz, &Blit {
                src: &rview,
                dst: (bx as f32, by as f32, bw as f32, bh as f32),
                src_rect: (0.0, 0.0, bw as f32, bh as f32),
                src_size: (bw as f32, bh as f32),
                alpha: 1.0,
            });
        } else {
            // Background blur: clip the blurred result to the silhouette via a bbox-LOCAL coverage mask
            // (the shape rasterised with the bbox origin subtracted), stamped over the bbox rect.
            let mask = self.pool.acquire_target(device, bw, bh, format, self.raster_usage, "wv scoped mask");
            let mask_view = mask.create_view(&wgpu::TextureViewDescriptor::default());
            let mut mscene = backend.new_scene(bw as u16, bh as u16);
            backend.build_mask(&mut mscene, Affine::translate((-(bx as f64), -(by as f64))) * root, id);
            backend.rasterize(&mscene, device, queue, enc, &mask_view, bw, bh, TRANSPARENT);
            self.compositor.blit_masked(device, enc, acc_view, sz, &MaskedBlit {
                src: &rview,
                mask: &mask_view,
                dst: (bx as f32, by as f32, bw as f32, bh as f32),
                src_rect: (0.0, 0.0, bw as f32, bh as f32),
                src_size: (bw as f32, bh as f32),
                alpha: 1.0,
            });
            self.frame_transient.push(mask);
            self.frame_transient_views.push(mask_view);
        }
        // Gather-region close stamp (Z), anchored on `acc_view` which the stamp/mask blit just wrote:
        // the read dependency orders Z after the silhouette stamp. Its interval (last effect pass →
        // here) is the silhouette stamp/masked blit → charged to STAMP.
        if let Some(p) = self.pass_prof.as_mut() {
            p.stamp(enc, acc_view, crate::vello::graph::prof_bucket::STAMP);
        }
        self.frame_transient.push(bd);
        self.frame_transient_views.push(bd_view);
        self.frame_transient.push(rtex);
        self.frame_transient_views.push(rview);
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
            crate::vello::prof::inc_step();
        }
        let _tsu = crate::vello::prof::now();
        crate::vello::prof::add_submit(crate::vello::prof::now() - _tsu);
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
            let has_custom = crate::vello::abi::with_scene(|live, _, _| {
                live.get(id).is_some_and(crate::model::Node::has_spread_shader)
            });
            if has_custom {
                continue;
            }
            // A layer-blurred shape on a backend without inline layer blur (classic) needs the direct
            // path, where `paint` runs `layer_blur_over_body` on its own surface — the shared atlas
            // packs many bodies and cannot blur one cell. (Hybrid blurs inline, so it stays atlased.)
            if !backend.blurs_layer_inline() {
                let has_layer_blur = crate::vello::abi::with_scene(|live, _, _| {
                    live.get(id).is_some_and(|n| n.blur.is_some())
                });
                if has_layer_blur {
                    continue;
                }
            }
            let (dx, dy, dw, dh) = tiling::device_rect(full_view, *clip);
            let w = (dw.ceil() as u32).max(1);
            let h = (dh.ceil() as u32).max(1);
            if w > max_dim || h > max_dim {
                continue;
            }
            cands.push((i, *write_to, ops.clone(), w, h, dx, dy));
        }
        crate::vello::prof::dbg_set(0, cands.len() as f64); // TEMP: atlas_effects candidate count
        if cands.len() < ATLAS_MIN {
            return none;
        }

        // Shelf-pack the variable-sized cells with a gap (backend-neutral geometry); the gap keeps
        // each cell's blur inside its own bounds so it can't bleed into a neighbour.
        let sizes: Vec<(u32, u32)> = cands.iter().map(|c| (c.3, c.4)).collect();
        crate::vello::prof::dbg_set(1, sizes.iter().map(|s| u64::from(s.0)).max().unwrap_or(0) as f64); // TEMP: widest cell
        crate::vello::prof::dbg_set(2, sizes.iter().map(|s| u64::from(s.1)).max().unwrap_or(0) as f64); // TEMP: tallest cell
        let Some(packing) = shelf_pack(&sizes, GAP, 2048, max_dim) else {
            crate::vello::prof::dbg_set(3, 1.0); // TEMP: shelf_pack declined
            return none;
        };
        crate::vello::prof::dbg_set(4, packing.height as f64); // TEMP: atlas height
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
            crate::vello::prof::inc_step();
        }
        let _tsu = crate::vello::prof::now();
        crate::vello::prof::add_submit(crate::vello::prof::now() - _tsu);
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
        let fuse_gathers = crate::vello::abi::fuse_gathers();
        let mut per_tile: std::collections::HashMap<TileKey, Vec<Op>> = std::collections::HashMap::new();
        let mut order: Vec<TileKey> = Vec::new();
        let mut disq: HashSet<TileKey> = HashSet::new();
        // Tiles an inline gather has already touched this walk (only tracked when `fuse_gathers`).
        // A *later* fusible op into such a tile means content sits ABOVE the gather in z — then the
        // tile genuinely can't fuse (the gather must read only the below-z content), so it is
        // disqualified at that point. If nothing fusible follows, the gather is topmost for the tile:
        // the tile fuses, and the gather runs in the main loop reading the fused result and layering
        // on top — identical pixels, one render instead of a rasterize per composite.
        let mut gather_above: HashSet<TileKey> = HashSet::new();

        for (i, step) in steps.iter().enumerate() {
            match step {
                Step::Paint { ops, clip, write_to } => {
                    if matches!(write_to.role, SurfaceRole::TileOutput) {
                        if let Some(t) = write_to.tile {
                            if fuse_gathers && gather_above.contains(&t) {
                                disq.insert(t); // fusible content above a gather → real split
                            } else {
                                if !per_tile.contains_key(&t) {
                                    order.push(t);
                                }
                                per_tile.entry(t).or_default().push(Op::Plain(i, ops.clone(), *clip));
                            }
                        }
                    }
                }
                Step::Composite { from, to, paint, rect, .. } => match to.role {
                    SurfaceRole::TileOutput => {
                        if let Some(t) = to.tile {
                            // A non-`SrcOver` blend can't fuse: the fused `Op::Spread` applies opacity
                            // only, so it would drop the blend. Disqualify → the real `composite`
                            // (dst-read blend) runs in the main loop.
                            if matches!(from.role, SurfaceRole::RasterEffectOutput(_))
                                && self.surfaces.contains_key(from)
                                && crate::vello::blend::mix_code(paint.blend.mix) == 0
                            {
                                if fuse_gathers && gather_above.contains(&t) {
                                    disq.insert(t); // spread above a gather → real split
                                } else {
                                    if !per_tile.contains_key(&t) {
                                        order.push(t);
                                    }
                                    per_tile.entry(t).or_default()
                                        .push(Op::Spread(i, *from, *rect, paint.opacity));
                                }
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
                // An **inline** gather: with `fuse_gathers`, don't disqualify — record it, so only a
                // later fusible op into the same tile (content above the gather) disqualifies. Without
                // the flag, disqualify its tiles wholesale (the old, shattering behavior).
                Step::ComposeBackdrop { .. } | Step::PaintGather { .. } => {
                    for r in step.reads().into_iter().chain(step.writes()) {
                        if let Some(t) = r.tile {
                            if fuse_gathers {
                                gather_above.insert(t);
                            } else {
                                disq.insert(t);
                            }
                        }
                    }
                }
                // A snapshot must read the tile at its z, and a layer bracket is a genuine mid-tile
                // barrier — these always disqualify.
                Step::Snapshot { .. } | Step::BeginLayer { .. } | Step::EndLayer { .. } => {
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
        //
        // The cell's ops share ONE clip layer (to the cell rect), not one clip per plain op. That is
        // load-bearing, not just tidy: `build_bodies_clipped` pushes a vello clip layer per call, so a
        // dense tile (dozens of shapes) across several fused tiles stacks hundreds of clip layers into
        // this single scene — enough to overflow vello's coarse-raster command buffer, which fails
        // *silently* (the whole atlas renders opaque black, no WebGPU validation error). One clip per
        // cell keeps the layer count at one-per-tile. It is also strictly more correct: the clip sits
        // out in the tile margin, away from content, so the bodies rasterize exactly as the main loop's
        // unclipped `build_bodies` does (verified pixel-identical), while still fencing anything oversize
        // into its own cell so a copy can't pull a neighbour's pixels. The inlined spread images live
        // inside the same clip, so they are fenced to the cell too.
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
            // Pin the transform to identity so the clip path is captured in raw scene pixels (each op
            // then sets its own transform), then wrap the whole cell in one clip.
            scene.set_transform(Affine::IDENTITY);
            scene.push_clip_layer(&cell_rect.to_path(0.1));
            for op in &per_tile[&t] {
                match op {
                    Op::Plain(_, ops, _) => backend.build_bodies(&mut scene, root_for_cell, ops),
                    Op::Spread(_, from, rect, alpha) => {
                        let (dx, dy, dw, dh) = tiling::device_rect(full_view, *rect);
                        let x0 = f64::from(cell.x) + (dx - ox + m);
                        let y0 = f64::from(cell.y) + (dy - oy + m);
                        let handle = handles[from];
                        backend.draw_inline_image(&mut scene, handle, Rect::new(x0, y0, x0 + dw, y0 + dh), *alpha);
                    }
                }
            }
            scene.pop_layer();
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
            crate::vello::prof::inc_step();
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
        let bg = crate::vello::abi::background().components;
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
                // Memory cap · declared quality floor, exactly as the inline `compose_backdrop` folds them.
                let k = tiling::resolution_cap(full_view, g.reach).min(f64::from(g.acceptable_downscale).clamp(f64::MIN_POSITIVE, 1.0));
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
            Compositor::clear(enc, &bd_view, bgc, None);
            let m = f64::from(TILE_MARGIN);
            let stages = crate::vello::abi::gather_stages();
            for cell in &packing.cells {
                if stages & 1 == 0 {
                    break;
                }
                let c = &cells[cell.index];
                for &tile in &plan.gathers[c.gi].reads {
                    // Prefer this gather's frozen snapshot of the tile if the builder scheduled one
                    // (a `needs_snapshot` gather whose backdrop later paints disturbed); otherwise the
                    // live or cached tile, which for an undisturbed gather still holds what it read.
                    let snap = SurfaceRef::snapshot(plan.gathers[c.gi].shape, tile);
                    let tile_ref = SurfaceRef::tile_ref(SurfaceRole::TileOutput, tile);
                    let Some(src_view) =
                        self.backdrop_source(&snap).or_else(|| self.backdrop_source(&tile_ref))
                    else {
                        continue;
                    };
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

            if crate::vello::abi::debug_atlas() == 1 {
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

            if crate::vello::abi::debug_atlas() == 2 {
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

            if crate::vello::abi::debug_atlas() == 3 {
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
                        Compositor::clear(enc, &to_view, [0.0, 0.0, 0.0, 0.0], None);
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

    /// The pixels to read for one backdrop source tile: this frame's live surface if the tile is being
    /// re-rendered, otherwise the tile cache's copy.
    ///
    /// A gather's sample rect routinely reaches into tiles the frame is not touching. Their content is
    /// unchanged and already on the GPU, so serving it from the cache is what lets an edit next to a
    /// lens repaint only what actually changed instead of every tile the lens happens to read.
    /// Freeze `from`'s current pixels into the snapshot surface `write_to`, so a deferred gather's
    /// batched pass reads this copy at end of frame instead of the tile it read — which later paints
    /// may have overwritten. A copy, not an alias: `from` keeps accumulating for its own later use;
    /// the snapshot is immutable. The dst is a pooled texture keyed by `write_to`, drained + recycled
    /// at the next frame boundary like every other sink surface.
    fn snapshot(
        &mut self,
        from: SurfaceRef,
        write_to: SurfaceRef,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
    ) {
        // The source pixels: a live surface this frame, or a clean tile from the cross-frame cache.
        // An empty backdrop tile has neither — nothing to freeze (the batch reads transparent there).
        let src = if let Some(s) = self.surfaces.get(&from) {
            s.texture.clone()
        } else if let Some(t) = from.tile.filter(|_| matches!(from.role, SurfaceRole::TileOutput)) {
            match self.tile_cache.get(t) {
                Some(s) => s.texture.clone(),
                None => return,
            }
        } else {
            return;
        };
        let (w, h, fmt) = (src.width(), src.height(), src.format());
        self.ensure_surface(write_to, device, w, h, fmt);
        let dst = self.surfaces[&write_to].texture.clone();
        enc.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &src,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: &dst,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        self.written.insert(write_to);
        crate::vello::prof::inc_step();
    }

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
        let _tsu = crate::vello::prof::now();
        crate::vello::prof::add_submit(crate::vello::prof::now() - _tsu);
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
        crate::vello::prof::inc_step();

        // A body-only custom shader (a spread) runs its pass over the body just rendered here,
        // replacing the effect surface with the shader's output. Backdrop-reading shaders take the
        // gather path instead and never reach this — this only fires on an isolated effect surface.
        if let SurfaceRole::RasterEffectOutput(id) = write_to.role {
            self.custom_over_body(id, write_to, device, enc, format);
            // Layer blur (`node.blur`) on a backend without inline layer blur (classic): blur the body
            // surface through `run_graph`, in place. Hybrid blurs it inline in `build_bodies`, so skip.
            if !backend.blurs_layer_inline() {
                self.layer_blur_over_body(id, write_to, device, enc, full_view, format);
            }
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
        enc: &mut wgpu::CommandEncoder,
        format: wgpu::TextureFormat,
    ) {
        let chain: Vec<(String, Vec<f32>, u32)> = crate::vello::abi::with_scene(|live, _, _| {
            live.get(id)
                .map(|n| {
                    n.spread_shaders().map(|c| (c.wgsl.clone(), c.params.clone(), c.param_vec4s)).collect()
                })
        })
        .unwrap_or_default();
        if chain.is_empty() {
            return;
        }
        let Some(surf) = self.surfaces.get(&write_to) else { return };
        let (w, h) = (surf.width, surf.height);

        // Thread each effect's output into the next: body → e0 → e1 → … The final surface replaces the
        // body. Every effect is a one-node custom graph over its input at `@binding(2)`.
        //
        // Record into the caller's frame encoder (`run_graph_into`, NOT `run_graph`): the body was just
        // rasterized into this surface *in the same `enc`* and has not been submitted yet. `run_graph`
        // submits its own encoder immediately, so the shader would sample the still-unrendered (cleared)
        // body and emit transparent pixels — the shape vanishes. Sharing `enc` makes wgpu order the
        // body-write → shader-read for free (same-encoder read-after-write barrier).
        let mut input_view = surf.view.clone();
        let mut result: Option<(wgpu::Texture, wgpu::TextureView)> = None;
        for (wgsl, params, param_vec4s) in chain {
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
            let passes = lower_graph(&effect_graph::custom_graph(u, param_vec4s), Some(&pipeline));
            let out = run_graph_into(
                &self.compositor, &self.glass, device, enc, &[&input_view], &passes, w, h, format,
                &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views, None,
            );
            let Some((tex, view)) = out else { return };
            // The previous effect's output fed this pass (recorded into `enc`), so it must outlive the
            // sink's submit — park it in the frame keepalive rather than dropping it here.
            if let Some((ptex, pview)) = result.take() {
                self.frame_transient.push(ptex);
                self.frame_transient_views.push(pview);
            }
            input_view = view.clone();
            result = Some((tex, view));
        }
        if let Some((tex, view)) = result {
            // The old body surface was this frame's shader input (read in `enc`); keep it alive until the
            // submit by parking whatever `insert` displaces.
            if let Some(old) = self.surfaces.insert(write_to, Surface { texture: tex, view, width: w, height: h }) {
                self.frame_transient.push(old.texture);
            }
        }
    }

    /// Blur a layer-blurred shape's freshly-rendered body surface **in place**, through the same
    /// `run_graph` Gaussian a background blur uses — classic's stand-in for the inline filter layer
    /// hybrid applies in its walk. `node.blur` is the layer-blur radius; the effect surface is already
    /// extent-sized (`effect_extent` grows it by `3σ`) so the blur has room to spread. No-op when the
    /// shape has no layer blur or the device sigma is negligible.
    fn layer_blur_over_body(
        &mut self,
        id: u128,
        write_to: SurfaceRef,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) {
        let Some(radius) = crate::vello::abi::with_scene(|live, _, _| live.get(id).and_then(|n| n.blur)) else {
            return;
        };
        if radius <= 0.0 {
            return;
        }
        let Some(surf) = self.surfaces.get(&write_to) else { return };
        let (w, h) = (surf.width, surf.height);
        let input_view = surf.view.clone();
        // Layer-blur radius → sigma, scaled to device and capped away from the fork's lossy
        // many-decimation regime (the same cap hybrid's `cap_sigma_to_device` applies inline).
        let sigma = crate::geometry::cap_sigma_to_device(crate::blur::radius_to_sigma(radius), full_view);
        if sigma < 0.5 {
            return;
        }
        let passes = lower_graph(&effect_graph::background_blur_graph(sigma), None);
        let out = run_graph_into(
            &self.compositor, &self.glass, device, enc, &[&input_view], &passes, w, h, format,
            &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views, None,
        );
        let Some((tex, view)) = out else { return };
        // The old body surface was this frame's blur input (read in `enc`); park whatever `insert`
        // displaces so it outlives the submit.
        if let Some(old) = self.surfaces.insert(write_to, Surface { texture: tex, view, width: w, height: h }) {
            self.frame_transient.push(old.texture);
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
        let _tsu = crate::vello::prof::now();
        crate::vello::prof::inc_submit();
        queue.submit([done.finish()]);
        crate::vello::prof::add_submit(crate::vello::prof::now() - _tsu);
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
        let alpha = paint.opacity;
        // A non-`SrcOver` blend needs the destination as an input, so it takes the dst-read path
        // (`composite_blend`) instead of the hardware-SrcOver blit. `Normal` (0) stays on the fast blit.
        let mix = crate::vello::blend::mix_code(paint.blend.mix);

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
                    Compositor::clear(enc, &to_view, [0.0, 0.0, 0.0, 0.0], None);
                }
                let buf = TILE_BUFFER as f32;
                let (dst, src_rect) = if matches!(from.role, SurfaceRole::RasterEffectOutput(_)) {
                    // Effect surface → placed at its device position relative to the tile.
                    let (ox, oy) = tiling::tile_device_origin(tile, full_view);
                    let m = f64::from(TILE_MARGIN);
                    let (dx, dy, dw, dh) = tiling::device_rect(full_view, rect);
                    (
                        ((dx - ox + m) as f32, (dy - oy + m) as f32, dw as f32, dh as f32),
                        (0.0, 0.0, src_size.0, src_size.1),
                    )
                } else {
                    // Scope fold: a tile-aligned buffer → the same tile's buffer, 1:1.
                    ((0.0, 0.0, buf, buf), (0.0, 0.0, src_size.0, src_size.1))
                };
                if mix != 0 {
                    // Non-`SrcOver`: copy this tile's current backdrop into the scratch, then blend
                    // `src` over it (W3C `mix`) and replace `to`'s rect — one op against the real,
                    // complete tile backdrop, so a `Multiply` etc. matches at every tile boundary.
                    let backdrop = self.blend_backdrop(to, device, enc, format);
                    self.compositor.composite_blend(
                        device,
                        enc,
                        &to_view,
                        (buf, buf),
                        &BlendComposite { src: &src_view, backdrop: &backdrop, dst, src_rect, src_size, alpha, mix },
                    );
                } else {
                    self.compositor.blit(
                        device,
                        enc,
                        &to_view,
                        (buf, buf),
                        &Blit { src: &src_view, dst, src_rect, src_size, alpha },
                    );
                }
            }
            _ => {}
        }
        crate::vello::prof::inc_step();
    }

    /// Copy tile buffer `to`'s current content into the reusable `blend_scratch` and return a view of
    /// it, so a `composite_blend` can sample the destination it is about to overwrite (WebGL2 forbids
    /// sampling the live render target). The scratch is `TILE_BUFFER²`, kept across frames, and reused
    /// in order by consecutive blend composites in one encoder.
    fn blend_backdrop(
        &mut self,
        to: SurfaceRef,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        format: wgpu::TextureFormat,
    ) -> wgpu::TextureView {
        let matches_fmt = matches!(&self.blend_scratch, Some((_, f)) if *f == format);
        if !matches_fmt {
            let usage = wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::RENDER_ATTACHMENT;
            let tex = self.pool.acquire(
                device,
                PoolKey { w: TILE_BUFFER, h: TILE_BUFFER, format, usage: usage.bits() },
                "blend scratch",
            );
            self.blend_scratch = Some((tex, format));
        }
        let scratch = &self.blend_scratch.as_ref().expect("blend scratch just ensured").0;
        enc.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.surfaces[&to].texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: scratch,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d { width: TILE_BUFFER, height: TILE_BUFFER, depth_or_array_layers: 1 },
        );
        scratch.create_view(&wgpu::TextureViewDescriptor::default())
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
        acceptable_downscale: f64,
        tile_mode: TileMode,
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
        // Declared quality floor: the effect said it tolerates rendering at `acceptable_downscale` — take the
        // free downscale on top of the memory cap. `1.0` (glass/custom default, every background blur)
        // is a no-op, so sharp-output effects are untouched; a soft/zoom lens renders cheaper here.
        k = k.min(acceptable_downscale.clamp(f64::MIN_POSITIVE, 1.0));
        let w = ((bw * k).ceil() as u32).clamp(1, 4096);
        let h = ((bh * k).ceil() as u32).clamp(1, 4096);
        self.ensure_surface(write_to, device, w, h, format);
        self.written.insert(write_to);
        self.backdrop_origin.insert(write_to, (bdx, bdy));
        self.backdrop_scale.insert(write_to, k);
        let bd_view = self.surfaces[&write_to].view.clone();
        // Clear colour = "what is behind this gather's scope" where no source tile paints:
        // - A **top-level** gather (reads `TileOutput` tiles) sits over the page, so unpainted sample
        //   area is the page background — a background blur fades to it at the canvas edge.
        // - A **scoped** gather (reads `ScopeOf` tiles of an isolated group/frame) has an isolated
        //   layer behind it, which is *transparent* where the scope has no content. Clearing to the
        //   page background instead would paint the empty-scope region (e.g. a lens crossing past its
        //   scope's border) as an opaque page-coloured block, hiding the real canvas content the
        //   transparent lens should reveal. So a scoped backdrop clears transparent.
        //
        // `any` (not `all`): a top-level gather has *no* `ScopeOf` refs. A scoped gather has some, but
        // its sample rect can also reach off-canvas tiles that fall back to `TileOutput` — those are
        // transparent regardless, so a single `ScopeOf` ref is the reliable "this gather is scoped" tell.
        //
        // For a scoped gather the clear colour is the effect's `TileMode` — what the lens shows past its
        // scope's content: `Decal` transparent (canvas shows through), `Black` opaque black. `Clamp`
        // clears transparent here too, then a `clamp_fill` pass after the tile blits extends the scope's
        // edge over the transparent surround (below).
        let scoped = read_from.iter().any(|r| matches!(r.role, SurfaceRole::ScopeOf(_)));
        let clear = if scoped {
            match tile_mode {
                TileMode::Decal | TileMode::Clamp => [0.0, 0.0, 0.0, 0.0],
                TileMode::Black => [0.0, 0.0, 0.0, 1.0],
            }
        } else {
            let bg = crate::vello::abi::background().components;
            [f64::from(bg[0]), f64::from(bg[1]), f64::from(bg[2]), f64::from(bg[3])]
        };
        Compositor::clear(enc, &bd_view, clear, None);
        let m = TILE_MARGIN as f32;
        let ts = TILE_SIZE as f32;
        let kf = k as f32;
        for src_ref in read_from {
            let Some(tile) = src_ref.tile else { continue };
            let Some(src_view) = self.backdrop_source(src_ref) else { continue };
            let (ox, oy) = tiling::tile_device_origin(tile, full_view);
            // The tile's full-zoom centre → its place in the reduced backdrop (down-sampled by `k`).
            // Snap each tile's start AND end to integer texels of the reduced backdrop: with `k < 1`,
            // `ts·k` is fractional, so placing tiles at `(ox-bdx)·k` with width `ts·k` leaves sub-pixel
            // gaps at every tile boundary — the blur then smears those clear-colour gaps into faint
            // vertical/horizontal seams across the gather. Rounding both edges makes adjacent tiles
            // share the exact same integer boundary (`round((ox+ts-bdx)·k) == round((oxₙ-bdx)·k)`), so
            // the reduced backdrop tiles seamlessly. At `k == 1` this is a harmless whole-backdrop snap.
            let x0 = (((ox - bdx) as f32) * kf).round();
            let y0 = (((oy - bdy) as f32) * kf).round();
            let x1 = (((ox - bdx) as f32 + ts) * kf).round();
            let y1 = (((oy - bdy) as f32 + ts) * kf).round();
            self.compositor.blit(
                device,
                enc,
                &bd_view,
                (w as f32, h as f32),
                &Blit {
                    src: &src_view,
                    dst: (x0, y0, x1 - x0, y1 - y0),
                    src_rect: (m, m, ts, ts),
                    src_size: (TILE_BUFFER as f32, TILE_BUFFER as f32),
                    alpha: 1.0,
                },
            );
        }

        // `TileMode::Clamp`: extend the scope's content over the transparent surround so a lens
        // overhanging its scope reads the clamped edge, not nil. The clamp rect is the scope
        // container's own page bounds (read live from the `ScopeOf(id)` ref) — its fill region — mapped
        // into this backdrop's UV space and inset a little so the clamp lands on the fill, not the
        // container's own border stroke. Runs once here into a fresh texture that replaces the backdrop.
        if scoped && matches!(tile_mode, TileMode::Clamp) {
            let scope_id = read_from.iter().find_map(|r| match r.role {
                SurfaceRole::ScopeOf(sid) => Some(sid),
                _ => None,
            });
            let content_page = scope_id.and_then(|sid| {
                crate::vello::abi::with_scene(|live, _, mods| {
                    live.get(sid).map(|n| {
                        let m = mods.get(&sid).copied().unwrap_or(Affine::IDENTITY);
                        crate::schedule::page_bounds(n, m)
                    })
                })
            });
            if let Some(cr) = content_page {
                let (cx, cy, cw, ch) = tiling::device_rect(full_view, cr);
                // device → this backdrop's normalized UV (origin `(bdx,bdy)`, scaled by `k`).
                let to_u = |dx: f64| (((dx - bdx) * k) / f64::from(w)) as f32;
                let to_v = |dy: f64| (((dy - bdy) * k) / f64::from(h)) as f32;
                let inset_u = (4.0 * k / f64::from(w)) as f32;
                let inset_v = (4.0 * k / f64::from(h)) as f32;
                let rect = [
                    to_u(cx) + inset_u,
                    to_v(cy) + inset_v,
                    to_u(cx + cw) - inset_u,
                    to_v(cy + ch) - inset_v,
                ];
                // Only fill when the content rect is non-degenerate after the inset.
                if rect[0] < rect[2] && rect[1] < rect[3] {
                    let usage = wgpu::TextureUsages::RENDER_ATTACHMENT
                        | wgpu::TextureUsages::TEXTURE_BINDING
                        | wgpu::TextureUsages::COPY_DST
                        | wgpu::TextureUsages::COPY_SRC
                        | self.raster_usage;
                    let filled = self.pool.acquire(device, PoolKey { w, h, format, usage: usage.bits() }, "clamp fill");
                    let filled_view = filled.create_view(&wgpu::TextureViewDescriptor::default());
                    self.glass.clamp_fill(device, enc, &filled_view, &bd_view, (w as f32, h as f32), rect);
                    if let Some(old) = self.surfaces.insert(write_to, Surface { texture: filled, view: filled_view, width: w, height: h }) {
                        self.frame_transient.push(old.texture);
                    }
                }
            }
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

        let is_glass = crate::vello::abi::with_scene(|live, _, _| live.get(id).is_some_and(|n| n.glass.is_some()));
        let is_custom = crate::vello::abi::with_scene(|live, _, _| live.get(id).is_some_and(|n| n.gather_shader().is_some()));

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
            // The gather graph runs in its OWN encoder (`genc`), separate from `enc`, so the
            // `compose_backdrop` blits that filled this backdrop (recorded into `enc`) must be flushed
            // first — otherwise the gather reads stale pixels (a recycled backdrop texture holding the
            // pre-edit frame). The batched atlas path does the identical flush; the inline path must not
            // rely on a submit-batch boundary happening to fall between the compose and the gather (at
            // the default batch of 32 it does not, and the gather freezes on incremental edits).
            Self::submit_batch(enc, device, queue, backend);
            let backdrop_view = self.surfaces[&backdrop].view.clone();
            // Pool the graph's intermediate pass surfaces through the sink's persistent pool +
            // `frame_transient` keepalive (drained back to the pool next frame), instead of the fresh
            // throwaway pool `run_graph` builds per call — which re-`create_texture`d ~4 surfaces for
            // every gather every frame (the `poolMiss` the whole-viewport path already avoids). The
            // graph still records into its own encoder submitted right after the flush above, so the
            // compose→gather ordering the freeze fix relies on is unchanged.
            let mut genc = device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("inline gather graph") });
            let out = run_graph_into(
                &self.compositor, &self.glass, device, &mut genc, &[&backdrop_view], &passes, bw, bh, format,
                &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views, None,
            );
            queue.submit([genc.finish()]);
            let Some((tex, view)) = out else { return };
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
            Compositor::clear(enc, &to_view, [0.0, 0.0, 0.0, 0.0], None);
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

    /// Draw one non-inset drop shadow of a **path** shape as a blurred silhouette, composited (SrcOver)
    /// into the tile scope behind the body. Classic vello has no inline arbitrary-silhouette blur, so:
    /// render the offset silhouette (in the shadow's colour) sharp into an extent-sized surface, blur it
    /// with the same `run_graph` Gaussian a background blur uses, then blit the result into the tile.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn paint_path_shadow<B: RasterBackend>(
        &mut self,
        shape: u128,
        shadow: usize,
        sigma: f32,
        extent: Rect,
        write_to: SurfaceRef,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        root: Affine,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) {
        let Some(tile) = write_to.tile else { return };
        // The extent's device rect sizes the silhouette surface.
        let (edx, edy, edw, edh) = tiling::device_rect(full_view, extent);
        let w = edw.ceil().max(1.0) as u32;
        let h = edh.ceil().max(1.0) as u32;
        // A pathological size (huge shape at deep zoom) would OOM; bound it and drop rather than crash.
        const MAX_SHADOW: u32 = 4096;
        if w > MAX_SHADOW || h > MAX_SHADOW {
            return;
        }

        // 1) Sharp offset silhouette, extent's top-left mapped to (0, 0).
        let sil = self.pool.acquire_target(device, w, h, format, self.raster_usage, "path shadow silhouette");
        let sil_view = sil.create_view(&wgpu::TextureViewDescriptor::default());
        let root_for_sil = Affine::translate((-edx, -edy)) * root;
        let mut sscene = backend.new_scene(w as u16, h as u16);
        backend.build_shadow_silhouette(&mut sscene, root_for_sil, shape, shadow, false, true);
        backend.rasterize(&sscene, device, queue, enc, &sil_view, w, h, TRANSPARENT);

        // 2) Blur (device sigma = page sigma × zoom). A near-zero sigma keeps the sharp silhouette.
        let c = full_view.as_coeffs();
        let scale = (c[0] * c[0] + c[1] * c[1]).sqrt() as f32;
        let device_sigma = sigma * scale;
        let blurred_view = if device_sigma >= 0.5 {
            let passes = lower_graph(&effect_graph::background_blur_graph(device_sigma), None);
            let Some((_tex, view)) = run_graph_into(
                &self.compositor, &self.glass, device, enc, &[&sil_view], &passes, w, h, format,
                &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views, None,
            ) else {
                self.frame_transient.push(sil);
                return;
            };
            view
        } else {
            sil_view.clone()
        };
        self.frame_transient.push(sil);
        self.frame_transient_views.push(sil_view);

        // 3) SrcOver the blurred shadow into the tile scope, at the extent's device position ∩ this tile.
        let (ox, oy) = tiling::tile_device_origin(tile, full_view);
        let ts = f64::from(TILE_SIZE);
        let ix0 = edx.max(ox);
        let iy0 = edy.max(oy);
        let ix1 = (edx + edw).min(ox + ts);
        let iy1 = (edy + edh).min(oy + ts);
        if ix1 <= ix0 || iy1 <= iy0 {
            return;
        }
        self.ensure_surface(write_to, device, TILE_BUFFER, TILE_BUFFER, format);
        let to_view = self.surfaces[&write_to].view.clone();
        if self.written.insert(write_to) {
            Compositor::clear(enc, &to_view, [0.0, 0.0, 0.0, 0.0], None);
        }
        let m = f64::from(TILE_MARGIN);
        let buf = (TILE_BUFFER as f32, TILE_BUFFER as f32);
        let dst = ((ix0 - ox + m) as f32, (iy0 - oy + m) as f32, (ix1 - ix0) as f32, (iy1 - iy0) as f32);
        let src_rect = ((ix0 - edx) as f32, (iy0 - edy) as f32, (ix1 - ix0) as f32, (iy1 - iy0) as f32);
        let src_size = (w as f32, h as f32);
        self.compositor.blit(device, enc, &to_view, buf, &Blit { src: &blurred_view, dst, src_rect, src_size, alpha: 1.0 });
    }

    /// Draw one **inner** (inset) shadow of a non-box shape as a blurred-silhouette band, composited
    /// (SrcOver) into the tile scope OVER the body (this step is scheduled after the body). Build the band
    /// in textures: flood the shape's silhouette in the shadow colour, render the same silhouette OFFSET
    /// and blur it, then punch that out of the flood with a Porter-Duff `DestOut` — colour survives only
    /// in the inner band on the offset side. The non-box analogue of the inline `draw_box_inner_shadows`.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn paint_inner_shadow<B: RasterBackend>(
        &mut self,
        shape: u128,
        shadow: usize,
        sigma: f32,
        extent: Rect,
        write_to: SurfaceRef,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        root: Affine,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) {
        let Some(tile) = write_to.tile else { return };
        let (edx, edy, edw, edh) = tiling::device_rect(full_view, extent);
        let w = edw.ceil().max(1.0) as u32;
        let h = edh.ceil().max(1.0) as u32;
        const MAX_SHADOW: u32 = 4096;
        if w > MAX_SHADOW || h > MAX_SHADOW {
            return;
        }
        let root_for_sil = Affine::translate((-edx, -edy)) * root;
        let full = (w as f32, h as f32);

        // 1) The flood: shadow-coloured silhouette at the shape's own position (inset, no offset).
        let flood = self.pool.acquire_target(device, w, h, format, self.raster_usage, "inner shadow flood");
        let flood_view = flood.create_view(&wgpu::TextureViewDescriptor::default());
        let mut fscene = backend.new_scene(w as u16, h as u16);
        backend.build_shadow_silhouette(&mut fscene, root_for_sil, shape, shadow, true, false);
        backend.rasterize(&fscene, device, queue, enc, &flood_view, w, h, TRANSPARENT);

        // 2) The punch: same silhouette OFFSET, then blurred.
        let punch = self.pool.acquire_target(device, w, h, format, self.raster_usage, "inner shadow punch");
        let punch_view = punch.create_view(&wgpu::TextureViewDescriptor::default());
        let mut pscene = backend.new_scene(w as u16, h as u16);
        backend.build_shadow_silhouette(&mut pscene, root_for_sil, shape, shadow, true, true);
        backend.rasterize(&pscene, device, queue, enc, &punch_view, w, h, TRANSPARENT);

        let c = full_view.as_coeffs();
        let scale = (c[0] * c[0] + c[1] * c[1]).sqrt() as f32;
        let device_sigma = sigma * scale;
        if device_sigma >= 0.5 {
            let passes = lower_graph(&effect_graph::background_blur_graph(device_sigma), None);
            let Some((ptex, pview)) = run_graph_into(
                &self.compositor, &self.glass, device, enc, &[&punch_view], &passes, w, h, format,
                &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views, None,
            ) else {
                self.frame_transient.push(flood);
                self.frame_transient.push(punch);
                return;
            };
            // 3) Punch the blurred offset silhouette out of the flood: flood = flood·(1 − punch.a).
            self.compositor.blit_dstout(device, enc, &flood_view, full, &Blit {
                src: &pview, dst: (0.0, 0.0, full.0, full.1), src_rect: (0.0, 0.0, full.0, full.1), src_size: full, alpha: 1.0,
            });
            self.frame_transient.push(ptex);
            self.frame_transient_views.push(pview);
        } else {
            self.compositor.blit_dstout(device, enc, &flood_view, full, &Blit {
                src: &punch_view, dst: (0.0, 0.0, full.0, full.1), src_rect: (0.0, 0.0, full.0, full.1), src_size: full, alpha: 1.0,
            });
        }
        self.frame_transient.push(punch);
        self.frame_transient_views.push(punch_view);

        // 4) SrcOver the band into the tile scope, at the extent's device position ∩ this tile.
        let (ox, oy) = tiling::tile_device_origin(tile, full_view);
        let ts = f64::from(TILE_SIZE);
        let ix0 = edx.max(ox);
        let iy0 = edy.max(oy);
        let ix1 = (edx + edw).min(ox + ts);
        let iy1 = (edy + edh).min(oy + ts);
        if ix1 <= ix0 || iy1 <= iy0 {
            self.frame_transient.push(flood);
            self.frame_transient_views.push(flood_view);
            return;
        }
        self.ensure_surface(write_to, device, TILE_BUFFER, TILE_BUFFER, format);
        let to_view = self.surfaces[&write_to].view.clone();
        if self.written.insert(write_to) {
            Compositor::clear(enc, &to_view, [0.0, 0.0, 0.0, 0.0], None);
        }
        let m = f64::from(TILE_MARGIN);
        let buf = (TILE_BUFFER as f32, TILE_BUFFER as f32);
        let dst = ((ix0 - ox + m) as f32, (iy0 - oy + m) as f32, (ix1 - ix0) as f32, (iy1 - iy0) as f32);
        let src_rect = ((ix0 - edx) as f32, (iy0 - edy) as f32, (ix1 - ix0) as f32, (iy1 - iy0) as f32);
        let src_size = (w as f32, h as f32);
        self.compositor.blit(device, enc, &to_view, buf, &Blit { src: &flood_view, dst, src_rect, src_size, alpha: 1.0 });
        self.frame_transient.push(flood);
        self.frame_transient_views.push(flood_view);
    }

    /// Device-space Gaussian sigma for a background blur (render-core's [`effect_graph::background_blur_sigma`]):
    /// the shape's page-space radius mapped through the *effective* view scale (`zoom · k`). Using the
    /// capped scale is what makes the reduced-res backdrop's blur reach fit one tile —
    /// `3σ_device ≤ TILE_SIZE` by construction of `k`.
    fn gather_sigma(&self, id: u128, full_view: Affine, k: f64) -> f32 {
        let radius = crate::vello::abi::with_scene(|live, _, _| live.get(id).and_then(|n| n.background_blur));
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
        let (g, geom) = crate::vello::abi::with_scene(|live, _, modifiers| {
            live.get(id).and_then(|n| {
                n.glass.map(|g| {
                    // The lens must sit where the shape is drawn *this frame*, including the live drag
                    // modifier — the backdrop it refracts is assembled at `page_bounds(node, m)` too. Using
                    // the committed bounds left the lens at the pre-drag spot while the backdrop moved, so
                    // the refraction fell outside and the glass looked like a flat frost mid-drag.
                    let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
                    let page = crate::schedule::page_bounds(n, m);
                    // Corner radius rides in the shape's own space; scale it by the transform so a
                    // scale-drag keeps the rounding proportional to the (now page-space) width/height.
                    let [a, b, c, d, _, _] = (m * n.effective_transform()).as_coeffs();
                    let scale = ((a * a + b * b).sqrt() + (c * c + d * d).sqrt()) / 2.0;
                    let geom = GlassGeometry {
                        center: page.center(),
                        width: page.width(),
                        height: page.height(),
                        corner_radius: n.corners.map_or(0.0, |r| r.top_left) * scale,
                        is_circle: n.kind == crate::model::ShapeKind::Circle,
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
        let (wgsl, params, param_vec4s) = crate::vello::abi::with_scene(|live, _, _| {
            live.get(id)
                .and_then(|n| n.gather_shader().map(|c| (c.wgsl.clone(), c.params.clone(), c.param_vec4s)))
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
        Some(lower_graph(&effect_graph::custom_graph(u, param_vec4s), Some(&pipeline)))
    }
}
