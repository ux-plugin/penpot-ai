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

use std::collections::{HashMap, HashSet};
use std::hash::Hash;

use crate::atlas::{pack_grid, shelf_pack};
use crate::model::TileMode;
use crate::peniko::color::palette::css::TRANSPARENT;
use crate::peniko::Color;
use crate::effect::Source;
use crate::schedule::{
    first_write_paints, GatherPlan, LayerPaint, PaintOp, Schedule, Step, SurfaceRef, SurfaceRole,
};
#[cfg(feature = "tiled-scheduler")]
use crate::tile_cache::TileCache;
use crate::tiling::{self, TileKey, TILE_BUFFER, TILE_MARGIN, TILE_SIZE};
use crate::vello::rasterize::RasterBackend;
use vello_common::kurbo::{Affine, Rect, Shape};
use vello_example_scenes::RenderingContext;

use crate::vello::blend::{BlendComposite, Blit, Compositor, MaskedBlit};
use crate::vello::units::UnitPipeline;
use crate::effect_graph::{self, LensGeometry};

use crate::vello::graph::{lower_graph, new_target_with_usage, run_graph, run_graph_into, Pass};

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


/// Whether the instanced stages can express `graph`. The implemented stage set today is exactly
/// `{Blur}` at native scale, one node deep, inside the separable cap — everything else keeps the
/// per-shape path. Growing the batch vocabulary means widening THIS match (plus one stage
/// implementation), not touching the planner.
/// What the instanced stage set can express for one **lowered** chain, plus the parameters those
/// stages need. `None` keeps the shape on its own pass chain.
///
/// One predicate for both stage families, because the question is the same one: can the instanced
/// stages run this chain? What separates the two answers is the chain's head — a sampling unit needs
/// the lens stages, a pointwise-only chain is a stamp. Splitting that decision across two functions
/// is what let a chain belong to neither.
#[derive(Debug, Clone, PartialEq)]
enum BatchShape {
    /// Coverage through an optional blur and then a pointwise tail: drop shadows, inner-shadow
    /// floods and punches, plain bodies. `ops` is that tail verbatim — the batch binds its uniform
    /// per cell, so the tail is not restricted to units this enum knows the names of.
    Stamp { sigma: f32, linear: bool, ops: Vec<crate::vello::units::UnitOp> },
    /// A sampling head, an optional blur, and a pointwise tail — the lens stages.
    Lens { head: crate::vello::units::UnitOp, tail: Vec<crate::vello::units::UnitOp>, sigma: f32 },
}


/// Trace a DAG node's input chain back to the coverage `Rasterize` it rests on, or `None` if it rests on
/// the backdrop (a `Reload`, or no input). This is what tells the edge-driven executor where a pass's
/// `base_in` comes from: `Some(r)` → the silhouette `node_scratch[r]` (a shadow); `None` → the
/// accumulator backdrop (a background blur, a lens/frost link).
fn dag_base_rasterize(dag: &crate::vello::frame_dag::FrameDag, mut node: usize) -> Option<usize> {
    use crate::vello::units::UnitOp;
    loop {
        match dag.nodes[node].op {
            UnitOp::Rasterize(_) => return Some(node),
            UnitOp::Reload => return None,
            _ => node = *dag.nodes[node].inputs.first()?,
        }
    }
}

/// Whether a `Units` pass leads with a sampling head, which is what sends a chain to the lens
/// stages rather than the stamp stages.
fn units_head(p: &Pass) -> Option<&crate::vello::units::UnitOp> {
    use crate::vello::units::UnitOp;
    match p.units.first() {
        Some(op @ (UnitOp::Warp(_) | UnitOp::Scatter(_))) => Some(op),
        _ => None,
    }
}

fn batch_admit(passes: &[Pass]) -> Option<BatchShape> {
    use crate::vello::units::UnitOp;
    use crate::vello::graph::BLUR_MAX_SIGMA;

    // A lens: sampling head, optionally a blur, then the pointwise tail. The head's and the blur's
    // scales must agree — the batch packs one cell that serves both resolutions.
    if let Some(head) = passes.first().and_then(units_head) {
        return match passes {
            [one] => (one.scale >= 0.999)
                .then(|| BatchShape::Lens { head: head.clone(), tail: one.units[1..].to_vec(), sigma: 0.0 }),
            [w, b, t] => {
                // The middle pass must be a single unblurred-in-gamma-space `Blur` barrier, and the
                // tail a fused units run (not a lone barrier).
                let [UnitOp::Blur { sigma, linear: false, .. }] = b.units.as_slice() else { return None };
                if t.units.len() == 1 && t.units[0].is_barrier() {
                    return None;
                }
                if *sigma > BLUR_MAX_SIGMA || t.scale < 0.999 || (w.scale - b.scale).abs() > 1e-6 {
                    return None;
                }
                Some(BatchShape::Lens { head: head.clone(), tail: t.units.clone(), sigma: *sigma })
            }
            _ => None,
        };
    }

    // Otherwise a stamp: at most one blur, and a pointwise tail. The tail is not filtered by NAME.
    // A unit declines for one of two structural reasons only — it samples (a head belongs to a lens,
    // not a stamp), or it reads a field the batch module did not compile.
    let (mut sigma, mut linear, mut blurs) = (0.0_f32, false, 0usize);
    let mut tail: Vec<UnitOp> = Vec::new();
    for p in passes {
        if p.scale < 0.999 {
            return None;
        }
        match p.units.as_slice() {
            [UnitOp::Blur { sigma: s, linear: l, .. }] => {
                blurs += 1;
                if blurs > 1 || *s > BLUR_MAX_SIGMA {
                    return None;
                }
                sigma = *s;
                linear = *l;
            }
            ops => {
                for op in ops {
                    match op {
                        // A sampling head this far into the chain is a lens that did not lead with
                        // one; the stamp arms have no head to run it as.
                        UnitOp::Warp(_) | UnitOp::Scatter(_) => return None,
                        // Both measure a field. The batch compiles ONE field program, so a chain
                        // measuring its own cannot be evaluated by these arms until the program
                        // travels per cell the way the uniform does.
                        UnitOp::Shade(_) | UnitOp::MaskMix(_) => return None,
                        // A barrier inside a fused run cannot occur (fuse cuts at one), but a stamp
                        // arm could not run it regardless.
                        UnitOp::Blur { .. } => return None,
                        _ => tail.push(op.clone()),
                    }
                }
            }
        }
    }
    Some(BatchShape::Stamp { sigma, linear, ops: tail })
}

/// Rasterize a batch of shape silhouettes into `target` as a stencil for effect masking. Each item
/// is `(shape_id, transform)`, where the transform places that shape's silhouette in the target's
/// space — an atlas slot, a scaled cell, or a whole surface. This is the skeleton (new scene, one
/// `build_mask` per item, one flush) shared by the batch mask atlas, the per-packing-cell masks, the
/// single-cell gather mask, and the per-shape composite tail, so they cannot drift in how a
/// silhouette scene is built and flushed. What differs per site — the transform and which shapes are
/// selected — is the iterator the caller passes; the guard deciding WHETHER to run stays at the call
/// site (an empty iterator still validly clears the target).
fn rasterize_masks<B: RasterBackend>(
    backend: &mut B,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    enc: &mut wgpu::CommandEncoder,
    target: &wgpu::TextureView,
    width: u32,
    height: u32,
    clear: Color,
    masks: impl IntoIterator<Item = (u128, Affine)>,
) {
    let mut scene = backend.new_scene(width as u16, height as u16);
    for (id, transform) in masks {
        backend.build_mask(&mut scene, transform, id);
    }
    backend.rasterize(&scene, device, queue, enc, target, width, height, clear);
}

/// A marker's reach clamped to the FRAME.
///
/// The accumulator is taller than the frame whenever a source strip sits below it, and the marker
/// is drawn into that taller scene — so an unclamped reach bins the marker into strip tiles. Those
/// tiles' command lists are then split into rounds, which defers the `Copy` layers that isolate the
/// sources to the last window, long after the effects have already read them. Effects only ever
/// composite into the frame, so cutting the reach at the frame's edge loses nothing.
fn wv_clamp_reach(r: [f32; 4], width: u32, height: u32) -> [f32; 4] {
    [r[0].max(0.0), r[1].max(0.0), r[2].min(width as f32), r[3].min(height as f32)]
}


/// Distinct custom-shader render pipelines kept before the cache is dropped. Keyed by WGSL source
/// hash, so live-editing a shader (a new source every keystroke) would otherwise grow this without
/// bound. A pipeline recompiles cheaply on the next use, so clearing when full is a fine cap.

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

    /// Approximate GPU footprint of one texture with this key, for the pool budget.
    fn approx_bytes(&self) -> u64 {
        let bpp = match self.format {
            wgpu::TextureFormat::Rgba16Float => 8,
            wgpu::TextureFormat::R32Uint | wgpu::TextureFormat::R32Float => 4,
            _ => 4,
        };
        u64::from(self.w) * u64::from(self.h) * bpp
    }
}

/// Effect-node kinds the whole-viewport driver dispatches on. `FX_GATHER` is a pure gather; a
/// `FX_STACK` node carries a non-box shadow or a replaced body, so it is excluded from the shared
/// walk and its whole ordered stack — drops, backdrop, body, inners — rides fine as unit marks.
const FX_GATHER: u8 = 0;
const FX_STACK: u8 = 1;

/// Vello's fine-rasterization tile, in device pixels. Regions that must not influence one another
/// have to be tile-disjoint, because `fine` resolves a whole tile at a time.
const TILE_PX: u32 = 16;

/// Per-key free list buckets are capped so a burst of one-off sizes can't grow the pool without bound.
const MAX_POOL_PER_KEY: usize = 32;

/// Total bytes the pool may hold across ALL keys. The per-key cap alone cannot bound the pool:
/// continuous zoom re-sizes every effect surface every frame, minting an unbounded stream of new
/// keys — at 4K with hundreds of effect nodes that leaked VRAM without bound (the user-visible
/// "memory keeps growing"), ending in a lost device (native crash; garbled tiles in the browser,
/// which clamps instead of faulting). Crossing the budget evicts whole buckets until back under.
const MAX_POOL_BYTES: u64 = 512 * 1024 * 1024;

/// A free-list of reusable GPU textures keyed by [`PoolKey`]. Fed at frame boundaries (drained before
/// this frame renders) and on tile eviction/replacement.
/// Handing a texture back out as a fresh render target needs no extra synchronisation: a target is
/// always fully overwritten (its render pass clears or the effect graph writes every texel), and wgpu's
/// automatic hazard tracking serialises the write-after-read against any still-pending prior use —
/// in-encoder for the collapsed path, cross-submit on the same queue for the per-segment path.
#[derive(Default)]
pub(crate) struct TexturePool {
    free: HashMap<PoolKey, Vec<wgpu::Texture>>,
    /// Approximate bytes currently held in `free` (see [`PoolKey::approx_bytes`]).
    held_bytes: u64,
}

impl TexturePool {
    /// A texture matching `key`, reused from the free list or freshly created. A real allocation is
    /// timed into the `tex` profiler bucket, so `texn` counts only genuine `create_texture` calls —
    /// the metric the pool is meant to drive down.
    pub(crate) fn acquire(&mut self, device: &wgpu::Device, key: PoolKey, label: &str) -> wgpu::Texture {
        if let Some(t) = self.free.get_mut(&key).and_then(Vec::pop) {
            self.held_bytes = self.held_bytes.saturating_sub(key.approx_bytes());
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
        let key = PoolKey::of(&texture);
        let bytes = key.approx_bytes();
        let bucket = self.free.entry(key).or_default();
        if bucket.len() < MAX_POOL_PER_KEY {
            bucket.push(texture);
            self.held_bytes += bytes;
        }
        if self.held_bytes > MAX_POOL_BYTES {
            self.evict_to_budget();
        }
    }

    /// Drop whole buckets (smallest textures first, so frequently-reused big viewport surfaces
    /// survive) until the pool is back under [`MAX_POOL_BYTES`].
    fn evict_to_budget(&mut self) {
        let mut keys: Vec<PoolKey> = self.free.keys().copied().collect();
        keys.sort_by_key(PoolKey::approx_bytes);
        for key in keys {
            if self.held_bytes <= MAX_POOL_BYTES {
                break;
            }
            if let Some(bucket) = self.free.remove(&key) {
                self.held_bytes =
                    self.held_bytes.saturating_sub(key.approx_bytes() * bucket.len() as u64);
            }
        }
    }
}


static ENCODER_PASSES: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Count render/compute passes recorded into caller-owned encoders. On Metal, EVERY pass inside a
/// wgpu command encoder opens its own hal command buffer (plus a wgpu-internal "Pre Pass" twin),
/// and none of them retire until that encoder is submitted — against a hard device budget of 4096
/// outstanding buffers. A whole-viewport frame that folds thousands of effect passes into one
/// encoder loses the device mid-encode, so the frame loop reads this counter and flushes the
/// encoder (submit + fresh encoder) before the pile-up reaches the cap.
pub(crate) fn note_passes(n: u32) {
    ENCODER_PASSES.fetch_add(n, std::sync::atomic::Ordering::Relaxed);
}

/// Monotonic total of [`note_passes`] increments; callers diff snapshots to measure pressure.
#[unsafe(no_mangle)]
pub extern "C" fn wv_passes_recorded() -> u32 {
    ENCODER_PASSES.load(std::sync::atomic::Ordering::Relaxed)
}

pub(crate) fn passes_recorded() -> u32 {
    ENCODER_PASSES.load(std::sync::atomic::Ordering::Relaxed)
}

/// Flush the whole-viewport frame encoder once this many passes piled up since the last flush.
/// Each pass costs ~2 outstanding Metal command buffers, so 768 keeps a comfortable margin under
/// the 4096 device budget even with the front-end's own uncounted dispatches.
const WV_PASS_FLUSH_BUDGET: u32 = 768;

/// The scheduler's GPU production sink. Owns the per-frame surface map and the SrcOver compositor.
pub struct Sink {
    compositor: Compositor,
    unit_pipeline: UnitPipeline,
    /// Instanced batch pipelines (blur H/V + per-round composite), built on first batched frame.
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
    /// reads it to scale the sigma / lens geometry and the stamp's source rect to match.
    backdrop_scale: HashMap<SurfaceRef, f64>,

    /// The cross-frame **tile cache**: each *processed* tile keyed by `TileKey`, so a pan re-renders
    /// only the newly-exposed tiles and blits the rest from here. The invalidation + eviction policy
    /// (scale change → drop all, dirty rect → drop covered, LRU beyond budget) is backend-neutral and
    /// lives in [`TileCache`]; this sink only owns the `Surface` values it stores.
    #[cfg(feature = "tiled-scheduler")]
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
    /// Frame-scratch VIEWS that must outlive the frame's single submit (their textures ride in
    /// `frame_transient`): the co-located silhouette/body sources the round loop binds. Dropped
    /// (cleared) each frame.
    frame_transient_views: Vec<wgpu::TextureView>,

    /// DEBUG: an atlas captured this frame (view, w, h) to blit over the swapchain so the batched
    /// gather's intermediates can be inspected. Selected by `abi::debug_atlas()`.
    dbg_atlas: Option<(wgpu::TextureView, u32, u32)>,

    /// Real GPU execution time for the frame, bracketed across every pass this sink records. `None`
    /// when the device lacks `TIMESTAMP_QUERY`. Built lazily on the first `execute` because the
    /// queue (needed for the tick period) is not available at construction.
    gpu_timer: Option<crate::vello::gputime::GpuTimer>,
    gpu_timer_tried: bool,

    /// Per-pass GPU timing for the effect graph (lens displacement/refraction/blur/composite), when
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

    /// The signed-distance-field bake pipeline for shape-following (`Sampled`) glass — a lens on a path
    /// or other non-box shape reads a baked SDF of its real outline instead of the analytic rounded
    /// box. Built once, lazily (the first sampled lens), since most frames have none.
    sdf_baker: Option<crate::vello::sdf::SdfBaker>,
}

impl Sink {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        Self {
            compositor: Compositor::new(device, format),
            unit_pipeline: UnitPipeline::new(device, format),
            surfaces: HashMap::new(),
            written: HashSet::new(),
            backdrop_origin: HashMap::new(),
            backdrop_scale: HashMap::new(),
            #[cfg(feature = "tiled-scheduler")]
            tile_cache: TileCache::new(),
            raster_usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            pool: TexturePool::default(),
            frame_transient: Vec::new(),
            frame_transient_views: Vec::new(),
            dbg_atlas: None,
            gpu_timer: None,
            gpu_timer_tried: false,
            pass_prof: None,
            canvas: None,
            canvas_view: None,
            last_view: None,
            blend_scratch: None,
            sdf_baker: None,
        }
    }

    #[cfg(feature = "tiled-scheduler")]
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
        for s in invalidated {
            self.pool.release(s.texture);
        }
        dirty
    }

    #[cfg(feature = "tiled-scheduler")]
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
        for (_, s) in self.surfaces.drain() {
            self.pool.release(s.texture);
        }
        for tex in self.frame_transient.drain(..) {
            self.pool.release(tex);
        }
        self.frame_transient_views.clear();
        self.written.clear();
        self.backdrop_origin.clear();
        self.backdrop_scale.clear();
        let gp = &schedule.gather_plan;
        crate::vello::prof::dbg_set(8, gp.total() as f64);
        crate::vello::prof::dbg_set(9, gp.deferrable_count() as f64);
        crate::vello::prof::dbg_set(10, gp.estimated_passes() as f64);
        crate::vello::prof::dbg_set(11, gp.batched_dispatches() as f64);
        self.raster_usage = backend.rasterize_target_usage();
        let full_view = crate::vello::abi::effective_view(root);
        let format = surface.format();
        let sw_view = surface.create_view(&wgpu::TextureViewDescriptor::default());

        let safe = backend.batched_submits_safe();
        let batch = if safe { crate::vello::abi::sink_batch() } else { 1 };
        let mut frame_enc = device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sink batch") });

        if !self.gpu_timer_tried {
            self.gpu_timer_tried = true;
            self.gpu_timer = crate::vello::gputime::GpuTimer::new(device, queue);
        }
        if let Some(t) = self.gpu_timer.as_mut() {
            t.begin();
        }

        let bg = crate::vello::abi::background().components;
        Compositor::clear(
            &mut frame_enc,
            &sw_view,
            [f64::from(bg[0]), f64::from(bg[1]), f64::from(bg[2]), f64::from(bg[3])],
            self.gpu_timer.as_ref().and_then(crate::vello::gputime::GpuTimer::start_writes),
        );

        let gather_groups: Vec<Vec<usize>> = if crate::vello::abi::gather_batch() {
            schedule.gather_plan.batched_groups()
        } else {
            Vec::new()
        };
        let batched_gathers: HashMap<u128, usize> = gather_groups
            .iter()
            .flatten()
            .map(|&gi| (schedule.gather_plan.gathers[gi].shape, gi))
            .collect();
        let mut atlased =
            self.atlas_effects(&schedule.steps, backend, device, queue, &mut frame_enc, root, full_view, format);
        crate::vello::prof::dbg_set(5, atlased.len() as f64);
        if !safe {
            Self::submit_batch(&mut frame_enc, device, queue, backend);
        }
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
        let prepassed = self.atlas_prepass(&schedule.steps, &atlased, backend, device, queue, &mut frame_enc, root, full_view, format);
        crate::vello::prof::dbg_set(7, prepassed.len() as f64);
        atlased.extend(prepassed);
        if !safe {
            Self::submit_batch(&mut frame_enc, device, queue, backend);
        }
        crate::vello::prof::dbg_set(12, schedule.steps.len() as f64);
        crate::vello::prof::dbg_set(13, schedule.steps.iter().filter(|s| matches!(s, Step::Paint { .. })).count() as f64);
        crate::vello::prof::dbg_set(14, schedule.steps.iter().filter(|s| matches!(s, Step::Composite { .. })).count() as f64);

        let mut finalize: Vec<usize> = Vec::new();

        let mut batched = 0_u32;
        for (i, step) in schedule.steps.iter().enumerate() {
            if atlased.contains(&i) {
                continue;
            }
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
                _ => {}
            }
            batched += 1;
            if batch != 0 && batched >= batch {
                Self::submit_batch(&mut frame_enc, device, queue, backend);
                batched = 0;
            }
        }

        if !gather_groups.is_empty() {
            self.atlas_gather(&schedule.gather_plan, &gather_groups, backend, device, queue, &mut frame_enc, root, full_view, format);
            if !safe {
                Self::submit_batch(&mut frame_enc, device, queue, backend);
            }
        }
        for &i in &finalize {
            if let Step::Composite { from, to, paint, rect, .. } = &schedule.steps[i] {
                crate::vello::prof::inc_composite();
                let _tbl = crate::vello::prof::now();
                self.composite(*from, *to, *paint, *rect, device, &mut frame_enc, &sw_view, full_view, width, height, format);
                crate::vello::prof::add_blit(crate::vello::prof::now() - _tbl);
            }
        }

        self.tile_cache.advance_frame();
        let dirty_set: HashSet<TileKey> = dirty.iter().copied().collect();

        for &t in dirty {
            let key = SurfaceRef::tile_ref(SurfaceRole::TileOutput, t);
            if let Some(old) = self.tile_cache.store(t, self.surfaces.remove(&key)) {
                self.pool.release(old.texture);
            }
        }

        let visible = tiling::visible_tiles(full_view, width, height);
        let mut reused = 0u32;
        for &t in &visible {
            if dirty_set.contains(&t) {
                continue;
            }
            let Some(view) = self.tile_cache.get(t).map(|s| s.view.clone()) else {
                continue;
            };
            self.blit_tile(device, &mut frame_enc, &sw_view, t, &view, full_view, width, height);
            self.tile_cache.touch(t);
            reused += 1;
        }
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

        if let Some(t) = self.gpu_timer.as_mut() {
            t.end(&mut frame_enc, &sw_view);
            t.resolve(&mut frame_enc);
        }

        let _tsu = crate::vello::prof::now();
        crate::vello::prof::inc_submit();
        queue.submit([frame_enc.finish()]);
        crate::vello::prof::add_submit(crate::vello::prof::now() - _tsu);
        backend.after_submit();
        if let Some(t) = self.gpu_timer.as_mut() {
            t.after_submit();
        }

        for s in self.tile_cache.evict(&visible) {
            self.pool.release(s.texture);
        }
    }

    /// Whole-viewport render (vello-native): the ENTIRE document is ONE vello scene driven through
    /// ONE pipeline. The scene walk records a native `CMD_EFFECT` boundary marker at every effect
    /// node, the front-end (flatten/bin/coarse) runs ONCE over the whole draw range, and each backdrop
    /// segment is painted by a lone `fine` dispatch over the shared PTCL. Effect work (gather stamps,
    /// shadow/blur stacks) records BETWEEN fine segments into the same encoder, and the whole frame is
    /// a single `queue.submit`. A frame with no effect nodes is the degenerate case — no boundaries,
    /// one fine segment. Gated by `abi::whole_viewport()`; the tiled scheduler remains the hybrid
    /// backend's path.
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
        content_dirty: bool,
    ) {
        let format = wgpu::TextureFormat::Rgba8Unorm;
        self.raster_usage = backend.rasterize_target_usage();
        for tex in self.frame_transient.drain(..) {
            self.pool.release(tex);
        }
        self.frame_transient_views.clear();
        let full_view = crate::vello::abi::effective_view(root);
        let sz = (width as f32, height as f32);
        let sw_view = target.create_view(&wgpu::TextureViewDescriptor::default());

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
                    crate::vello::prof::dbg_add(24, 1.0);
                    self.last_view = Some(full_view);
                    return;
                }
            }
        }

        if crate::vello::abi::present_on_demand() && crate::vello::abi::zoom_proxy() {
            let moving = self.last_view.is_some_and(|v| v != full_view);
            let dims_ok = self.canvas.as_ref().is_some_and(|c| c.2 == width && c.3 == height);
            if moving && !content_dirty && dims_ok {
                if let (Some((_, cv, _, _)), Some(cview)) = (self.canvas.as_ref(), self.canvas_view) {
                    let cv = cv.clone();
                    let d = (full_view * cview.inverse()).as_coeffs();
                    let (a, dd, e, f) = (d[0] as f32, d[3] as f32, d[4] as f32, d[5] as f32);
                    let bg = crate::vello::abi::background().components;
                    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                        label: Some("wv zoom-proxy"),
                    });
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
                    crate::vello::prof::dbg_add(25, 1.0);
                    self.last_view = Some(full_view);
                    return;
                }
            }
        }
        self.last_view = Some(full_view);

        let _tgd = crate::vello::prof::now();
        // THE scheduler's front half: build the whole-frame DAG first — the gathers list and each
        // shape's kind DERIVE from what the lowering produced ([`FrameDag::effect_shapes`]), never
        // from re-asking the model which fields it set.
        let mut dag = crate::vello::frame_dag::build_frame_dag_installed();
        let classes = dag.effect_shapes();
        let (gathers, root_count) = crate::vello::abi::with_scene(|live, _, _| {
            let gathers: Vec<(usize, u128, u8)> = live
                .roots()
                .iter()
                .enumerate()
                .filter_map(|(i, &id)| {
                    classes
                        .get(&id)
                        .map(|&stack| (i, id, if stack { FX_STACK } else { FX_GATHER }))
                })
                .collect();
            (gathers, live.roots().len())
        });
        crate::vello::prof::dbg_add(26, crate::vello::prof::now() - _tgd);

        if gathers.is_empty() && root_count == 0 {
            let bg = crate::vello::abi::background().components;
            let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("whole-viewport"),
            });
            Compositor::clear(&mut enc, &sw_view,
                [f64::from(bg[0]), f64::from(bg[1]), f64::from(bg[2]), f64::from(bg[3])], None);
            crate::vello::prof::inc_submit();
            queue.submit([enc.finish()]);
                backend.after_submit();
            return;
        }

        let mut enc =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("whole-viewport") });
        let mut flush_mark = passes_recorded();

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
        let _tenc = crate::vello::prof::now();
        let acc_h = height;
        let acc_sz = (width as f32, acc_h as f32);
        let mut scene = backend.new_scene(width as u16, acc_h as u16);

        let reaches: Vec<[f32; 4]> = gathers
            .iter()
            .map(|&(_, gid, kind)| {
                wv_clamp_reach(self.wv_marker_reach(gid, kind, full_view, width, height), width, height)
            })
            .collect();
        // Fill the DAG's view-dependent uniforms, stamp each effect's DEVICE reach onto its
        // nodes (the marker contract lives on device tiles), and let `schedule()` decide every round.
        crate::vello::abi::with_scene(|scene, _viewport, modifiers| {
            dag.fill_lens_uniforms(full_view, width, height, |id| {
                let n = scene.get(id)?;
                let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
                crate::effect_graph::lens_geometry(n, m)
            });
        });
        dag.fill_blur_uniforms(|id| {
            let pure_blur = crate::vello::abi::with_scene(|live, _, _| {
                live.get(id).map(|n| n.background_blur.is_some() && n.glass.is_none())
            })
            .unwrap_or(false);
            pure_blur.then(|| self.gather_sigma(id, full_view, 1.0))
        });
        let view_cs = full_view.as_coeffs();
        let view_scale = (view_cs[0] * view_cs[0] + view_cs[1] * view_cs[1]).sqrt() as f32;
        let shadow_at = |id: u128, slot: usize| -> Option<crate::effect::Effect> {
            crate::vello::abi::with_scene(|live, _, _| {
                let n = live.get(id)?;
                let e = crate::effect::effect_stack(n).into_iter().nth(slot)?;
                matches!(e.source, crate::effect::Source::Coverage { .. }).then_some(e)
            })
        };
        dag.fill_shadow_uniforms(
            |id, slot| {
                shadow_at(id, slot).map(|e| {
                    let r = match e.compose {
                        crate::effect::Compose::Over => e.ops.iter().find_map(|op| match op {
                            crate::effect::Op::EraseBy { blur, .. } => Some(*blur),
                            crate::effect::Op::Blur { radius } => Some(*radius),
                            _ => None,
                        }),
                        _ => e.governing_blur(),
                    };
                    crate::blur::radius_to_sigma(r.unwrap_or(0.0)) * view_scale
                })
            },
            |id, slot| {
                shadow_at(id, slot).and_then(|e| {
                    e.ops.iter().find_map(|op| match op {
                        crate::effect::Op::Tint(c) => Some(c.components),
                        _ => None,
                    })
                })
            },
        );
        dag.elide_negligible_blurs();
        {
            let dev: HashMap<u128, [f32; 4]> =
                gathers.iter().enumerate().map(|(j, &(_, gid, _))| (gid, reaches[j])).collect();
            for node in &mut dag.nodes {
                if let crate::vello::frame_dag::Source::Effect { shape, .. } = node.source {
                    if let Some(r) = dev.get(&shape) {
                        node.reach = Some(crate::kurbo::Rect::new(
                            r[0] as f64,
                            r[1] as f64,
                            r[2] as f64,
                            r[3] as f64,
                        ));
                    }
                }
            }
        }
        for i in 0..dag.nodes.len() {
            let crate::vello::frame_dag::Source::Effect { shape, .. } = dag.nodes[i].source else {
                continue;
            };
            let crate::vello::units::UnitOp::Rasterize(crate::vello::units::RasterSource::Distance {
                ref mut decode,
            }) = dag.nodes[i].op
            else {
                continue;
            };
            if let Some(u) = self.wv_lens_fine_uniform(shape, full_view, width, height) {
                *decode = 2.0 * u[4].max(u[5]);
            }
        }
        for i in 0..dag.nodes.len() {
            if let crate::vello::units::UnitOp::MaskMix(ref mut u) = dag.nodes[i].op {
                // A radial field-tint's centre and radius are view-dependent: flat 2/3 (`u[0].zw`,
                // the field anchor the emitter copies into record 3) and flat 4 (`u[1].x`).
                if u.get(crate::vello::bake::PAYLOAD_PROGRAM_SLOT).copied()
                    == Some(crate::vello::bake::PROGRAM_RADIAL)
                {
                    let crate::vello::frame_dag::Source::Effect { shape, .. } = dag.nodes[i].source
                    else {
                        continue;
                    };
                    let filled = crate::vello::abi::with_scene(|live, viewport, modifiers| {
                        let n = live.get(shape)?;
                        let modifier = modifiers.get(&shape).copied().unwrap_or(Affine::IDENTITY);
                        let m = viewport * modifier * n.effective_transform();
                        let c = m * n.bounds.center();
                        let coeffs = m.as_coeffs();
                        let sx = (coeffs[0] * coeffs[0] + coeffs[1] * coeffs[1]).sqrt();
                        let radius = 0.5 * n.bounds.width().min(n.bounds.height()) * sx;
                        Some((c.x as f32, c.y as f32, radius as f32))
                    });
                    let crate::vello::units::UnitOp::MaskMix(ref mut u) = dag.nodes[i].op else {
                        continue;
                    };
                    if let Some((cx, cy, radius)) = filled {
                        u[2] = cx;
                        u[3] = cy;
                        u[4] = radius;
                    }
                }
                continue;
            }
            if !matches!(
                dag.nodes[i].op,
                crate::vello::units::UnitOp::Blur { .. } | crate::vello::units::UnitOp::Warp(_)
            ) {
                continue;
            }
            let mut r = i;
            loop {
                match dag.nodes[r].op {
                    crate::vello::units::UnitOp::Rasterize(_) | crate::vello::units::UnitOp::Reload => break,
                    _ => match dag.nodes[r].inputs.first() {
                        Some(&j) => r = j,
                        None => break,
                    },
                }
            }
            let crate::vello::units::UnitOp::Rasterize(crate::vello::units::RasterSource::Body {
                offset: body_off,
            }) = dag.nodes[r].op
            else {
                continue;
            };
            // Every authorable `Offset` sits AFTER the warp in the chain (`effect_stack` orders
            // texture → blur → filter ops), but the fold rasterizes the body pre-translated. The
            // grain must ride with the shape — `warp(p) then move` samples the field at `p - o` —
            // so the field origin shifts by the offset's device vector.
            let origin = match dag.nodes[i].source {
                crate::vello::frame_dag::Source::Effect { shape, .. } => {
                    crate::vello::abi::with_scene(|live, _, modifiers| {
                        let n = live.get(shape)?;
                        let m = modifiers.get(&shape).copied().unwrap_or(Affine::IDENTITY);
                        let ext = crate::schedule::builder::effect_extent(n, m);
                        let (dx, dy, _, _) = tiling::device_rect(full_view, ext);
                        let c = full_view.as_coeffs();
                        let ox = (c[0] * f64::from(body_off[0]) + c[2] * f64::from(body_off[1])) as f32;
                        let oy = (c[1] * f64::from(body_off[0]) + c[3] * f64::from(body_off[1])) as f32;
                        Some((dx as f32 + ox, dy as f32 + oy))
                    })
                }
                _ => None,
            };
            match dag.nodes[i].op {
                crate::vello::units::UnitOp::Blur { ref mut sigma, .. } => {
                    *sigma = crate::blur::radius_to_sigma(*sigma) * view_scale;
                }
                crate::vello::units::UnitOp::Warp(ref mut u) => {
                    if let Some((ox, oy)) = origin {
                        if u.len() >= 10 {
                            u[8] = ox;
                            u[9] = oy;
                        }
                    }
                }
                _ => {}
            }
        }
        let dag = dag;
        let sched = dag.schedule(16.0, u64::MAX);

        /// One CMD_EFFECT mark per dispatch-relevant DAG node — desc, chain control, coverage choice —
        /// authored straight from the node's op + edges. `round` starts as the RAW scheduler round and
        /// is dense-renumbered below (the executor owns concrete numbers; the scheduler owns
        /// order/grouping). `masked` picks the marker's coverage (silhouette vs dilated reach); `band`
        /// marks a composite that must land past the body.
        struct UnitMark {
            node: usize,
            round: u32,
            desc: [f32; 26],
            rec: [[f32; 4]; 4],
            ctl: u32,
            masked: bool,
            band: bool,
            off: u32,
        }
        // Liveness: an elided blur leaves orphans; only nodes that still reach the accumulator emit.
        let node_live = {
            let mut lv = vec![false; dag.nodes.len()];
            for i in (0..dag.nodes.len()).rev() {
                if dag.nodes[i].writes_accumulator() {
                    lv[i] = true;
                }
                if lv[i] {
                    for &j in &dag.nodes[i].inputs {
                        lv[j] = true;
                    }
                }
            }
            lv
        };
        let mut marks: HashMap<u128, Vec<UnitMark>> = HashMap::new();
        {
            use crate::vello::bake::{bake_unit, bits, spread_arm, Policy};
            use crate::vello::frame_dag::Source as DagSource;
            use crate::vello::units::UnitOp;
            for &(_, gid, _) in &gathers {
                let mut by_slot: std::collections::BTreeMap<usize, Vec<usize>> = std::collections::BTreeMap::new();
                for (i, n) in dag.nodes.iter().enumerate() {
                    if let DagSource::Effect { shape, slot } = n.source {
                        if shape == gid && node_live[i] {
                            by_slot.entry(slot).or_default().push(i);
                        }
                    }
                }
                let mut out: Vec<UnitMark> = Vec::new();
                for nodes in by_slot.values() {
                    let op = |i: usize| &dag.nodes[i].op;
                    let Some(&compose_idx) =
                        nodes.iter().find(|&&i| matches!(op(i), UnitOp::Compose(_))) else { continue };
                    let UnitOp::Compose(mode) = *op(compose_idx) else { continue };
                    let over = mode == crate::vello::units::ComposeMode::Over;
                    let colour = nodes.iter().find_map(|&i| match op(i) {
                        UnitOp::Tint(u) if u.len() >= 4 => Some([u[0], u[1], u[2], u[3]]),
                        _ => None,
                    });
                    let frags: Vec<usize> =
                        nodes.iter().copied().filter(|&i| !op(i).is_structural()).collect();
                    // The chain's root source: walk the composite's input spine down to the node that
                    // produced the first value. A backdrop chain roots at a `Reload`; a coverage/body
                    // chain roots at a `Rasterize`.
                    let root_of = |mut i: usize| loop {
                        match op(i) {
                            UnitOp::Rasterize(_) | UnitOp::Reload => break i,
                            _ => match dag.nodes[i].inputs.first() {
                                Some(&j) => i = j,
                                None => break i,
                            },
                        }
                    };
                    // The composite ANCHOR: the last non-`Tint` fragment on the path from the
                    // `Compose` down — a trailing `Tint` folds into the anchor's colour (`u[3]`)
                    // rather than marking on its own.
                    let mut anchor = *dag.nodes[compose_idx]
                        .inputs
                        .last()
                        .expect("a compose reads its chain tail");
                    while matches!(op(anchor), UnitOp::Tint(_)) {
                        anchor = dag.nodes[anchor].inputs[0];
                    }
                    if frags.is_empty() || op(anchor).is_structural() {
                        // A chain with NO fragment units past the trailing Tints. Backdrop-rooted
                        // it is a pointwise backdrop tint — one fused mark, colour in u[3],
                        // running inline at the shape's z. Body-rooted it is a body replaced by
                        // pure geometry — one bare source-over mark.
                        let root = root_of(anchor);
                        if matches!(op(root), UnitOp::Reload) {
                            if let Some(c) = colour {
                                let mut desc = [0.0f32; 26];
                                desc[0] = bits::TINT as f32;
                                desc[14..18].copy_from_slice(&c);
                                out.push(UnitMark {
                                    node: compose_idx,
                                    round: sched.round[compose_idx],
                                    desc,
                                    rec: [[0.0f32; 4]; 4],
                                    ctl: 0,
                                    masked: true,
                                    band: false,
                                    off: 0,
                                });
                            }
                            continue;
                        }
                        if over
                            && matches!(
                                op(root),
                                UnitOp::Rasterize(
                                    crate::vello::units::RasterSource::Body { .. }
                                )
                            )
                        {
                            let mut desc = [0.0f32; 26];
                            desc[0] = bits::VALUE_OVER as f32;
                            let mut rec = [[0.0f32; 4]; 4];
                            rec[0][0] = 2.0;
                            out.push(UnitMark {
                                node: root,
                                round: sched.round[root],
                                desc,
                                rec,
                                ctl: 0,
                                masked: false,
                                band: false,
                                off: 0,
                            });
                        }
                        continue;
                    }
                    let root = root_of(anchor);
                    let backdrop_rooted = matches!(op(root), UnitOp::Reload);
                    let coverage_rooted = matches!(op(root), UnitOp::Rasterize(_));
                    // A chain with no gather unit is pointwise end to end: backdrop-rooted it runs
                    // inline off the plain marker (no unit marks); coverage-rooted its one composite
                    // arm still marks below.
                    let has_gather = frags.iter().any(|&i| op(i).is_gather());
                    if !has_gather && backdrop_rooted {
                        // A pointwise backdrop chain (backdrop tint, field tint) is ONE fused mark
                        // running inline at the shape's z: trailing Tints fold into the colour,
                        // the rest of the run bakes as-is.
                        let run: Vec<crate::vello::units::UnitOp> = frags
                            .iter()
                            .filter(|&&i| !matches!(op(i), UnitOp::Tint(_)))
                            .map(|&i| op(i).clone())
                            .collect();
                        let mut desc = if run.is_empty() {
                            [0.0f32; 26]
                        } else {
                            crate::vello::bake::arm_descriptor(&run, Policy::default(), None)
                        };
                        if let Some(c) = colour {
                            desc[0] += bits::TINT as f32;
                            desc[14..18].copy_from_slice(&c);
                        }
                        let mut rec = [[0.0f32; 4]; 4];
                        if matches!(desc[1] as u32, 1 | 3) {
                            rec[3][1] = desc[4];
                            rec[3][2] = desc[5];
                        }
                        out.push(UnitMark {
                            node: compose_idx,
                            round: sched.round[compose_idx],
                            desc,
                            rec,
                            ctl: 0,
                            masked: true,
                            band: false,
                            off: 0,
                        });
                        continue;
                    }
                    let body_rooted = matches!(
                        *op(root),
                        UnitOp::Rasterize(crate::vello::units::RasterSource::Body { .. })
                    );
                    // A spread composite lays a straight colour; a coverage chain that reached the
                    // composite without one has nothing to lay — no marks, the painter path renders
                    // it. A BODY chain's value IS the layer, so it needs no colour.
                    if over && colour.is_none() && !body_rooted {
                        continue;
                    }
                    let body_idx = dag
                        .nodes
                        .iter()
                        .position(|n| n.source == crate::vello::frame_dag::Source::Body(gid));
                    // Mark STYLE per fragment, from op class + what feeds it — never from what effect
                    // the chain came from:
                    //   Blur          → its own arm dispatch (taps, scratch), always.
                    //   head          → an arm when it feeds or is fed by a materialised draft, else a
                    //                   chained in-round step.
                    //   pointwise     → a chained in-round step over the backdrop; over a coverage
                    //                   root it only ever marks as the composite arm.
                    let is_arm = |i: usize, arm_in: bool| match op(i) {
                        UnitOp::Blur { .. } => true,
                        u if u.is_head() => {
                            arm_in
                                || frags
                                    .iter()
                                    .any(|&j| dag.nodes[j].inputs.contains(&i) && op(j).is_gather())
                        }
                        _ => coverage_rooted,
                    };
                    let mut arm_style: HashMap<usize, bool> = HashMap::new();
                    for &i in &frags {
                        let arm_in = dag.nodes[i]
                            .inputs
                            .iter()
                            .any(|j| arm_style.get(j).copied().unwrap_or(false));
                        arm_style.insert(i, is_arm(i, arm_in));
                    }
                    // An arm's RUN: the in-register units feeding it (its input spine back to the
                    // previous arm/structural node), oldest first — the head a materialize or
                    // composite arm executes before its own unit, fused into one descriptor.
                    let walk_back = |i: usize| -> Vec<usize> {
                        let mut run = vec![i];
                        let mut c = i;
                        loop {
                            let Some(&j) = dag.nodes[c].inputs.first() else { break };
                            if op(j).is_structural()
                                || arm_style.get(&j).copied().unwrap_or(true)
                                || matches!(op(j), UnitOp::Tint(_))
                            {
                                break;
                            }
                            run.push(j);
                            c = j;
                        }
                        run.reverse();
                        run
                    };
                    let sampled = frags.iter().find_map(|&i| {
                        if !op(i).is_head() {
                            return None;
                        }
                        let &src = dag.nodes[i].inputs.get(1)?;
                        match *op(src) {
                            UnitOp::Rasterize(crate::vello::units::RasterSource::Distance { decode }) => {
                                Some(decode)
                            }
                            _ => None,
                        }
                    });
                    let stamp_program = |r: &mut [[f32; 4]; 4]| {
                        if let Some(decode) = sampled {
                            r[3][0] = 2.0;
                            r[3][3] = decode;
                        }
                    };
                    for &i in &frags {
                        if matches!(op(i), UnitOp::Tint(_)) && i != anchor {
                            continue;
                        }
                        let arm = arm_style[&i];
                        let draft_in = dag.nodes[i]
                            .inputs
                            .iter()
                            .any(|j| arm_style.get(j).copied().unwrap_or(false));
                        let (desc, src, ctl, masked, band) = if i == anchor {
                            match op(i) {
                                UnitOp::Blur { .. } if body_rooted => {
                                    let p = Policy { value_over: true, edge_coverage: true, ..Policy::default() };
                                    (bake_unit(op(i), p), [0.0; 4], 0, false, false)
                                }
                                UnitOp::Blur { .. } => {
                                    let p = Policy {
                                        colour_over: over,
                                        edge_coverage: coverage_rooted,
                                        ..Policy::default()
                                    };
                                    let mut d = bake_unit(op(i), p);
                                    if over {
                                        if let Some(c) = colour {
                                            d[14..18].copy_from_slice(&c);
                                        }
                                    }
                                    (d, [0.0; 4], 0, !over, false)
                                }
                                _ if body_rooted => {
                                    let run: Vec<crate::vello::units::UnitOp> =
                                        walk_back(i).into_iter().map(|j| op(j).clone()).collect();
                                    let p = Policy { value_over: true, ..Policy::default() };
                                    let d = crate::vello::bake::arm_descriptor(&run, p, None);
                                    (d, [2.0, 2.0, 0.0, 0.0], 0, false, false)
                                }
                                _ if arm => {
                                    let erase = matches!(op(i), UnitOp::EraseBy(_));
                                    let scratch = if erase { 0.0 } else { 2.0 };
                                    let cov = if erase { bits::ERASE } else { 0 };
                                    let band = body_idx.is_none_or(|b| compose_idx > b);
                                    (spread_arm(cov, colour.unwrap_or_default()), [2.0, 0.0, scratch, 0.0], 0, band, band)
                                }
                                _ => {
                                    let d = bake_unit(op(i), Policy::default());
                                    (d, [0.0; 4], 1 | 2 | if draft_in { 4 } else { 0 }, true, false)
                                }
                            }
                        } else if arm {
                            let p = Policy {
                                raw: draft_in || coverage_rooted || op(i).is_head(),
                                edge_coverage: coverage_rooted,
                                ..Policy::default()
                            };
                            let run = walk_back(i);
                            let d = if run.len() == 1 {
                                bake_unit(op(i), p)
                            } else {
                                let ops: Vec<crate::vello::units::UnitOp> =
                                    run.into_iter().map(|j| op(j).clone()).collect();
                                crate::vello::bake::arm_descriptor(&ops, p, None)
                            };
                            let src = if backdrop_rooted { [0.0; 4] } else { [2.0, 2.0, 0.0, 0.0] };
                            (d, src, 0, false, false)
                        } else if backdrop_rooted {
                            let d = bake_unit(op(i), Policy::default());
                            (d, [0.0; 4], 1 | if draft_in { 4 } else { 0 }, true, false)
                        } else {
                            continue;
                        };
                        let mut rec = [[0.0f32; 4]; 4];
                        rec[0][0] = src[0];
                        rec[1][0] = src[1];
                        rec[2][0] = src[2];
                        stamp_program(&mut rec);
                        if ctl == 0
                            && (desc[0] as u32) & (bits::WARP | bits::BLUR | bits::SCATTER) == 0
                            && rec[0][0] == 0.0
                        {
                            rec[0][0] = 2.0;
                        }
                        if (desc[0] as u32) & (bits::BLUR | bits::COLOUR_OVER)
                            == (bits::BLUR | bits::COLOUR_OVER)
                        {
                            rec[2][0] = 2.0;
                        }
                        match desc[1] as u32 {
                            1 | 3 => {
                                rec[3][1] = desc[4];
                                rec[3][2] = desc[5];
                            }
                            2 => {
                                rec[3][1] = desc[10];
                                rec[3][2] = desc[11];
                            }
                            _ => {}
                        }
                        out.push(UnitMark { node: i, round: sched.round[i], desc, rec, ctl, masked, band, off: 0 });
                    }
                    // A band whose flood coverage the marker's own area cannot reproduce (`analytic:
                    // false` — glyph coverage) folds the flood recovery into its punch V pass: the V
                    // erases the offset silhouette back out at the punch's own offset, and the band
                    // reads that scratch coverage instead of `area[i]`.
                    if let Some(er) = frags
                        .iter()
                        .copied()
                        .find(|&i| matches!(op(i), UnitOp::EraseBy(_)) && i == anchor)
                    {
                        use crate::vello::units::RasterSource;
                        let punch = dag.nodes[er].inputs[1];
                        let flood = root_of(dag.nodes[er].inputs[0]);
                        let non_analytic = matches!(
                            *op(flood),
                            UnitOp::Rasterize(RasterSource::Coverage { analytic: false, .. })
                        );
                        if non_analytic && matches!(op(punch), UnitOp::Blur { .. }) {
                            let poff = match *op(root_of(punch)) {
                                UnitOp::Rasterize(RasterSource::Coverage { offset, .. }) => offset,
                                _ => [0.0; 2],
                            };
                            let ca = colour.map_or(0.0, |c| c[3]);
                            for m in &mut out {
                                if m.node == punch {
                                    m.desc[0] += bits::FLOOD_ERASE as f32;
                                    m.desc[10] = poff[0] * view_scale;
                                    m.desc[11] = poff[1] * view_scale;
                                    m.desc[17] = ca;
                                }
                                if m.node == er {
                                    m.desc[0] = bits::COLOUR_OVER as f32;
                                    m.rec[0][0] = 2.0;
                                    m.rec[2][0] = 2.0;
                                }
                            }
                        }
                    }
                }
                if !out.is_empty() {
                    marks.insert(gid, out);
                }
            }
        }
        // A mark that COMPOSES the accumulator when it runs — not an inner band (over the body) and
        // not a materialize into draft scratch. These are the marks the body must land after: drops
        // (under → before the body in z), a glass/backdrop composite, a backdrop tint. Punch/blur
        // materializes never touch the accumulator, so they impose no ordering on the body.
        let composes_acc = |m: &UnitMark| {
            !m.band
                && !matches!(dag.nodes[m.node].source, crate::vello::frame_dag::Source::Body(_))
                && !dag.binding_shape(m.node).is_some_and(|s| s.to_draft)
        };
        // A plain stack body rides fine like everything else: one bare VALUE_OVER mark on its
        // `Source::Body` DAG node (the sil collector co-locates the render, the dispatch composites
        // it over the accumulator). A stack whose Replace chain already emitted a VALUE_OVER mark
        // has its body in fine; a body-less stack (no paint) has nothing to composite. The body
        // lands after the last accumulator-composing pre-body mark; with none (an inner-only
        // stack), before every mark.
        {
            use crate::vello::bake::bits;
            use crate::vello::frame_dag::Source as DagSource;
            for &(_, gid, kind) in &gathers {
                if kind != FX_STACK {
                    continue;
                }
                if marks.get(&gid).is_some_and(|ms| {
                    ms.iter().any(|m| (m.desc[0] as u32) & bits::VALUE_OVER != 0)
                }) {
                    continue;
                }
                let Some(body_idx) = dag
                    .nodes
                    .iter()
                    .position(|n| n.source == DagSource::Body(gid))
                else {
                    continue;
                };
                let ms = marks.entry(gid).or_default();
                let pre = ms.iter().filter(|m| composes_acc(m)).map(|m| m.round).max();
                let round = pre.or_else(|| ms.iter().map(|m| m.round).min()).unwrap_or(0);
                let key_round = pre.map_or_else(|| i64::from(round) - 1, i64::from);
                let mut desc = [0.0f32; 26];
                desc[0] = bits::VALUE_OVER as f32;
                let mut rec = [[0.0f32; 4]; 4];
                rec[0][0] = 2.0;
                let pos = ms.iter().position(|m| i64::from(m.round) > key_round).unwrap_or(ms.len());
                ms.insert(pos, UnitMark {
                    node: body_idx,
                    round,
                    desc,
                    rec,
                    ctl: 0,
                    masked: false,
                    band: false,
                    off: 0,
                });
            }
        }
        for &(_, gid, kind) in &gathers {
            assert!(
                kind == FX_STACK || marks.contains_key(&gid),
                "gid {gid:x}: every gather chain lowers to unit marks — a gather with none is a planner bug"
            );
        }
        // Dense renumbering: scheduler order → executor rounds, gap-free from 1 (the window walk stalls
        // on an empty round). Keys order as (round, class): a stack's BODY mark (class 1) takes its own
        // key AFTER the last accumulator-composing pre-body mark and BEFORE its bands; a body with no
        // such mark (an inner-only stack) keys one raw round early, ahead of every mark. Everything
        // else is class 0 at its raw round.
        let body_key = |m: &UnitMark, ms: &[UnitMark]| -> (i64, u8) {
            if ms.iter().any(&composes_acc) {
                (i64::from(m.round), 1)
            } else {
                (i64::from(m.round) - 1, 1)
            }
        };
        let is_body = |m: &UnitMark| {
            matches!(dag.nodes[m.node].source, crate::vello::frame_dag::Source::Body(_))
        };
        let mark_key = |m: &UnitMark, ms: &[UnitMark]| -> (i64, u8) {
            if is_body(m) { body_key(m, ms) } else { (i64::from(m.round), 0) }
        };
        let mut round_keys: std::collections::BTreeSet<(i64, u8)> = std::collections::BTreeSet::new();
        for ms in marks.values() {
            for m in ms {
                round_keys.insert(mark_key(m, ms));
            }
        }
        let exec: HashMap<(i64, u8), u32> =
            round_keys.iter().enumerate().map(|(k, &key)| (key, k as u32 + 1)).collect();
        for ms in marks.values_mut() {
            let keys: Vec<(i64, u8)> = ms.iter().map(|m| mark_key(m, ms)).collect();
            for (m, key) in ms.iter_mut().zip(keys) {
                m.round = exec[&key];
            }
        }
        let rounds: Vec<u32> = gathers
            .iter()
            .map(|&(_, gid, _)| {
                marks
                    .get(&gid)
                    .and_then(|ms| ms.iter().map(|m| m.round).min())
                    .unwrap_or(1)
            })
            .collect();
        #[cfg(not(target_arch = "wasm32"))]
        if std::env::var("WV_DBG_MARKS").is_ok() {
            for (gid, ms) in &marks {
                for m in ms {
                    eprintln!(
                        "WV_DBG_MARKS: gid={:04x} node={} op={:?} round={} ctl={} masked={} band={} bits={} u1=({}, {}) a={}",
                        (gid & 0xffff) as u16, m.node, dag.nodes[m.node].op, m.round, m.ctl, m.masked, m.band,
                        m.desc[0], m.desc[6], m.desc[7], m.desc[17],
                    );
                }
            }
        }
        let mut max_round = 0u32;
        for (j, &(_, gid, _)) in gathers.iter().enumerate() {
            let hi = marks.get(&gid).and_then(|ms| ms.iter().map(|m| m.round).max()).unwrap_or(rounds[j]);
            max_round = max_round.max(hi);
        }
        // Reach-crop background-blur drafts into ONE packed atlas, reused across rounds (temporally
        // disjoint intervals). Each blur's device→lease origin is baked into its H (u[1].xy, the store)
        // and V (u[1].zw, the tap) descs.
        let mut blur_atlas_dims: Option<(u32, u32)> = None;
        {
            use crate::vello::frame_dag::{pack, LiveRect};
            use crate::vello::units::UnitOp;
            let mut lives: Vec<LiveRect> = Vec::new();
            let mut jobs: Vec<(u128, usize, u32, u32)> = Vec::new();
            for (j, &(_, gid, _)) in gathers.iter().enumerate() {
                let Some(ms) = marks.get(&gid) else { continue };
                for m in ms {
                    if !(matches!(dag.nodes[m.node].op, UnitOp::Blur { .. })
                        && matches!(dag.nodes[dag.nodes[m.node].inputs[0]].op, UnitOp::Reload))
                    {
                        continue;
                    }
                    let r = reaches[j];
                    let x0 = (r[0].max(0.0) as u32 / TILE_PX) * TILE_PX;
                    let y0 = (r[1].max(0.0) as u32 / TILE_PX) * TILE_PX;
                    let x1 = ((r[2].ceil() as u32).div_ceil(TILE_PX) * TILE_PX).min(width);
                    let y1 = ((r[3].ceil() as u32).div_ceil(TILE_PX) * TILE_PX).min(acc_h);
                    lives.push(LiveRect { node: lives.len(), w: x1 - x0, h: y1 - y0, birth: m.round, death: m.round + 1 });
                    jobs.push((gid, m.node, x0, y0));
                }
            }
            if !lives.is_empty() {
                let leases = pack(&lives);
                let mut slab_h: std::collections::BTreeMap<u32, u32> = std::collections::BTreeMap::new();
                for le in &leases {
                    let e = slab_h.entry(le.slab).or_insert(0);
                    *e = (*e).max(le.y + le.h);
                }
                let (mut slab_y, mut cursor) = (std::collections::BTreeMap::new(), 0u32);
                for (&slab, &h) in &slab_h {
                    slab_y.insert(slab, cursor);
                    cursor += h;
                }
                let atlas_w = leases.iter().map(|l| l.x + l.w).max().unwrap_or(TILE_PX).max(TILE_PX);
                blur_atlas_dims = Some((atlas_w, cursor.max(TILE_PX)));
                for (le, &(gid, h_node, dx0, dy0)) in leases.iter().zip(&jobs) {
                    let ly = slab_y[&le.slab] + le.y;
                    let (ox, oy) = (dx0 as i32 - le.x as i32, dy0 as i32 - ly as i32);
                    if let Some(ms) = marks.get_mut(&gid) {
                        for m in ms.iter_mut() {
                            if m.node == h_node {
                                m.desc[6] = ox as f32;
                                m.desc[7] = oy as f32;
                            } else if dag.nodes[m.node].inputs.first() == Some(&h_node) {
                                m.rec[0][1] = ox as f32;
                                m.rec[0][2] = oy as f32;
                            }
                        }
                    }
                }
            }
        }
        let mut fx_params: Vec<f32> = Vec::new();
        for ms in marks.values_mut() {
            for m in ms.iter_mut() {
                m.off = fx_params.len() as u32;
                fx_params.extend_from_slice(&m.desc);
                for r in &m.rec {
                    fx_params.extend_from_slice(r);
                }
            }
        }
        let fx_bytes: Vec<u8> = fx_params.iter().flat_map(|f| f.to_le_bytes()).collect();

        // `boundaries[j]` = draw count before gather j's marker(s); `markers_before[j]` = markers emitted
        // before it; `total_markers` = all of them. A gather emits one marker per unit mark, each at its
        // own z ordinal.
        let (boundaries, markers_before, total_markers): (Vec<u32>, Vec<u32>, u32) = {
            let mut b = Vec::with_capacity(gathers.len());
            let mut mb = Vec::with_capacity(gathers.len());
            let mut cursor = 0usize;
            let mut z = 0u32;
            for (j, &(gi, gid, kind)) in gathers.iter().enumerate() {
                if gi > cursor {
                    backend.draw_scene_range(&mut scene, root, cursor, gi);
                    cursor = gi;
                }
                b.push(backend.draw_object_count(&scene));
                mb.push(z);
                if kind == FX_STACK {
                    // The stack's window marker (eid 6) opens its first round; its unit marks follow;
                    // the body paints imperatively at its own round. The stack shape is skipped from the
                    // scene draws (its layers paint per-round).
                    z += 1;
                    backend.draw_effect_marker(&mut scene, root, gid, 6u32, z, rounds[j], 0, reaches[j], 0);
                    if let Some(ms) = marks.get(&gid) {
                        for m in ms {
                            z += 1;
                            let eid = if m.masked {
                                crate::vello::bake::EID_MASKED
                            } else {
                                crate::vello::bake::EID_MATERIALIZE
                            };
                            backend.draw_effect_marker(&mut scene, root, gid, eid, z, m.round, m.off, reaches[j], m.ctl);
                        }
                    }
                    cursor = gi + 1;
                } else if let Some(ms) = marks.get(&gid) {
                    for m in ms {
                        z += 1;
                        let eid = if m.masked {
                            crate::vello::bake::EID_MASKED
                        } else {
                            crate::vello::bake::EID_MATERIALIZE
                        };
                        backend.draw_effect_marker(&mut scene, root, gid, eid, z, m.round, m.off, reaches[j], m.ctl);
                    }
                } else {
                    unreachable!(
                        "gid {gid:x}: every effect chain emits unit marks — a marker with none is a planner bug"
                    );
                }
            }
            backend.draw_scene_range(&mut scene, root, cursor, usize::MAX);
            (b, mb, z)
        };
        let total_draws = backend.draw_object_count(&scene);
        crate::vello::prof::dbg_add(30, crate::vello::prof::now() - _tenc);

        let phase_usage = self.raster_usage
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::TEXTURE_BINDING;
        // rw single-accumulator: a frame updates in place unless some mark GATHERS — a
        // neighbourhood read (blur/warp/scatter) or any input-register operand needs the frozen
        // ping-pong backdrop; a pointwise inline mark (a backdrop tint) reads only its own pixel.
        let inline_only = marks.values().flatten().all(|m| {
            m.ctl == 0
                && (m.desc[0] as u32) & (crate::vello::bake::bits::WARP | crate::vello::bake::bits::BLUR | crate::vello::bake::bits::SCATTER)
                    == 0
                && m.rec.iter().all(|r| r[0] != 2.0)
        });
        let rw = backend.rw_accumulator() && format == wgpu::TextureFormat::Rgba8Unorm && inline_only;
        let n_slots: usize = if rw { 1 } else { 2 };
        let texs: Vec<wgpu::Texture> = (0..n_slots)
            .map(|_| self.pool.acquire_target(device, width, acc_h, format, phase_usage, "wv phase"))
            .collect();
        let views: Vec<wgpu::TextureView> =
            texs.iter().map(|t| t.create_view(&wgpu::TextureViewDescriptor::default())).collect();
        #[cfg(not(target_arch = "wasm32"))]
        if std::env::var("WV_DBG_ROUNDS").is_ok() {
            eprintln!(
                "WV_DBG_ROUNDS: gathers={} max_round={max_round} marks={} dag_nodes={} sched_rounds={}",
                gathers.len(),
                marks.values().map(Vec::len).sum::<usize>(),
                dag.nodes.len(),
                sched.rounds(),
            );
        }
        // Edge-driven scratch: every materialised DAG node writes its OWN texture, keyed by NODE INDEX; a
        // reader binds it by following its `inputs` edge. Same-round peers alias one physical texture —
        // the round's single dispatch wrote all their regions.
        let mut node_scratch: std::collections::HashMap<usize, wgpu::TextureView> = std::collections::HashMap::new();
        let mut draft_texs: Vec<wgpu::Texture> = Vec::new();
        // The ONE background-blur draft atlas, reused across every blur round (temporally disjoint).
        let blur_atlas_view: Option<wgpu::TextureView> = blur_atlas_dims.map(|(aw, ah)| {
            let t = self.pool.acquire_target(device, aw, ah, format, phase_usage, "wv blur atlas");
            let v = t.create_view(&wgpu::TextureViewDescriptor::default());
            draft_texs.push(t);
            v
        });

        if passes_recorded().wrapping_sub(flush_mark) >= WV_PASS_FLUSH_BUDGET {
            Self::submit_batch(&mut enc, device, queue, backend);
            flush_mark = passes_recorded();
        }

        // The round → dispatch-owning node map: a round's nodes share ONE binding shape (the scheduler's
        // invariant), so they ride one dispatch and every materialize output is recorded for all of them.
        let round_nodes: HashMap<u32, Vec<usize>> = {
            let mut m: HashMap<u32, Vec<usize>> = HashMap::new();
            for ms in marks.values() {
                for mk in ms {
                    if dag.binding_shape(mk.node).is_some() {
                        m.entry(mk.round).or_default().push(mk.node);
                    }
                }
            }
            m
        };
        // Rasterized sources (silhouettes / SDFs), co-located per consuming round: the round's single
        // dispatch binds ONE source texture, and reach-disjointness (the very thing that let the
        // scheduler share the round) keeps their device regions disjoint inside it.
        {
            use crate::vello::frame_dag::Source as DagSource;
            use crate::vello::units::UnitOp;
            let mut sil_groups: std::collections::BTreeMap<u32, Vec<usize>> = std::collections::BTreeMap::new();
            let mut sdf_jobs: Vec<(usize, u128, f32)> = Vec::new();
            let mut seen: std::collections::HashSet<usize> = std::collections::HashSet::new();
            for (&round, nodes) in &round_nodes {
                for &nd in nodes {
                    let n = &dag.nodes[nd];
                    match &n.op {
                        UnitOp::Blur { .. } | UnitOp::Tint(_) => {
                            if let Some(&s) = n.inputs.first() {
                                if matches!(
                                    dag.nodes[s].op,
                                    UnitOp::Rasterize(
                                        crate::vello::units::RasterSource::Coverage { .. }
                                            | crate::vello::units::RasterSource::Body { .. }
                                    )
                                ) && seen.insert(s)
                                {
                                    sil_groups.entry(round).or_default().push(s);
                                }
                            }
                        }
                        UnitOp::Rasterize(crate::vello::units::RasterSource::Body { .. }) => {
                            if seen.insert(nd) {
                                sil_groups.entry(round).or_default().push(nd);
                            }
                        }
                        UnitOp::EraseBy(_) => {
                            if let Some(&s) = n.inputs.get(1) {
                                if matches!(dag.nodes[s].op, UnitOp::Rasterize(crate::vello::units::RasterSource::Coverage { .. })) && seen.insert(s) {
                                    sil_groups.entry(round).or_default().push(s);
                                }
                            }
                        }
                        UnitOp::Warp(_) => {
                            if let Some(&s) = n.inputs.get(1) {
                                if let UnitOp::Rasterize(crate::vello::units::RasterSource::Distance { decode }) = dag.nodes[s].op {
                                    if seen.insert(s) {
                                        if let DagSource::Effect { shape, .. } = dag.nodes[s].source {
                                            sdf_jobs.push((s, shape, decode));
                                        }
                                    }
                                }
                            }
                        }
                        UnitOp::ClipToSource(_) => {
                            let mut r = n.inputs[0];
                            loop {
                                match dag.nodes[r].op {
                                    UnitOp::Rasterize(_) | UnitOp::Reload => break,
                                    _ => match dag.nodes[r].inputs.first() {
                                        Some(&k) => r = k,
                                        None => break,
                                    },
                                }
                            }
                            if matches!(dag.nodes[r].op, UnitOp::Rasterize(crate::vello::units::RasterSource::Body { .. }))
                                && seen.insert(r)
                            {
                                sil_groups.entry(round).or_default().push(r);
                            }
                        }
                        _ => {}
                    }
                }
            }
            let root_index: HashMap<u128, usize> =
                gathers.iter().map(|&(gi, gid, _)| (gid, gi)).collect();
            for group in sil_groups.values() {
                let sil = self.pool.acquire_target(device, width, acc_h, format, self.raster_usage, "wv unit silhouette");
                let sv = sil.create_view(&wgpu::TextureViewDescriptor::default());
                let mut sscene = backend.new_scene(width as u16, acc_h as u16);
                for &s in group {
                    // A plain stack body (its own bare mark): render the shape at its device place.
                    if let DagSource::Body(shape) = dag.nodes[s].source {
                        if let Some(&gi) = root_index.get(&shape) {
                            backend.draw_scene_range(&mut sscene, root, gi, gi + 1);
                        }
                        continue;
                    }
                    let DagSource::Effect { shape, slot } = dag.nodes[s].source else { continue };
                    if let UnitOp::Rasterize(crate::vello::units::RasterSource::Body { offset }) =
                        dag.nodes[s].op
                    {
                        if let Some(&gi) = root_index.get(&shape) {
                            let t = root
                                * Affine::translate((f64::from(offset[0]), f64::from(offset[1])));
                            backend.draw_scene_range(&mut sscene, t, gi, gi + 1);
                        }
                        continue;
                    }
                    // The punch silhouette (an inner's erase input, inset) vs a drop's offset one: the
                    // slot carries an EraseBy exactly when this source is the punch.
                    let inset = dag.nodes.iter().any(|m| {
                        matches!(m.op, UnitOp::EraseBy(_))
                            && matches!(m.source, DagSource::Effect { shape: s2, slot: sl2 } if s2 == shape && sl2 == slot)
                    });
                    // The silhouette builder indexes shadows WITHIN their inset class, not by the
                    // effect-stack slot — count the earlier same-class coverage slots.
                    let class_idx = crate::vello::abi::with_scene(|live, _, _| {
                        live.get(shape).map(|n| {
                            crate::effect::effect_stack(n)
                                .iter()
                                .take(slot)
                                .filter(|e| {
                                    matches!(e.source, crate::effect::Source::Coverage { .. })
                                        && (e.compose == crate::effect::Compose::Over) == inset
                                })
                                .count()
                        })
                    })
                    .unwrap_or(slot);
                    backend.build_shadow_silhouette(&mut sscene, root, shape, class_idx, inset, true, false);
                }
                backend.rasterize(&sscene, device, queue, &mut enc, &sv, width, acc_h, TRANSPARENT);
                self.frame_transient.push(sil);
                self.frame_transient_views.push(sv.clone());
                for &s in group {
                    node_scratch.insert(s, sv.clone());
                }
            }
            if !sdf_jobs.is_empty() {
                if self.sdf_baker.is_none() {
                    self.sdf_baker = Some(crate::vello::sdf::SdfBaker::new(device));
                }
                let tex = self.pool.acquire_target(
                    device,
                    width,
                    acc_h,
                    crate::vello::sdf::SDF_FORMAT,
                    wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                    "wv sdf",
                );
                let sv = tex.create_view(&wgpu::TextureViewDescriptor::default());
                let baker = self.sdf_baker.as_ref().expect("sdf baker just built");
                let mut first = true;
                for &(sdf_node, gid, decode) in &sdf_jobs {
                    if let (Some(segs), Some((bx, by, bw, bh, _))) = (
                        self.wv_lens_sdf_segments(gid, full_view),
                        self.wv_lens_box(gid, full_view, width, height),
                    ) {
                        baker.bake_into(device, &mut enc, &sv, &segs, (bx, by, bw, bh), decode, first);
                        first = false;
                    }
                    node_scratch.insert(sdf_node, sv.clone());
                }
                self.frame_transient.push(tex);
                self.frame_transient_views.push(sv.clone());
            }
        }

        let _tpb = crate::vello::prof::now();
        backend.phased_begin(&scene, device, queue, &mut enc, width, acc_h, crate::vello::abi::background(), &fx_bytes);
        crate::vello::prof::dbg_add(31, crate::vello::prof::now() - _tpb);

        backend.phased_frontend_full(device, queue, &mut enc);

        let _tpl = crate::vello::prof::now();
        let n_markers = total_markers;
        let real_draws = total_draws.saturating_sub(n_markers);
        let draws_after = |j: usize| -> u32 {
            total_draws.saturating_sub(boundaries[j]).saturating_sub(n_markers - markers_before[j])
        };
        // Every executor round that carries work: a unit mark, or a gather's base window.
        let active_rounds: std::collections::HashSet<u32> = marks
            .values()
            .flatten()
            .map(|m| m.round)
            .chain(gathers.iter().enumerate().map(|(j, _)| rounds[j]))
            .collect();
        let window_has_draws = |lo: u32, hi: u32| -> bool {
            if lo == 0 {
                // The base window must open (seeding the accumulator and advancing the window
                // cursor) whenever ANY later round carries a mark — a scene whose only content is
                // stack shapes has zero base draws, but skipping [0, 1) would leave the cursor at 0
                // and starve every mark window behind the base-only special case.
                return real_draws > 0 || !active_rounds.is_empty();
            }
            let hit = |r: u32| r >= lo && (hi == crate::vello::rasterize::SEG_ALL || r < hi);
            (0..gathers.len()).any(|j| hit(rounds[j]) && draws_after(j) > 0)
                || active_rounds.iter().any(|&r| hit(r))
        };
        let mut window_lo = 0u32;
        let mut cur: Option<usize> = None;
        let seed_clear = |enc: &mut wgpu::CommandEncoder, view: &wgpu::TextureView| {
            let bg = crate::vello::abi::background().components;
            Compositor::clear(enc, view,
                [f64::from(bg[0]), f64::from(bg[1]), f64::from(bg[2]), f64::from(bg[3])], None);
        };
        for r in 1..=max_round + 1 {
            // The extra iteration is the FINAL window ([last, SEG_ALL)) — same dispatch, open end.
            let hi = if r > max_round { crate::vello::rasterize::SEG_ALL } else { r };
            if window_has_draws(window_lo, hi) {
                note_passes(2);
                #[cfg(not(target_arch = "wasm32"))]
                if std::env::var("WV_DBG_WIN").is_ok() { eprintln!("WV_DBG_WIN: [{window_lo},{hi}) nodes={:?} cur={cur:?}", round_nodes.get(&window_lo)); }
                if let Some(unit_nodes) = round_nodes.get(&window_lo) {
                    // Shape-driven dispatch: the round's binding shape — not a winner node's op —
                    // decides the pass: what fills fine's three slots and which permutation reads slot
                    // 10. All nodes in the round share the bindings (co-located sources, one output).
                    use crate::vello::frame_dag::Slot;
                    use crate::vello::units::UnitOp;
                    let rep = unit_nodes[0];
                    let shp = dag.binding_shape(rep).expect("a scheduled round's nodes own the dispatch");
                    #[cfg(not(target_arch = "wasm32"))]
                    if std::env::var("WV_DBG_DISPATCH").is_ok() {
                        eprintln!(
                            "WV_DBG_DISPATCH: window_lo={window_lo} nodes={unit_nodes:?} rep_op={:?} shp={shp:?}",
                            dag.nodes[rep].op,
                        );
                    }
                    debug_assert!(
                        unit_nodes.iter().all(|&n| dag.binding_shape(n) == Some(shp)),
                        "one binding shape per round",
                    );
                    let read_edge = |n: usize| -> Option<usize> {
                        // An erase's flood (inputs[0]) is `area[i]`, never a texture — its slot-10
                        // edge is the punch (inputs[1]), whatever the punch's op.
                        if matches!(dag.nodes[n].op, UnitOp::EraseBy(_)) {
                            return dag.nodes[n].inputs.get(1).copied();
                        }
                        // A bare source mark IS its own edge: the node composites the very texture
                        // it rasterized.
                        if matches!(dag.nodes[n].op, UnitOp::Rasterize(_)) {
                            return Some(n);
                        }
                        let direct = dag.nodes[n].inputs.iter().copied().find(|&j| match shp.input {
                            Slot::Source => matches!(dag.nodes[j].op, UnitOp::Rasterize(_)),
                            Slot::Draft(_) => {
                                !matches!(dag.nodes[j].op, UnitOp::Rasterize(_) | UnitOp::Reload)
                            }
                            _ => false,
                        });
                        if direct.is_some() {
                            return direct;
                        }
                        // A fused arm's source sits below its folded in-register units (a clip over a
                        // warp over the body): walk the input spine down to the rasterized root.
                        if matches!(shp.input, Slot::Source) {
                            let mut r = *dag.nodes[n].inputs.first()?;
                            loop {
                                match dag.nodes[r].op {
                                    UnitOp::Rasterize(_) => return Some(r),
                                    UnitOp::Reload => return None,
                                    _ => r = *dag.nodes[r].inputs.first()?,
                                }
                            }
                        }
                        None
                    };
                    let mut acquire = || {
                        let t = self.pool.acquire_target(device, width, acc_h, format, phase_usage, "wv unit scratch");
                        let v = t.create_view(&wgpu::TextureViewDescriptor::default());
                        draft_texs.push(t);
                        v
                    };
                    if shp.to_draft {
                        let dv = match (shp.base, shp.input) {
                            (Slot::Backdrop, Slot::None) => {
                                let base = cur.map(|c| views[c].clone()).expect("a backdrop materialize reads the accumulator");
                                if matches!(dag.nodes[rep].op, UnitOp::Blur { .. }) {
                                    // A blur materializing from the backdrop writes the packed atlas;
                                    // the OOB sentinel stops a tile with no marker clobbering a lease.
                                    let dv = blur_atlas_view.clone().unwrap_or_else(&mut acquire);
                                    const OOB: u32 = 1 << 24;
                                    backend.phase_scratch_origins([OOB, OOB], [0, 0]);
                                    backend.phased_fine_segment(device, queue, &mut enc, window_lo, hi, Some(&base), &dv);
                                    dv
                                } else {
                                    // A head (frost warp) materializing its refracted sample.
                                    let dv = acquire();
                                    backend.phased_fine_segment(device, queue, &mut enc, window_lo, hi, Some(&base), &dv);
                                    dv
                                }
                            }
                            (Slot::Backdrop, Slot::Source) => {
                                // A frost warp over a sampled (SDF) field: base = the backdrop, slot 10
                                // = the baked SDF, materialize the refracted sample for the blur chain.
                                let base = cur.map(|c| views[c].clone()).expect("a backdrop materialize reads the accumulator");
                                let src = read_edge(rep)
                                    .and_then(|e| node_scratch.get(&e))
                                    .expect("SDF baked for the round")
                                    .clone();
                                let dv = acquire();
                                backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, hi, &base, &src, &dv);
                                dv
                            }
                            (Slot::Source, Slot::Source) => {
                                // Materialize from a rasterized source: base_in = input_in = the round's
                                // co-located source texture.
                                let sil = read_edge(rep)
                                    .and_then(|e| node_scratch.get(&e))
                                    .expect("source co-located for the round")
                                    .clone();
                                let dv = acquire();
                                backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, hi, &sil, &sil, &dv);
                                dv
                            }
                            (_, Slot::Draft(_)) => {
                                // Materialize from a prior draft; base_in is the chain's root surface,
                                // and the slot-10 permutation follows the shape's `draft_taps`.
                                let src = read_edge(rep)
                                    .and_then(|e| node_scratch.get(&e))
                                    .expect("draft aliased for the round")
                                    .clone();
                                let base = match shp.base {
                                    Slot::Source => dag_base_rasterize(&dag, rep).and_then(|rz| node_scratch.get(&rz)).cloned(),
                                    _ => cur.map(|c| views[c].clone()),
                                }
                                .expect("materialize base bound");
                                let dv = acquire();
                                if shp.draft_taps {
                                    backend.phased_fine_segment_draft(device, queue, &mut enc, window_lo, hi, &base, &src, &dv);
                                } else {
                                    backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, hi, &base, &src, &dv);
                                }
                                dv
                            }
                            other => panic!("unit dispatch: unexpected materialize shape {other:?}"),
                        };
                        for &n in unit_nodes {
                            node_scratch.insert(n, dv.clone());
                        }
                    } else {
                        let c = cur.expect("a composite reads the accumulator");
                        let out = 1 - c;
                        match shp.input {
                            Slot::Draft(_) if shp.draft_taps => {
                                let src = read_edge(rep)
                                    .and_then(|e| node_scratch.get(&e))
                                    .expect("draft aliased for the round")
                                    .clone();
                                backend.phased_fine_segment_draft(device, queue, &mut enc, window_lo, hi, &views[c], &src, &views[out]);
                            }
                            Slot::Draft(_) | Slot::Source => {
                                let src = read_edge(rep)
                                    .and_then(|e| node_scratch.get(&e))
                                    .expect("slot-10 source bound")
                                    .clone();
                                backend.phased_fine_segment_input(device, queue, &mut enc, window_lo, hi, &views[c], &src, &views[out]);
                            }
                            Slot::None => {
                                backend.phased_fine_segment(device, queue, &mut enc, window_lo, hi, Some(&views[c]), &views[out]);
                            }
                            other => panic!("unit dispatch: unexpected composite input {other:?}"),
                        }
                        cur = Some(out);
                    }
                } else if rw {
                    // The FIRST window keeps the plain clearing permutation; the rest update in place.
                    if cur.is_none() {
                        backend.phased_fine_segment(device, queue, &mut enc, window_lo, hi, None, &views[0]);
                        cur = Some(0);
                    } else {
                        backend.phased_fine_segment_rw(device, queue, &mut enc, window_lo, hi, &views[0]);
                    }
                } else {
                    // A plain ping-pong window: read the current accumulator, write the other slot.
                    let out = cur.map_or(0, |c| 1 - c);
                    let base = cur.map(|c| &views[c]);
                    backend.phased_fine_segment(device, queue, &mut enc, window_lo, hi, base, &views[out]);
                    cur = Some(out);
                }
                window_lo = r;
            } else if cur.is_none() {
                seed_clear(&mut enc, &views[0]);
                cur = Some(0);
            }
            if passes_recorded().wrapping_sub(flush_mark) >= WV_PASS_FLUSH_BUDGET {
                Self::submit_batch(&mut enc, device, queue, backend);
                flush_mark = passes_recorded();
            }
        }
        let final_slot = match cur {
            Some(c) => c,
            None => {
                seed_clear(&mut enc, &views[0]);
                0
            }
        };
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(v) = std::env::var("WV_DUMP_SCRATCH")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .and_then(|n| node_scratch.get(&n))
        {
            Compositor::clear(&mut enc, &views[final_slot], [0.0, 0.0, 0.0, 0.0], None);
            self.compositor.blit(device, &mut enc, &views[final_slot], acc_sz, &Blit {
                src: v,
                dst: (0.0, 0.0, acc_sz.0, acc_sz.1),
                src_rect: (0.0, 0.0, acc_sz.0, acc_sz.1),
                src_size: acc_sz,
                alpha: 1.0,
            });
        }
        // The blur drafts lived across the whole round loop (like the batch atlases); hand them to the
        // frame-transient list so they return to the pool after the frame, not at a per-node recycle.
        self.frame_transient.extend(draft_texs);
        backend.phased_finish(device, queue, &mut enc);
        crate::vello::prof::dbg_add(27, crate::vello::prof::now() - _tpl);

        if let Some(p) = self.pass_prof.as_mut() {
            p.stamp(&mut enc, &views[final_slot], crate::vello::graph::prof_bucket::OTHER);
        }
        self.present_final(&mut enc, device, &sw_view, &views[final_slot], width, height, format, sz, acc_sz, full_view);
        if let Some(p) = self.pass_prof.as_mut() {
            p.stamp(&mut enc, &sw_view, crate::vello::graph::prof_bucket::SWAP_BLIT);
        }
        if let Some((view, aw, ah)) = self.dbg_atlas.take() {
            #[cfg(not(target_arch = "wasm32"))]
            if std::env::var("WV_DBG_CLEAR").is_ok() {
                Compositor::clear(&mut enc, &sw_view, [0.0, 0.0, 0.0, 0.0], None);
            }
            #[cfg(not(target_arch = "wasm32"))]
            let dbg_y: f32 = std::env::var("WV_DBG_ATLAS_Y").ok().and_then(|v| v.parse().ok()).unwrap_or(0.0);
            #[cfg(target_arch = "wasm32")]
            let dbg_y = 0.0f32;
            self.compositor.blit(device, &mut enc, &sw_view, sz, &Blit {
                src: &view,
                dst: (0.0, 0.0, aw as f32, ah as f32),
                src_rect: (0.0, dbg_y, aw as f32, ah as f32),
                src_size: (aw as f32, ah as f32),
                alpha: 1.0,
            });
        }
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
            self.canvas_view = None;
        }
    }

    /// Present the finished whole-viewport frame `final_view` to the swapchain. With present-on-demand
    /// on, first RETAIN it into the persistent canvas (so a later unchanged frame can re-present it)
    /// and record the view it was rendered at, then blit canvas → swapchain. Off: a single direct blit,
    /// byte-identical to the original path.
    ///
    /// `sz` is the viewport (what gets presented); `acc_sz` is the accumulator's own size, which is
    /// taller than the viewport whenever a source strip rode along below it. They differ only in the
    /// sampling denominator — the presented region is always the viewport rectangle at the origin.
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
        acc_sz: (f32, f32),
        full_view: Affine,
    ) {
        let viewport = Blit {
            src: final_view,
            dst: (0.0, 0.0, sz.0, sz.1),
            src_rect: (0.0, 0.0, sz.0, sz.1),
            src_size: acc_sz,
            alpha: 1.0,
        };
        if crate::vello::abi::present_on_demand() {
            self.ensure_canvas(device, width, height, format);
            let cv = self.canvas.as_ref().expect("canvas ensured").1.clone();
            Compositor::clear(enc, &cv, [0.0, 0.0, 0.0, 0.0], None);
            self.compositor.blit(device, enc, &cv, sz, &viewport);
            self.compositor.blit(device, enc, sw_view, sz, &viewport);
            self.canvas_view = Some(full_view);
        } else {
            self.compositor.blit(device, enc, sw_view, sz, &viewport);
        }
    }

    /// The lens shape's outline as DEVICE-space line segments for the SDF bake — `Some` only for a path
    /// (a non-box shape whose glass must follow the real outline, not the analytic rounded box). The
    /// outline is `full_view · modifier · local`, exactly the device transform the shape is drawn under,
    /// so the baked field lands on the shape's own device pixels.
    fn wv_lens_sdf_segments(&self, id: u128, full_view: Affine) -> Option<Vec<[f32; 4]>> {
        let path = crate::vello::abi::with_scene(|live, _, modifiers| {
            let n = live.get(id)?;
            if n.kind != crate::model::ShapeKind::Path {
                return None;
            }
            let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
            Some(full_view * m * crate::geometry::outline(n))
        })?;
        Some(crate::vello::sdf::flatten_segments(&path, 0.3))
    }

    fn wv_lens_box(&self, id: u128, full_view: Affine, width: u32, height: u32) -> Option<(u32, u32, u32, u32, f64)> {
        use crate::kurbo::Point;
        let page = crate::vello::abi::with_scene(|live, _, modifiers| {
            let n = live.get(id)?;
            let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
            Some(crate::schedule::page_bounds(n, m))
        })?;
        let cs = full_view.as_coeffs();
        let scale = (cs[0] * cs[0] + cs[1] * cs[1]).sqrt() as f32;
        let sigma = crate::vello::abi::with_scene(|live, _, _| {
            live.get(id).and_then(|n| n.glass).map_or(0.0, |g| g.total_blur_sigma() * scale)
        });
        let reach = 3.0 * f64::from(sigma) + 20.0;
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
            return None;
        }
        let declared = f64::from(
            crate::vello::abi::with_scene(|live, _, _| {
                live.get(id).map_or(1.0_f32, |n| n.glass.map_or(1.0, |g| g.acceptable_downscale))
            })
            .clamp(f32::MIN_POSITIVE, 1.0),
        );
        let k = tiling::resolution_cap(full_view, reach / f64::from(scale)).min(declared);
        Some((bx, by, bw, bh, k))
    }

    /// The device-space box an effect node's whole-viewport stamp (and its blur neighbourhood) can
    /// touch — the region whose tiles need this node's `CMD_EFFECT` boundary marker. A stack node's
    /// marks composite inside the union of its effects' device footprints (plus the body's own box);
    /// a gather stamps inside its lens bbox expanded by the blur reach (lens adds refraction slack);
    /// a custom backdrop shader may sample and stamp anywhere, so it keeps the full viewport, as do
    /// all gathers when `wvScope` is off (the unscoped stamp blits the whole viewport). Padded a tile
    /// so partially-covered edge tiles are included.
    /// Feed the drag-resolution probe (`wv_scale_probe`) while a stack shape is being dragged: its
    /// body's device box and render width. Bodies render at device scale on the marks path, so the
    /// probe's scale slot reports a constant 1.0.
    fn wv_drag_probe(id: u128, bx: u32, by: u32, bw: u32, bh: u32) {
        let dragged = crate::vello::abi::with_scene(|_, _, modifiers| {
            modifiers.get(&id).is_some_and(|m| *m != Affine::IDENTITY)
        });
        if dragged {
            crate::vello::prof::dbg_set(16, f64::from(bx));
            crate::vello::prof::dbg_set(17, f64::from(by));
            crate::vello::prof::dbg_set(18, f64::from(bw));
            crate::vello::prof::dbg_set(19, f64::from(bh));
            crate::vello::prof::dbg_set(23, f64::from(bw));
            crate::vello::prof::dbg_set(29, 1000.0);
        }
    }

    fn wv_marker_reach(&self, id: u128, kind: u8, full_view: Affine, width: u32, height: u32) -> [f32; 4] {
        let full = [0.0, 0.0, width as f32, height as f32];
        const NONE: [f32; 4] = [0.0, 0.0, 0.0, 0.0];
        const PAD: f32 = 16.0;
        if kind == FX_STACK {
            let Some((base, stack)) = crate::vello::abi::with_scene(|live, _, modifiers| {
                let node = live.get(id)?;
                let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
                Some((crate::schedule::page_bounds(node, m), crate::effect::effect_stack(node)))
            }) else {
                return NONE;
            };
            let (mut x0, mut y0, mut x1, mut y1) =
                (f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
            let mut any = false;
            let mut has_body = false;
            let mut union = |bx: u32, by: u32, bw: u32, bh: u32| {
                x0 = x0.min(bx as f32);
                y0 = y0.min(by as f32);
                x1 = x1.max((bx + bw) as f32);
                y1 = y1.max((by + bh) as f32);
            };
            for effect in &stack {
                if effect.reads_backdrop()
                    || !matches!(effect.source, Source::Coverage { .. } | Source::Body)
                {
                    continue;
                }
                let Some((bx, by, bw, bh)) =
                    wv_device_box(effect.footprint(base), full_view, width, height)
                else {
                    continue;
                };
                union(bx, by, bw, bh);
                any = true;
                if matches!(effect.source, Source::Body) {
                    has_body = true;
                    Self::wv_drag_probe(id, bx, by, bw, bh);
                }
            }
            if !has_body {
                if let Some((bx, by, bw, bh)) = wv_device_box(base, full_view, width, height) {
                    union(bx, by, bw, bh);
                    any = true;
                    Self::wv_drag_probe(id, bx, by, bw, bh);
                }
            }
            if !any {
                return NONE;
            }
            return [x0 - PAD, y0 - PAD, x1 + PAD, y1 + PAD];
        }
        use crate::effect::Op;
        use crate::kurbo::Point;
        let Some(page) = crate::vello::abi::with_scene(|live, _, modifiers| {
            let n = live.get(id)?;
            let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
            Some(crate::schedule::page_bounds(n, m))
        }) else {
            return full;
        };
        let eff = Self::wv_backdrop_effect(id);
        let head = eff.as_ref().and_then(|e| e.ops.first());
        let cs = full_view.as_coeffs();
        let scale = (cs[0] * cs[0] + cs[1] * cs[1]).sqrt() as f32;
        // A sampling head (Lens) displaces past its blur, so it pads wider (refraction slack); a plain
        // gather blur pads to its own reach. Both numerators are `3·sigma`, from the head op itself.
        let reach = match head {
            Some(Op::Lens(g)) => 3.0 * f64::from(g.total_blur_sigma() * scale) + 20.0,
            _ => 3.0 * f64::from(self.gather_sigma(id, full_view, 1.0)) + 6.0,
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
        if maxx + f64::from(PAD) <= 0.0
            || maxy + f64::from(PAD) <= 0.0
            || minx - f64::from(PAD) >= f64::from(width)
            || miny - f64::from(PAD) >= f64::from(height)
        {
            return NONE;
        }
        if !crate::vello::abi::wv_scope() {
            return full;
        }
        [minx as f32 - PAD, miny as f32 - PAD, maxx as f32 + PAD, maxy as f32 + PAD]
    }

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

        let max_dim = device.limits().max_texture_dimension_2d;
        let Some(packing) = pack_grid(candidates.len(), TILE_BUFFER, max_dim) else {
            return none;
        };
        let (aw, ah) = (packing.width, packing.height);

        let mut scene = backend.new_scene(aw as u16, ah as u16);
        for cell in &packing.cells {
            let (_, write_to, ops) = &candidates[cell.index];
            let Some(tile) = write_to.tile else { continue };
            let (ox, oy) = tiling::tile_device_origin(tile, full_view);
            let m = f64::from(TILE_MARGIN);
            let root_for_cell = Affine::translate((f64::from(cell.x) + m - ox, f64::from(cell.y) + m - oy)) * root;
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

        let mut cands: Vec<(usize, SurfaceRef, Vec<PaintOp>, u32, u32, f64, f64)> = Vec::new();
        for i in first_write_paints(steps) {
            let Step::Paint { ops, write_to, clip } = &steps[i] else { continue };
            let SurfaceRole::RasterEffectOutput(id) = write_to.role else { continue };
            let has_texture = crate::vello::abi::with_scene(|live, _, _| {
                live.get(id).and_then(|n| n.texture).is_some_and(|t| !t.hidden && t.radius > 0.0)
            });
            if has_texture {
                continue;
            }
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
        crate::vello::prof::dbg_set(0, cands.len() as f64);
        if cands.len() < ATLAS_MIN {
            return none;
        }

        let sizes: Vec<(u32, u32)> = cands.iter().map(|c| (c.3, c.4)).collect();
        crate::vello::prof::dbg_set(1, sizes.iter().map(|s| u64::from(s.0)).max().unwrap_or(0) as f64);
        crate::vello::prof::dbg_set(2, sizes.iter().map(|s| u64::from(s.1)).max().unwrap_or(0) as f64);
        let Some(packing) = shelf_pack(&sizes, GAP, 2048, max_dim) else {
            crate::vello::prof::dbg_set(3, 1.0);
            return none;
        };
        crate::vello::prof::dbg_set(4, packing.height as f64);
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

        enum Op {
            Plain(usize, Vec<PaintOp>, Rect),
            Spread(usize, SurfaceRef, Rect, f32),
        }
        let fuse_gathers = crate::vello::abi::fuse_gathers();
        let mut per_tile: std::collections::HashMap<TileKey, Vec<Op>> = std::collections::HashMap::new();
        let mut order: Vec<TileKey> = Vec::new();
        let mut disq: HashSet<TileKey> = HashSet::new();
        let mut gather_above: HashSet<TileKey> = HashSet::new();

        for (i, step) in steps.iter().enumerate() {
            match step {
                Step::Paint { ops, clip, write_to } => {
                    if matches!(write_to.role, SurfaceRole::TileOutput) {
                        if let Some(t) = write_to.tile {
                            if fuse_gathers && gather_above.contains(&t) {
                                disq.insert(t);
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
                            if matches!(from.role, SurfaceRole::RasterEffectOutput(_))
                                && self.surfaces.contains_key(from)
                                && crate::vello::blend::mix_code(paint.blend.mix) == 0
                            {
                                if fuse_gathers && gather_above.contains(&t) {
                                    disq.insert(t);
                                } else {
                                    if !per_tile.contains_key(&t) {
                                        order.push(t);
                                    }
                                    per_tile.entry(t).or_default()
                                        .push(Op::Spread(i, *from, *rect, paint.opacity));
                                }
                            } else {
                                disq.insert(t);
                            }
                        }
                    }
                    _ => {}
                },
                Step::ComposeBackdrop { shape, .. } | Step::PaintGather { shape, .. }
                    if batched_gathers.contains_key(shape) => {}
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

        for (_, handle) in handles {
            backend.unregister_inline_image(handle);
        }

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

    #[cfg(feature = "tiled-scheduler")]
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
        const GAP: u32 = 8;
        let max_dim = device.limits().max_texture_dimension_2d;
        let bg = crate::vello::abi::background().components;
        let bgc = [f64::from(bg[0]), f64::from(bg[1]), f64::from(bg[2]), f64::from(bg[3])];

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
                    let snap = SurfaceRef::snapshot(plan.gathers[c.gi].shape, tile);
                    let tile_ref = SurfaceRef::tile_ref(SurfaceRole::TileOutput, tile);
                    let Some(src_view) =
                        self.backdrop_source(&snap).or_else(|| self.backdrop_source(&tile_ref))
                    else {
                        continue;
                    };
                    let (ox, oy) = tiling::tile_device_origin(tile, full_view);
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
            Self::submit_batch(enc, device, queue, backend);

            let sigma = self.gather_sigma(plan.gathers[cells[0].gi].shape, full_view, cells[0].k);
            let passes = if stages & 2 == 0 { Vec::new() } else { lower_graph(&effect_graph::background_blur_graph(sigma)) };
            let Some((blur_atlas, blur_view)) =
                run_graph(&self.compositor, &self.unit_pipeline, device, queue, &[&bd_view], &passes, aw, ah, format)
            else {
                self.frame_transient.push(bd_atlas);
                continue;
            };

            if crate::vello::abi::debug_atlas() == 2 {
                self.dbg_atlas = Some((blur_view.clone(), aw, ah));
            }
            let mask_atlas = new_target_with_usage(device, aw, ah, format, self.raster_usage);
            let mask_view = mask_atlas.create_view(&wgpu::TextureViewDescriptor::default());
            if stages & 4 != 0 {
                let masks = packing.cells.iter().map(|cell| {
                    let c = &cells[cell.index];
                    let root_for_cell = Affine::translate((f64::from(cell.x), f64::from(cell.y)))
                        * Affine::scale(c.k)
                        * Affine::translate((-c.bdx, -c.bdy))
                        * root;
                    (plan.gathers[c.gi].shape, root_for_cell)
                });
                rasterize_masks(backend, device, queue, enc, &mask_view, aw, ah, CLEAR, masks);
            }

            if crate::vello::abi::debug_atlas() == 3 {
                self.dbg_atlas = Some((mask_view.clone(), aw, ah));
            }
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

    #[cfg(feature = "tiled-scheduler")]
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

    #[cfg(feature = "tiled-scheduler")]
    fn backdrop_source(&self, src_ref: &SurfaceRef) -> Option<wgpu::TextureView> {
        if let Some(s) = self.surfaces.get(src_ref) {
            return Some(s.view.clone());
        }
        if !matches!(src_ref.role, SurfaceRole::TileOutput) {
            return None;
        }
        self.tile_cache.get(src_ref.tile?).map(|s| s.view.clone())
    }

    fn ensure_surface(&mut self, key: SurfaceRef, device: &wgpu::Device, w: u32, h: u32, format: wgpu::TextureFormat) {
        if self.surfaces.contains_key(&key) {
            return;
        }
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
        let (w, h, root_for_target) = match write_to.role {
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

        if let SurfaceRole::RasterEffectOutput(id) = write_to.role {
            self.texture_over_body(id, write_to, device, enc, format);
            if !backend.blurs_layer_inline() {
                self.layer_blur_over_body(id, write_to, device, enc, full_view, format);
            }
        }
    }

    /// Warp a textured shape's freshly-rendered body surface **in place** by the noise-displacement
    /// units ([`effect_graph::texture_graph`]) — the same Warp + ClipToSource chain the whole-viewport
    /// cell path runs. No-op when the shape has no live texture effect.
    fn texture_over_body(
        &mut self,
        id: u128,
        write_to: SurfaceRef,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        format: wgpu::TextureFormat,
    ) {
        let Some(t) = crate::vello::abi::with_scene(|live, _, _| live.get(id).and_then(|n| n.texture)) else {
            return;
        };
        if t.hidden || t.radius <= 0.0 {
            return;
        }
        let Some(surf) = self.surfaces.get(&write_to) else { return };
        let (w, h) = (surf.width, surf.height);
        let input_view = surf.view.clone();
        let passes = lower_graph(&effect_graph::texture_graph(
            w as f32,
            h as f32,
            t.radius * crate::effect::TEXTURE_RADIUS_SCALE,
            t.noise_size.max(1.0),
            t.clip_to_shape,
        ));
        let out = run_graph_into(
            &self.compositor, &self.unit_pipeline, device, enc, &[&input_view], &passes, w, h, format,
            &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views, None,
        );
        let Some((tex, view)) = out else { return };
        if let Some(old) = self.surfaces.insert(write_to, Surface { texture: tex, view, width: w, height: h }) {
            self.frame_transient.push(old.texture);
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
        let sigma = crate::geometry::cap_sigma_to_device(crate::blur::radius_to_sigma(radius), full_view);
        if sigma < 0.5 {
            return;
        }
        let passes = lower_graph(&effect_graph::background_blur_graph(sigma));
        let out = run_graph_into(
            &self.compositor, &self.unit_pipeline, device, enc, &[&input_view], &passes, w, h, format,
            &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views, None,
        );
        let Some((tex, view)) = out else { return };
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
        enc: &mut wgpu::CommandEncoder,
        sw_view: &wgpu::TextureView,
        full_view: Affine,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
    ) {
        let Some(src) = self.surfaces.get(&from) else { return };
        let src_view = src.view.clone();
        let src_size = (src.width as f32, src.height as f32);
        let alpha = paint.opacity;
        let mix = crate::vello::blend::mix_code(paint.blend.mix);

        match to.role {
            SurfaceRole::Target => {
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
            SurfaceRole::TileOutput | SurfaceRole::ScopeOf(_) => {
                let Some(tile) = to.tile else { return };
                self.ensure_surface(to, device, TILE_BUFFER, TILE_BUFFER, format);
                let to_view = self.surfaces[&to].view.clone();
                if self.written.insert(to) {
                    Compositor::clear(enc, &to_view, [0.0, 0.0, 0.0, 0.0], None);
                }
                let buf = TILE_BUFFER as f32;
                let (dst, src_rect) = if matches!(from.role, SurfaceRole::RasterEffectOutput(_)) {
                    let (ox, oy) = tiling::tile_device_origin(tile, full_view);
                    let m = f64::from(TILE_MARGIN);
                    let (dx, dy, dw, dh) = tiling::device_rect(full_view, rect);
                    (
                        ((dx - ox + m) as f32, (dy - oy + m) as f32, dw as f32, dh as f32),
                        (0.0, 0.0, src_size.0, src_size.1),
                    )
                } else {
                    ((0.0, 0.0, buf, buf), (0.0, 0.0, src_size.0, src_size.1))
                };
                if mix != 0 {
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

    #[cfg(feature = "tiled-scheduler")]
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
        let mut k = tiling::resolution_cap(full_view, reach);
        if always_cap {
            let ceiling = f64::from(TILE_BUFFER) / bw.max(bh).max(1.0);
            k = k.min(ceiling).min(1.0);
        }
        k = k.min(acceptable_downscale.clamp(f64::MIN_POSITIVE, 1.0));
        let w = ((bw * k).ceil() as u32).clamp(1, 4096);
        let h = ((bh * k).ceil() as u32).clamp(1, 4096);
        self.ensure_surface(write_to, device, w, h, format);
        self.written.insert(write_to);
        self.backdrop_origin.insert(write_to, (bdx, bdy));
        self.backdrop_scale.insert(write_to, k);
        let bd_view = self.surfaces[&write_to].view.clone();
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
                if rect[0] < rect[2] && rect[1] < rect[3] {
                    let usage = wgpu::TextureUsages::RENDER_ATTACHMENT
                        | wgpu::TextureUsages::TEXTURE_BINDING
                        | wgpu::TextureUsages::COPY_DST
                        | wgpu::TextureUsages::COPY_SRC
                        | self.raster_usage;
                    let filled = self.pool.acquire(device, PoolKey { w, h, format, usage: usage.bits() }, "clamp fill");
                    let filled_view = filled.create_view(&wgpu::TextureViewDescriptor::default());
                    self.unit_pipeline.clamp_fill(device, enc, &filled_view, &bd_view, (w as f32, h as f32), rect);
                    if let Some(old) = self.surfaces.insert(write_to, Surface { texture: filled, view: filled_view, width: w, height: h }) {
                        self.frame_transient.push(old.texture);
                    }
                }
            }
        }
    }

    /// Assemble a gather effect's result once (cached under the bumped ref) via [`run_graph`], then
    /// stamp it into `write_to`'s tile — through the shape's silhouette mask for background blur, or
    /// its device rect for lens (whose SDF mask is baked into the composite). The shape's own body
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
        let k = self.backdrop_scale.get(&backdrop).copied().unwrap_or(1.0);

        let self_clips = Self::wv_gather_self_clips(id);

        let result_ref = backdrop.bump();
        let mask_ref = backdrop.bump().bump();
        if !self.surfaces.contains_key(&result_ref) {
            let passes = self.wv_gather_graph(id, bw, bh, bdx, bdy, full_view, k);
            let Some(passes) = passes else { return };
            Self::submit_batch(enc, device, queue, backend);
            let backdrop_view = self.surfaces[&backdrop].view.clone();
            let mut genc = device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("inline gather graph") });
            let out = run_graph_into(
                &self.compositor, &self.unit_pipeline, device, &mut genc, &[&backdrop_view], &passes, bw, bh, format,
                &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views, None,
            );
            queue.submit([genc.finish()]);
                let Some((tex, view)) = out else { return };
            self.surfaces.insert(result_ref, Surface { texture: tex, view, width: bw, height: bh });

            if !self_clips {
                let mask = new_target_with_usage(device, bw, bh, format, self.raster_usage);
                let mask_view = mask.create_view(&wgpu::TextureViewDescriptor::default());
                let root_for_mask = Affine::scale(k) * Affine::translate((-bdx, -bdy)) * root;
                rasterize_masks(backend, device, queue, enc, &mask_view, bw, bh, CLEAR, [(id, root_for_mask)]);
                self.surfaces.insert(mask_ref, Surface { texture: mask, view: mask_view, width: bw, height: bh });
            }
        }
        let result_view = self.surfaces[&result_ref].view.clone();

        let Some(tile) = write_to.tile else { return };
        let (ox, oy) = tiling::tile_device_origin(tile, full_view);
        let (sdx, sdy, sdw, sdh) = tiling::device_rect(full_view, clip);
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
        let src_rect = (((ix0 - bdx) * k) as f32, ((iy0 - bdy) * k) as f32, ((ix1 - ix0) * k) as f32, ((iy1 - iy0) * k) as f32);
        let src_size = (bw as f32, bh as f32);
        if self_clips {
            let b = Blit { src: &result_view, dst, src_rect, src_size, alpha: 1.0 };
            if k < 0.999 {
                self.compositor.blit_sharp(device, enc, &to_view, buf, &b);
            } else {
                self.compositor.blit(device, enc, &to_view, buf, &b);
            }
        } else {
            let mask_view = self.surfaces[&mask_ref].view.clone();
            let mb = MaskedBlit { src: &result_view, mask: &mask_view, dst, src_rect, src_size, alpha: 1.0 };
            if k < 0.999 {
                self.compositor.blit_masked_sharp(device, enc, &to_view, buf, &mb);
            } else {
                self.compositor.blit_masked(device, enc, &to_view, buf, &mb);
            }
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
        let (edx, edy, edw, edh) = tiling::device_rect(full_view, extent);
        let w = edw.ceil().max(1.0) as u32;
        let h = edh.ceil().max(1.0) as u32;
        const MAX_SHADOW: u32 = 4096;
        if w > MAX_SHADOW || h > MAX_SHADOW {
            return;
        }

        let sil = self.pool.acquire_target(device, w, h, format, self.raster_usage, "path shadow silhouette");
        let sil_view = sil.create_view(&wgpu::TextureViewDescriptor::default());
        let root_for_sil = Affine::translate((-edx, -edy)) * root;
        let mut sscene = backend.new_scene(w as u16, h as u16);
        backend.build_shadow_silhouette(&mut sscene, root_for_sil, shape, shadow, false, true, true);
        backend.rasterize(&sscene, device, queue, enc, &sil_view, w, h, TRANSPARENT);

        let c = full_view.as_coeffs();
        let scale = (c[0] * c[0] + c[1] * c[1]).sqrt() as f32;
        let device_sigma = sigma * scale;
        let blurred_view = if device_sigma >= 0.5 {
            let passes = lower_graph(&effect_graph::background_blur_graph(device_sigma));
            let Some((_tex, view)) = run_graph_into(
                &self.compositor, &self.unit_pipeline, device, enc, &[&sil_view], &passes, w, h, format,
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

        let flood = self.pool.acquire_target(device, w, h, format, self.raster_usage, "inner shadow flood");
        let flood_view = flood.create_view(&wgpu::TextureViewDescriptor::default());
        let mut fscene = backend.new_scene(w as u16, h as u16);
        backend.build_shadow_silhouette(&mut fscene, root_for_sil, shape, shadow, true, false, true);
        backend.rasterize(&fscene, device, queue, enc, &flood_view, w, h, TRANSPARENT);

        let punch = self.pool.acquire_target(device, w, h, format, self.raster_usage, "inner shadow punch");
        let punch_view = punch.create_view(&wgpu::TextureViewDescriptor::default());
        let mut pscene = backend.new_scene(w as u16, h as u16);
        backend.build_shadow_silhouette(&mut pscene, root_for_sil, shape, shadow, true, true, true);
        backend.rasterize(&pscene, device, queue, enc, &punch_view, w, h, TRANSPARENT);

        let c = full_view.as_coeffs();
        let scale = (c[0] * c[0] + c[1] * c[1]).sqrt() as f32;
        let device_sigma = sigma * scale;
        if device_sigma >= 0.5 {
            let passes = lower_graph(&effect_graph::background_blur_graph(device_sigma));
            let Some((ptex, pview)) = run_graph_into(
                &self.compositor, &self.unit_pipeline, device, enc, &[&punch_view], &passes, w, h, format,
                &mut self.pool, &mut self.frame_transient, &mut self.frame_transient_views, None,
            ) else {
                self.frame_transient.push(flood);
                self.frame_transient.push(punch);
                return;
            };
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

    /// The node's single backdrop-reading effect, if any — the one a gather runs. The stack holds at
    /// most one ([`crate::effect::effect_stack`]'s `else if` chain), so `find` is the whole answer.
    fn wv_backdrop_effect(id: u128) -> Option<crate::effect::Effect> {
        crate::vello::abi::with_scene(|live, _, _| {
            live.get(id)
                .and_then(|n| crate::effect::effect_stack(n).into_iter().find(crate::effect::Effect::reads_backdrop))
        })
    }

    /// Lower a gather's chain by asking the effect what its head op is, not by asking whether the node
    /// is a lens. `Lens` carries its own SDF clip (composite blits whole); `Blur`/`Shader` are clipped
    /// by an external silhouette mask — [`Self::wv_gather_self_clips`] states which.
    fn wv_gather_graph(
        &mut self,
        id: u128,
        bw: u32,
        bh: u32,
        bdx: f64,
        bdy: f64,
        full_view: Affine,
        k: f64,
    ) -> Option<Vec<Pass>> {
        use crate::effect::Op;
        match Self::wv_backdrop_effect(id)?.ops.first()? {
            Op::Lens(_) => self.lens_graph(id, bw, bh, bdx, bdy, full_view, k),
            Op::Blur { .. } => {
                Some(lower_graph(&effect_graph::background_blur_graph(self.gather_sigma(id, full_view, k))))
            }
            _ => None,
        }
    }

    /// Whether a gather's chain clips itself — true only for a `Lens` head, whose composite carries an
    /// SDF mask. Everything else needs the shape silhouette masked in after the chain runs.
    fn wv_gather_self_clips(id: u128) -> bool {
        Self::wv_backdrop_effect(id)
            .is_some_and(|e| matches!(e.ops.first(), Some(crate::effect::Op::Lens(_))))
    }

    /// Build the lens pass-graph over the assembled backdrop (input 0). The geometry→uniform math is
    /// render-core's [`effect_graph::lens_graph`]; this only reads the shape's lens params/box off
    /// the live scene and lowers the neutral graph (no custom pass, so no pipeline to resolve). Lens
    /// geometry is the shape's rounded box (axis-aligned; rotation is a gap); the composite's own SDF
    /// mask does the clip, so no silhouette mask is needed.
    /// The glass params and its device-independent [`LensGeometry`] for `id`, shared by the batched
    /// lens graph and the effects-in-fine frosted chain.
    fn lens_geom(&self, id: u128) -> Option<(crate::model::Glass, LensGeometry)> {
        crate::vello::abi::with_scene(|live, _, modifiers| {
            let n = live.get(id)?;
            let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
            crate::effect_graph::lens_geometry(n, m)
        })
    }

    fn lens_graph(&self, id: u128, bw: u32, bh: u32, bdx: f64, bdy: f64, full_view: Affine, k: f64) -> Option<Vec<Pass>> {
        let (g, geom) = self.lens_geom(id)?;
        let graph = effect_graph::lens_graph_scaled(&g, geom, (bw, bh), (bdx, bdy), full_view, k);
        Some(lower_graph(&graph))
    }


    /// The device-space 24-float lens field uniform for glass `gid`, for the effects-in-fine WARP path
    /// (`fx_computeField_lens` in fine.wgsl). Built like the batched lens but at DEVICE resolution —
    /// backdrop origin `(0,0)`, `k = 1` — so `fine` evaluates the field in global pixel coordinates and
    /// samples `base_in` there. `None` unless the glass is SHARP (no frost/blur): a blurred lens is a
    /// barrier `fine` cannot run inline (a neighbourhood, not a single displaced tap).
    fn wv_lens_fine_uniform(&self, gid: u128, full_view: Affine, w: u32, h: u32) -> Option<[f32; 24]> {
        let sharp = crate::vello::abi::with_scene(|live, _, _| {
            live.get(gid).and_then(|n| n.glass).is_some_and(|g| g.total_blur_sigma() <= 0.5)
        });
        if !sharp {
            return None;
        }
        let passes = self.lens_graph(gid, w, h, 0.0, 0.0, full_view, 1.0)?;
        match batch_admit(&passes) {
            Some(BatchShape::Lens { head, tail, .. }) => {
                let mut ops = vec![head];
                ops.extend(tail);
                Some(crate::vello::units::units_uniform(&ops))
            }
            _ => None,
        }
    }


}

#[cfg(test)]
mod batch_admission_tests {
    use super::{batch_admit, BatchShape};
    use crate::effect_graph::{drop_shadow_graph, inner_shadow_graph, tint_graph, GraphPass};
    use crate::vello::graph::lower_graph;

    const C: [f32; 4] = [0.1, 0.2, 0.3, 0.8];

    fn admit(g: &[GraphPass]) -> Option<BatchShape> {
        batch_admit(&lower_graph(g))
    }

    /// Admission is what decides whether shadows batch at all, and pixels cannot prove it: a
    /// rejected chain falls back to the per-shape path, which renders the same image.
    #[test]
    fn the_shadow_chains_admit_as_stamps() {
        for g in [
            drop_shadow_graph(64.0, 64.0, C, 4.0),
            drop_shadow_graph(64.0, 64.0, C, 0.0),
            tint_graph(64.0, 64.0, C),
            inner_shadow_graph(64.0, 64.0, C, 4.0),
        ] {
            assert!(matches!(admit(&g), Some(BatchShape::Stamp { .. })), "expected a stamp");
        }
    }

    /// One blur per cell is what the H/V stage pair expresses; a second would need a round trip the
    /// plan does not allocate.
    #[test]
    fn two_blurs_in_one_cell_are_refused() {
        let mut g = drop_shadow_graph(64.0, 64.0, C, 4.0);
        let blur = g
            .iter()
            .find(|p| matches!(p.pass, crate::effect_graph::EffectPass::Blur { .. }))
            .expect("a blurred drop shadow has a blur")
            .clone();
        g.push(blur);
        assert_eq!(admit(&g), None);
    }

    /// A sigma past the separable cap still belongs on the per-shape path.
    #[test]
    fn a_blur_past_the_cap_is_refused() {
        let big = crate::vello::graph::BLUR_MAX_SIGMA + 1.0;
        assert_eq!(admit(&drop_shadow_graph(64.0, 64.0, C, big)), None);
    }

    /// The head is what separates the two stage families: a sampling unit is a lens, everything
    /// pointwise is a stamp. This is the distinction the two old predicates encoded separately, and
    /// the reason a chain could previously belong to neither.
    #[test]
    fn a_sampling_head_admits_as_a_lens_not_a_stamp() {
        use crate::vello::units::UnitOp;
        use crate::vello::graph::Pass;
        let units = |ops: Vec<UnitOp>| Pass {
            units: ops,
            field: Some(std::rc::Rc::new(crate::field::FieldProgram {
                nodes: Vec::new(),
                outputs: Vec::new(),
            })),
            inputs: Vec::new(),
            scale: 1.0,
        };
        let u = || vec![0.0_f32; 24];

        let lens = units(vec![UnitOp::Warp(u()), UnitOp::MaskMix(u())]);
        match batch_admit(&[lens]) {
            Some(BatchShape::Lens { tail, sigma, .. }) => {
                assert_eq!(tail.len(), 1, "the tail is everything after the head");
                assert_eq!(sigma, 0.0, "a sharp lens has no blur");
            }
            other => panic!("a sampling head is a lens, got {other:?}"),
        }

        // Pointwise units the stamp stages do not implement are refused outright rather than
        // silently falling into the wrong family.
        assert_eq!(batch_admit(&[units(vec![UnitOp::MaskMix(u())])]), None);
    }
}
