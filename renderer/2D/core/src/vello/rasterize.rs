//! The `SceneRasterizer` seam — the *one* operation that differs between Vello backends.
//!
//! Everything else the sink needs is already shared: the schedule (render-core), the tile cache /
//! atlas / effect-graph policy (render-core), and the device-generic effect executor ([`crate::vello::blend`]
//! / [`crate::vello::glass`] / [`crate::vello::graph`]). What a backend must still supply is how it turns a built
//! scene into pixels in a texture:
//!
//! - **vello_hybrid**: `Renderer::render(scene, resources, device, queue, &mut encoder, size, view,
//!   bindings)` — the caller owns the encoder, and a second write to the same target can *load*
//!   (accumulate) rather than clear.
//! - **classic vello**: `Renderer::render_to_texture(device, queue, scene, view, &RenderParams)` —
//!   it owns its encoder/submit, and **always clears to `base_color`** (there is no load variant).
//!
//! That load-vs-clear difference is the real design point of the sink carve: the hybrid sink relies
//! on `render_load` to accumulate several paints into one tile surface, which classic cannot do — on
//! classic a tile's content is rendered as one scene (the scheduler's coalescing already batches most
//! of it) and anything that must layer on top is composited through [`crate::vello::blend`], not loaded. The
//! trait therefore deliberately exposes only a *clear-and-render* rasterize; accumulation is the
//! sink's job, above this seam, using the shared compositor — so both backends express it the same
//! way.

use crate::kurbo::{Affine, Rect, Shape};
use crate::peniko::Color;
use crate::schedule::PaintOp;
use vello_example_scenes::RenderingContext;

/// The **sink's** full backend seam: everything the GPU production sink ([`crate`]'s scheduler sink)
/// needs from a Vello flavor, so the sink body holds no concrete backend type.
///
/// It bundles the two operations that diverge between backends:
///
/// - **scene building** — turn a scheduler `Paint` step (a z-ordered run of [`PaintOp`]s) or a
///   gather coverage mask into a built scene. The hybrid backend routes this through its
///   `NeutralModelScene` walk (reading the live model + text + modifiers off its ABI globals); the
///   classic backend runs the shared [`crate::vello::draw`] path over its `RenderingContext`. Either way the
///   sink just says *"draw these ops into this scene at this transform"*.
/// - **rasterization** — turn a built scene into pixels in a texture, clearing first (see
///   [`SceneRasterizer`] for why this is deliberately clear-only, with accumulation lifted into the
///   sink via the shared compositor).
///
/// Keeping both behind one trait is what lets the sink be written once: it allocates surfaces, runs
/// the schedule, and composites — all in backend-neutral terms — while each flavor supplies only how
/// a scene is built and rasterized.

/// Sentinel `seg_target` for [`RasterBackend::phased_fine_segment`]: no upper bound on the
/// tile-round window (the final window, or — with `seg_lo == 0` — a full render). Matches vello's
/// `SEG_ALL`.
pub const SEG_ALL: u32 = u32::MAX;

pub trait RasterBackend {

    /// The backend's scene type (a `vello_hybrid::Scene`, or the classic `RenderingContext` wrapper).
    ///
    /// Bounded by `RenderingContext` so the seam can express a *clip* once, for both backends —
    /// see [`Self::build_bodies_clipped`].
    type Scene: RenderingContext;

    /// A fresh, empty scene sized `width × height` device pixels, ready to be drawn into.
    fn new_scene(&self, width: u16, height: u16) -> Self::Scene;

    /// Draw a scheduler `Paint` step — a z-ordered run of shape bodies and layer brackets — for the
    /// live document into `scene` at `transform`. Coalescing several plain shapes into one scene is
    /// how a `Paint` becomes a single rasterize.
    fn build_bodies(&mut self, scene: &mut Self::Scene, transform: Affine, ops: &[PaintOp]);

    /// Draw the document's root subtrees in z-index range `[start, end)` into `scene` for the viewport
    /// at `root` — the whole-viewport walk, segmented so effect boundaries can split it. `[0, usize::MAX)`
    /// is the whole tree. Defaults to a no-op (only classic implements the whole-tree walk). `root` is
    /// the page→device transform *without* the viewport applied; the backend composes in the viewport
    /// the same way `build_bodies` does.
    fn draw_scene_range(&mut self, _scene: &mut Self::Scene, _root: Affine, _start: usize, _end: usize) {}

    /// [`Self::build_bodies`], clipped to `clip` — a rect in the **scene's own** pixel space.
    ///
    /// This is what makes it safe to batch several independent surfaces into ONE scene, the way the
    /// sink's atlas prepass does: each surface owns a cell of the atlas, and a shape is only
    /// guaranteed to stay inside its cell if it is clipped to it. Unclipped, anything bigger than a
    /// cell (a board border, a large bake) paints straight through into the neighbouring cells, which
    /// are then copied into the *wrong* surfaces — reproducing that shape one cell away.
    ///
    /// Defaulted in terms of `build_bodies` plus the `RenderingContext` clip both backends already
    /// implement, so no backend has to repeat it.
    fn build_bodies_clipped(
        &mut self,
        scene: &mut Self::Scene,
        transform: Affine,
        ops: &[PaintOp],
        clip: Rect,
    ) {
        scene.set_transform(Affine::IDENTITY);
        scene.push_clip_layer(&clip.to_path(0.1));
        self.build_bodies(scene, transform, ops);
        scene.pop_layer();
    }

    /// Fill exactly one node's silhouette in solid white into `scene` at `transform` — the coverage
    /// mask a gather multiplies into its blurred backdrop so it shows through the shape's outline.
    fn build_mask(&mut self, scene: &mut Self::Scene, transform: Affine, id: u128);

    /// Fill node `id`'s silhouette, **offset by its `shadow`-th drop shadow** and painted in that
    /// shadow's colour, into `scene` at `transform` — the *sharp* source the sink then blurs (via the
    /// same `run_graph` Gaussian background blur uses) and composites behind the body. This is how a
    /// non-box shape (an arbitrary path) gets a soft drop shadow that follows its true outline, since
    /// classic vello has no inline arbitrary-silhouette blur (only a native blurred *rounded-rect*).
    /// The default is a no-op; a backend that supports sink-blurred shadows overrides it.
    ///
    /// `inset` selects which subset `shadow` indexes — the drop shadows (`false`) or the inner shadows
    /// (`true`). `apply_offset` shifts the silhouette by the shadow's offset: a drop shadow and an inner
    /// shadow's *punch* pass `true`; the inner shadow's un-shifted flood passes `false`.
    fn build_shadow_silhouette(&mut self, _scene: &mut Self::Scene, _transform: Affine, _id: u128, _shadow: usize, _inset: bool, _apply_offset: bool, _tinted: bool) {}

    /// Emit a native `CMD_EFFECT` boundary marker for effect node `id` into the z-ordered stream.
    /// `seg_after` (= boundary index + 1) rides in the marker payload: `fine` SETS its running
    /// segment index from it rather than counting markers, so the marker only needs to bin into the
    /// tiles inside `reach` — the device-space `[x0, y0, x1, y1]` box the effect's stamp or blur can
    /// touch. Binning per-reach (not full-viewport) keeps the marker's PTCL/tile cost proportional to
    /// the effect's area instead of `O(all tiles × boundaries)`, which overflowed vello's fixed
    /// budgets at document scale. Default no-op — only the phased (classic) backend emits markers.
    /// `p2` is the marker's third payload word — for an inline effect (`effect_id >= 100`) it is the
    /// float offset of this effect's descriptor in the `effect_params` buffer; `0` otherwise.
    fn draw_effect_marker(&mut self, _scene: &mut Self::Scene, _transform: Affine, _id: u128, _effect_id: u32, _seg_after: u32, _round: u32, _p2: u32, _reach: [f32; 4], _atomic_ctl: u32) {}

    /// Rasterize `scene` into `target` (a `width × height` texture), clearing to `base_color` first.
    ///
    /// Records into the caller's `enc` and does **not** submit: an effect-heavy frame runs hundreds of
    /// these, and a submit each is a driver round-trip plus a GPU sync point. The sink owns one encoder
    /// per frame and submits once; ordering still holds, since commands in one encoder execute in
    /// order and read-after-write between them is ordered.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn rasterize(
        &mut self,
        scene: &Self::Scene,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        width: u32,
        height: u32,
        base_color: Color,
    );

    /// The number of vello draw objects the built `scene` encodes — the index space the segmented
    /// render's boundaries live in. Only classic (the phased backend) reports it; others return `0`.
    fn draw_object_count(&self, _scene: &Self::Scene) -> u32 {
        0
    }

    /// Begin a **persistent** phased render over the whole-viewport `scene`: allocate the session's
    /// shared buffers and hold them on the backend, so the sink can drive fine segments one at a time
    /// with [`Self::phased_fine_segment`] and record an effect's passes (blur/glass/shadow) into the
    /// *same* encoder between them — a whole effect frame in one setup and one submit. Records into
    /// `enc` (no submit). End with [`Self::phased_finish`]. Only classic; default panics.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn phased_begin(
        &mut self,
        _scene: &Self::Scene,
        _device: &wgpu::Device,
        _queue: &wgpu::Queue,
        _enc: &mut wgpu::CommandEncoder,
        _width: u32,
        _height: u32,
        _base_color: Color,
        _effect_params: &[u8],
    ) {
        unimplemented!("phased session is classic-only")
    }

    /// Record the whole scene's front-end + tiling + coarse ONCE (front-end-once), building the shared
    /// PTCL that [`Self::phased_fine_segment`] then walks per segment. Call once after
    /// [`Self::phased_begin`], before the first segment. Records into `enc` (no submit). It needs the
    /// `CMD_EFFECT` markers present in the encoding so `fine` can count segments. Classic-only; default panics.
    fn phased_frontend_full(&mut self, _device: &wgpu::Device, _queue: &wgpu::Queue, _enc: &mut wgpu::CommandEncoder) {
        unimplemented!("phased session is classic-only")
    }

    /// Dispatch `fine` for the segment WINDOW `[seg_lo, seg_target]` of the shared PTCL built by
    /// [`Self::phased_frontend_full`] into `enc`, writing `out`. `fine` composites only the commands
    /// whose running segment index (the payload of the last `CMD_EFFECT` marker) falls in the window
    /// — a window because reach-scoped markers give each tile only the boundaries that matter to it,
    /// and because globally-empty segments are skipped, widening the next dispatch. `base`
    /// (`Some`) is the previous window's output — after the caller's effect passes — loaded and
    /// composited over; `None` clears to the base color (the first window). The window is
    /// `[seg_lo, seg_target)` over per-tile rounds; [`SEG_ALL`] as `seg_target` removes the upper
    /// bound. `base`/`out` are caller-owned `STORAGE_BINDING | TEXTURE_BINDING` textures.
    /// Classic-only; default panics.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn phased_fine_segment(
        &mut self,
        _device: &wgpu::Device,
        _queue: &wgpu::Queue,
        _enc: &mut wgpu::CommandEncoder,
        _seg_lo: u32,
        _seg_target: u32,
        _base: Option<&wgpu::TextureView>,
        _out: &wgpu::TextureView,
    ) {
        unimplemented!("phased session is classic-only")
    }

    /// Dispatch the `fine_area_load_draft` permutation for one window `[seg_lo, seg_target)`: like
    /// [`Self::phased_fine_segment`] with a base, plus a second sampled input `draft` at binding 10 —
    /// a separable blur's V pass, sampling its blur taps from `draft` (its H pass's unmasked result)
    /// and its margin from `base` (the original backdrop). Classic-only; default panics.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn phased_fine_segment_draft(
        &mut self,
        _device: &wgpu::Device,
        _queue: &wgpu::Queue,
        _enc: &mut wgpu::CommandEncoder,
        _seg_lo: u32,
        _seg_target: u32,
        _base: &wgpu::TextureView,
        _draft: &wgpu::TextureView,
        _out: &wgpu::TextureView,
    ) {
        unimplemented!("phased session is classic-only")
    }

    /// Dispatch the `fine_area_load_input` permutation for one window `[seg_lo, seg_target)`: like
    /// [`Self::phased_fine_segment_draft`] but binding 10 is a chained gather's PRIMARY input `input`
    /// (the previous link's materialised surface) rather than a blur draft — a frosted lens's blur-H
    /// (`input` = warp), scatter (`input` = blurred), or tail shade (`input` = scattered). Classic-only;
    /// default panics.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn phased_fine_segment_input(
        &mut self,
        _device: &wgpu::Device,
        _queue: &wgpu::Queue,
        _enc: &mut wgpu::CommandEncoder,
        _seg_lo: u32,
        _seg_target: u32,
        _base: &wgpu::TextureView,
        _input: &wgpu::TextureView,
        _out: &wgpu::TextureView,
    ) {
        unimplemented!("phased session is classic-only")
    }

    /// Whether this backend's device can bind `rgba8unorm` as a READ-WRITE storage texture — the
    /// single-accumulator fast path ([`Self::phased_fine_segment_rw`]). Default false: the driver
    /// keeps the two-texture ping-pong.
    fn rw_accumulator(&self) -> bool {
        false
    }

    /// Dispatch the READ-WRITE fine permutation for one tile-round window `[seg_lo, seg_target)`,
    /// updating the accumulator `target` IN PLACE — no base texture, no ping-pong; a tile with no
    /// work in the window returns untouched. The caller clears `target` before the first window
    /// (this mode never clears). Only valid when [`Self::rw_accumulator`] is true; `target` carries
    /// `STORAGE_BINDING` alongside the usual attachment/sampling usages. Classic-only; default panics.
    fn phased_fine_segment_rw(
        &mut self,
        _device: &wgpu::Device,
        _queue: &wgpu::Queue,
        _enc: &mut wgpu::CommandEncoder,
        _seg_lo: u32,
        _seg_target: u32,
        _target: &wgpu::TextureView,
    ) {
        unimplemented!("phased session is classic-only")
    }

    /// Set the reach-crop origins for the NEXT `phased_fine_segment*` call: `scratch_out` shifts where
    /// the producer writes `output`, `scratch_in` where the consumer samples its scratch (`draft`/
    /// `input`). Consumed by that one dispatch, then reset — a following full-viewport call is inert, so
    /// only a cropped call needs to set them. `[0, 0]` = that slot is not cropped. Default: no-op.
    fn phase_scratch_origins(&mut self, _scratch_out: [u32; 2], _scratch_in: [u32; 2]) {}

    /// Set the sparse tile list for the NEXT `phased_fine_segment*` call: the fine grid becomes
    /// `(n, 1, 1)` workgroups, workgroup `i` reading its tile coordinate from
    /// `effect_params[base + i]` (packed `y<<16 | x`, biased by `0x40000000`). Consumed by that one
    /// dispatch, then reset — a following full-viewport call is inert. Default: no-op.
    fn phase_sparse_window(&mut self, _base: u32, _n: u32) {}

    /// End the session begun by [`Self::phased_begin`], freeing its shared buffers into `enc` (deferred
    /// until after the sink's submit). Only classic; default is a no-op.
    fn phased_finish(&mut self, _device: &wgpu::Device, _queue: &wgpu::Queue, _enc: &mut wgpu::CommandEncoder) {}

    /// The [`wgpu::TextureUsages`] a texture must carry for this backend to rasterize into it. Hybrid
    /// renders as an attachment (`RENDER_ATTACHMENT`, the default); classic writes through a compute
    /// pass, so it overrides this with `STORAGE_BINDING`. The sink ORs it into every texture it
    /// rasterizes into — atlases (plus `COPY_SRC`) and surfaces (plus the compositor's own
    /// `RENDER_ATTACHMENT` / `TEXTURE_BINDING` / `COPY_DST`).
    fn rasterize_target_usage(&self) -> wgpu::TextureUsages {
        wgpu::TextureUsages::RENDER_ATTACHMENT
    }

    /// Whether this backend can draw an already-rendered surface as an **inline image** inside a scene
    /// being built — the primitive the tile-fuse needs to collapse a tile's plain bodies *and* its
    /// spread effect surfaces into ONE rasterize (instead of a plain render split by every effect
    /// composite). Classic does it via `register_texture` + an `ImageBrush` fill; hybrid has a
    /// different image model and keeps the composite path, so it defaults to `false`.
    fn inline_images_supported(&self) -> bool {
        false
    }

    /// Whether this backend applies a shape's **layer blur** (`node.blur`) *inline* while building its
    /// body (as a filter layer), so the sink must NOT blur the effect surface itself. Hybrid does this
    /// via `push_layer(filter)` in its walk and returns `true`; classic vello has no inline layer-blur
    /// primitive, so it returns the default `false` and the sink blurs the body surface through
    /// `run_graph` instead (`Sink::layer_blur_over_body`). Getting this wrong double-blurs or drops it.
    fn blurs_layer_inline(&self) -> bool {
        false
    }

    /// Register `texture` (an `Rgba8Unorm`, `COPY_SRC` surface) for inline drawing this frame, returning
    /// an opaque handle to pass to [`Self::draw_inline_image`]. Paired with [`Self::unregister_inline_image`]
    /// once the scenes that use it have been rasterized. Only called when [`Self::inline_images_supported`].
    fn register_inline_image(&mut self, _texture: &wgpu::Texture) -> u64 {
        0
    }

    /// Draw a previously [`registered`](Self::register_inline_image) surface into `scene`, placing its
    /// whole extent at device-space `dst` (a rect in the scene's own pixels) at `alpha`. 1:1 in size,
    /// mirroring the composite blit it replaces.
    fn draw_inline_image(&mut self, _scene: &mut Self::Scene, _handle: u64, _dst: Rect, _alpha: f32) {}

    /// Release a handle from [`Self::register_inline_image`] after the frame's fused scenes are rendered.
    fn unregister_inline_image(&mut self, _handle: u64) {}

    /// Called once per frame, immediately after the sink submits its encoder.
    ///
    /// A backend that defers recycling while commands are unsubmitted reclaims here. Classic does:
    /// vello's engine holds retired buffers until this point, because returning one to its pool with
    /// commands still unsubmitted lets the next recording overwrite live data. Hybrid needs nothing.
    fn after_submit(&mut self) {}

    /// Whether the sink may record **several** [`Self::rasterize`] calls into one encoder before
    /// submitting (the batching that turns ~1-submit-per-step into ~steps/batch).
    ///
    /// Safe only if a rasterize does not alias GPU state across calls that share a submit. Default is
    /// `false` — the conservative choice for any new backend. vello's classic engine encodes fresh
    /// per-recording buffers into each `Recording`, so it overrides to `true`. vello_hybrid reuses a
    /// **persistent** `view_config` uniform buffer, rewritten via `queue.write_buffer` per render;
    /// since those writes apply at submit time, batching would make every draw in the batch read the
    /// last render's config — so hybrid keeps the default and submits per rasterize.
    fn batched_submits_safe(&self) -> bool {
        false
    }
}

/// Turns a backend scene (built via the shared `RenderingContext` draw path) into pixels in a target
/// texture. Implemented once per Vello flavor; the sink is generic over it.
pub trait SceneRasterizer {
    /// The backend's scene-building type — a `vello_hybrid::Scene` or the classic wrapper. It also
    /// implements `RenderingContext` (so `scene.rs` can draw into it), but this trait does not need to
    /// know that: it only rasterizes an already-built scene.
    type Scene;

    /// A fresh, empty scene sized `width × height` device pixels, ready to be drawn into.
    fn new_scene(&self, width: u16, height: u16) -> Self::Scene;

    /// Rasterize `scene` into `target` (a `width × height` texture), clearing to `base_color` first.
    ///
    /// Records into the caller's `enc` and does not submit — the sink submits once per frame.
    /// `target`'s required usages are the backend's business (classic needs `STORAGE_BINDING`; hybrid
    /// renders as an attachment); the sink allocates via the backend so it can set them.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn rasterize(
        &mut self,
        scene: &Self::Scene,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        width: u32,
        height: u32,
        base_color: Color,
    );
}
