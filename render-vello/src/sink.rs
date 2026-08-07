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

use render_core::schedule::{LayerPaint, Schedule, Step, SurfaceRef, SurfaceRole};
use render_core::tiling::{self, TILE_BUFFER, TILE_MARGIN, TILE_SIZE};
use vello_common::kurbo::{Affine, Point, Rect};
use vello_example_scenes::AnyScene;
use vello_hybrid::{RenderSize, Renderer, Scene, TextureBindings};

use crate::blend::{Blit, Compositor, MaskedBlit};
use crate::glass::GlassPipeline;
use crate::graph::{build_custom_pipeline, new_target, run_graph, Pass, PassKind, Src};

struct Surface {
    #[allow(dead_code)]
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    width: u32,
    height: u32,
}

/// The scheduler's GPU production sink. Owns the per-frame surface map and the SrcOver compositor.
pub(crate) struct Sink {
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
}

impl Sink {
    pub(crate) fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        Self {
            compositor: Compositor::new(device, format),
            glass: GlassPipeline::new(device, format),
            surfaces: HashMap::new(),
            written: HashSet::new(),
            backdrop_origin: HashMap::new(),
            backdrop_scale: HashMap::new(),
            custom_pipelines: HashMap::new(),
        }
    }

    /// Execute one frame's schedule onto `surface` (the swapchain texture).
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    pub(crate) fn execute(
        &mut self,
        schedule: &Schedule,
        renderer: &mut Renderer,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        surface: &wgpu::Texture,
        scene_source: &mut AnyScene<Scene>,
        root: Affine,
        width: u32,
        height: u32,
    ) {
        self.surfaces.clear();
        self.written.clear();
        self.backdrop_origin.clear();
        self.backdrop_scale.clear();
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
        queue.submit([enc.finish()]);

        for step in &schedule.steps {
            match step {
                Step::Paint { shape, clip, write_to } => {
                    self.paint(*shape, *write_to, *clip, renderer, device, queue, scene_source, root, full_view, format);
                }
                Step::Composite { from, to, paint, rect, .. } => {
                    self.composite(*from, *to, *paint, *rect, device, queue, &sw_view, full_view, width, height, format);
                }
                Step::ComposeBackdrop { read_from, extent, reach, always_cap, write_to, .. } => {
                    self.compose_backdrop(read_from, *extent, *reach, *always_cap, *write_to, device, queue, full_view, format);
                }
                Step::PaintGather { backdrop, clip, write_to, .. } => {
                    self.paint_gather(*backdrop, *clip, *write_to, renderer, device, queue, scene_source, root, full_view, format);
                }
                // Snapshot / layer brackets are not emitted by the builder yet.
                _ => {}
            }
        }
    }

    fn ensure_surface(&mut self, key: SurfaceRef, device: &wgpu::Device, w: u32, h: u32, format: wgpu::TextureFormat) {
        if self.surfaces.contains_key(&key) {
            return;
        }
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("sink surface"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            // Rendered into, and sampled when composited.
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.surfaces.insert(key, Surface { texture, view, width: w, height: h });
    }

    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn paint(
        &mut self,
        shape: u128,
        write_to: SurfaceRef,
        clip: Rect,
        renderer: &mut Renderer,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        scene_source: &mut AnyScene<Scene>,
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
                let (dx, dy, dw, dh) = device_rect(full_view, clip);
                let w = (dw.ceil() as u32).max(1);
                let h = (dh.ceil() as u32).max(1);
                (w, h, Affine::translate((-dx, -dy)) * root)
            }
            _ => return,
        };

        self.ensure_surface(write_to, device, w, h, format);
        let first = self.written.insert(write_to);
        let view = self.surfaces[&write_to].view.clone();

        let mut scene = Scene::new(w as u16, h as u16);
        crate::scene::set_paint_only(Some(shape));
        scene_source.render(&mut scene, root_for_target);
        crate::scene::set_paint_only(None);

        let mut enc =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sink paint") });
        let size = RenderSize { width: w, height: h };
        let res = if first {
            renderer.render(&scene, scene_source.resources_mut(), device, queue, &mut enc, &size, &view, &TextureBindings::new())
        } else {
            renderer.render_load(&scene, scene_source.resources_mut(), device, queue, &mut enc, &size, &view, &TextureBindings::new())
        };
        if let Err(e) = res {
            log::warn!("sink paint skipped: {e:?}");
        }
        queue.submit([enc.finish()]);
    }

    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn composite(
        &mut self,
        from: SurfaceRef,
        to: SurfaceRef,
        paint: LayerPaint,
        rect: Rect,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
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

        let mut enc = device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sink composite") });

        match to.role {
            SurfaceRole::Target => {
                // A tile buffer's centre → swapchain at the tile's device origin.
                let Some(tile) = from.tile else { return };
                let (ox, oy) = tiling::tile_device_origin(tile, full_view);
                let m = TILE_MARGIN as f32;
                let ts = TILE_SIZE as f32;
                self.compositor.blit(
                    device,
                    &mut enc,
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
                    Compositor::clear(&mut enc, &to_view, [0.0, 0.0, 0.0, 0.0]);
                }
                let buf = TILE_BUFFER as f32;
                let blit = if matches!(from.role, SurfaceRole::RasterEffectOutput(_)) {
                    // Effect surface → placed at its device position relative to the tile.
                    let (ox, oy) = tiling::tile_device_origin(tile, full_view);
                    let m = f64::from(TILE_MARGIN);
                    let (dx, dy, dw, dh) = device_rect(full_view, rect);
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
                self.compositor.blit(device, &mut enc, &to_view, (buf, buf), &blit);
            }
            _ => return,
        }
        queue.submit([enc.finish()]);
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
        let (bdx, bdy, bw, bh) = device_rect(full_view, extent);
        // Resolution cap: keep the effect's device reach within one tile so a gather never reads/writes
        // past the current tile's one-tile ring. If `reach · zoom` exceeds a tile, draw the backdrop
        // (and every downstream pass) at `k < 1`; the stamp upscales by `1/k`. Blur is low-pass, so
        // this is near-lossless; glass loses some edge detail, the accepted cost of an unbounded zoom.
        let mut k = resolution_cap(full_view, reach);
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
        queue.submit([enc.finish()]);
    }

    /// Assemble a gather effect's result once (cached under the bumped ref) via [`run_graph`], then
    /// stamp it into `write_to`'s tile — through the shape's silhouette mask for background blur, or
    /// its device rect for glass (whose SDF mask is baked into the composite). The shape's own body
    /// paints on top afterward.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn paint_gather(
        &mut self,
        backdrop: SurfaceRef,
        clip: Rect,
        write_to: SurfaceRef,
        renderer: &mut Renderer,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        scene_source: &mut AnyScene<Scene>,
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
        let is_custom = crate::abi::with_scene(|live, _, _| live.get(id).is_some_and(|n| n.custom_shader.is_some()));

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
                Some(blur_graph(self.gather_sigma(id, full_view, k)))
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
                let mut mscene = Scene::new(bw as u16, bh as u16);
                crate::scene::set_mask_only(Some(id));
                scene_source.render(&mut mscene, root_for_mask);
                crate::scene::set_mask_only(None);
                let mut menc = device
                    .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sink gather mask") });
                let msize = RenderSize { width: bw, height: bh };
                if let Err(e) = renderer.render(&mscene, scene_source.resources_mut(), device, queue, &mut menc, &msize, &mask_view, &TextureBindings::new()) {
                    log::warn!("sink gather mask skipped: {e:?}");
                }
                queue.submit([menc.finish()]);
                self.surfaces.insert(mask_ref, Surface { texture: mask, view: mask_view, width: bw, height: bh });
            }
        }
        let result_view = self.surfaces[&result_ref].view.clone();

        let Some(tile) = write_to.tile else { return };
        let (ox, oy) = tiling::tile_device_origin(tile, full_view);
        let (sdx, sdy, sdw, sdh) = device_rect(full_view, clip);
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
        queue.submit([enc.finish()]);
    }

    /// Device-space Gaussian sigma for a background blur: the shape's page-space radius mapped through
    /// the *effective* view scale (`zoom · k`). Using the capped scale is what makes the reduced-res
    /// backdrop's blur reach fit one tile — `3σ_device ≤ TILE_SIZE` by construction of `k`.
    fn gather_sigma(&self, id: u128, full_view: Affine, k: f64) -> f32 {
        let radius = crate::abi::with_scene(|live, _, _| live.get(id).and_then(|n| n.background_blur));
        let c = full_view.as_coeffs();
        let scale = ((c[0] * c[0] + c[1] * c[1]).sqrt() * k) as f32;
        render_core::blur::radius_to_sigma(radius.unwrap_or(0.0)) * scale
    }

    /// Build the glass pass-graph over the assembled backdrop (input 0): displacement (pass 0) →
    /// refraction (pass 1) → optional blur (passes 2,3) → composite (last). Glass geometry is the
    /// shape's rounded box in the backdrop's device space (axis-aligned; rotation is a gap); the
    /// composite's own SDF mask does the clip, so no silhouette mask is needed.
    fn glass_graph(&self, id: u128, bw: u32, bh: u32, bdx: f64, bdy: f64, full_view: Affine, k: f64) -> Option<Vec<Pass>> {
        let (g, cx, cy, w, h, corners, is_circle) = crate::abi::with_scene(|live, _, _| {
            live.get(id).and_then(|n| {
                n.glass.map(|g| {
                    let c = n.bounds.center();
                    (g, c.x, c.y, n.bounds.width(), n.bounds.height(), n.corners, n.kind == render_core::model::ShapeKind::Circle)
                })
            })
        })?;

        // Effective device scale = zoom · k. All glass geometry (centre, half-extents, corner, device
        // thresholds `s`, blur sigma) is expressed in the reduced backdrop's texel space, so the SDF
        // and refraction land pixel-correct at whatever resolution the cap chose.
        let zoom = {
            let c = full_view.as_coeffs();
            (c[0] * c[0] + c[1] * c[1]).sqrt()
        };
        let eff = zoom * k;
        let dev_center = full_view * Point::new(cx, cy);
        let gcx = ((dev_center.x - bdx) * k) as f32;
        let gcy = ((dev_center.y - bdy) * k) as f32;
        let hx = (w * 0.5 * eff) as f32;
        let hy = (h * 0.5 * eff) as f32;
        let corner = if is_circle { hx.min(hy) } else { (corners.map_or(0.0, |r| r.top_left) * eff) as f32 };
        let s = eff as f32;
        let (bwf, bhf) = (bw as f32, bh as f32);

        let disp_u: [f32; 20] = [
            bwf, bhf, gcx, gcy,
            hx, hy, corner, g.surface_type as f32,
            g.bezel_width, g.thickness, g.refractive_index, g.specular_angle,
            g.splay, g.tilt_angle, g.edge_boost, g.zoom,
            s, 0.0, 0.0, 0.0,
        ];
        let refr_u: [f32; 4] = [bwf, bhf, g.chromatic_aberration, s];
        let comp_u: [f32; 8] = [bwf, bhf, g.frost, g.specular_opacity, g.specular_saturation, s, 0.0, 0.0];

        let mut passes = vec![
            Pass { kind: PassKind::GlassDisplacement { u: disp_u }, inputs: vec![] },
            Pass { kind: PassKind::GlassRefraction { u: refr_u }, inputs: vec![Src::Input(0), Src::Pass(0)] },
        ];
        // Glass blur (blur + frost softening) of the refracted image, when meaningful; otherwise the
        // composite reads the sharp refraction directly. One Blur pass = a full 2D Gaussian.
        let sigma = g.total_blur_sigma() * s;
        let blurred = if sigma > 0.5 {
            passes.push(Pass { kind: PassKind::Blur { sigma }, inputs: vec![Src::Pass(1)] });
            Src::Pass(2)
        } else {
            Src::Pass(1)
        };
        passes.push(Pass { kind: PassKind::GlassComposite { u: comp_u }, inputs: vec![blurred, Src::Input(0), Src::Pass(0)] });
        Some(passes)
    }

    /// Build the custom-shader graph: one [`PassKind::Custom`] over the assembled backdrop (input 0).
    /// The pipeline is compiled once per distinct WGSL source (cached by hash); the uniform is the
    /// backdrop resolution followed by the shader's declared params.
    fn custom_graph(&mut self, id: u128, bw: u32, bh: u32, device: &wgpu::Device, format: wgpu::TextureFormat) -> Option<Vec<Pass>> {
        let (wgsl, params) = crate::abi::with_scene(|live, _, _| {
            live.get(id).and_then(|n| n.custom_shader.as_ref().map(|c| (c.wgsl.clone(), c.params.clone())))
        })?;
        let mut hasher = DefaultHasher::new();
        wgsl.hash(&mut hasher);
        let key = hasher.finish();
        let pipeline = self
            .custom_pipelines
            .entry(key)
            .or_insert_with(|| build_custom_pipeline(device, &wgsl, format))
            .clone();
        let mut u = vec![bw as f32, bh as f32];
        u.extend_from_slice(&params);
        Some(vec![Pass { kind: PassKind::Custom { pipeline, u }, inputs: vec![Src::Input(0)] }])
    }
}

/// The background-blur graph: one 2D Gaussian pass over the assembled backdrop (input 0) — direct or
/// pyramid by sigma. Its result is what the sink stamps through the silhouette mask.
fn blur_graph(sigma: f32) -> Vec<Pass> {
    vec![Pass { kind: PassKind::Blur { sigma }, inputs: vec![Src::Input(0)] }]
}

/// The resolution-cap factor `k ∈ (0, 1]` for an effect whose page-space reach is `reach`, under
/// `view`. `1.0` while the reach fits one tile in device space; below that it shrinks so
/// `reach · zoom · k == TILE_SIZE`, keeping every gather read/write inside the current tile's
/// one-tile ring. The stamp then upscales the reduced result by `1/k`. `reach ≤ 0` (no effect
/// spread) → `1.0`, i.e. draw at native zoom.
fn resolution_cap(view: Affine, reach: f64) -> f64 {
    if reach <= 0.0 {
        return 1.0;
    }
    let c = view.as_coeffs();
    let zoom = (c[0] * c[0] + c[1] * c[1]).sqrt();
    let device_reach = reach * zoom;
    let budget = f64::from(TILE_SIZE);
    if device_reach <= budget {
        1.0
    } else {
        budget / device_reach
    }
}

/// Device-space bbox `(x, y, w, h)` of a page-space rect under `view`, **snapped to integer pixels**
/// (floor the origin, ceil the far corner). Integer alignment is load-bearing: the effect surface is
/// rendered at `translate(-origin)` and composited 1:1 at `origin`, so an integer origin keeps the
/// composite a pixel-exact blit (no bilinear resample of the shadow) *and* preserves the shape's
/// sub-pixel phase inside the surface — both needed to match the direct-draw ground truth.
fn device_rect(view: Affine, page: Rect) -> (f64, f64, f64, f64) {
    let corners = [
        view * Point::new(page.x0, page.y0),
        view * Point::new(page.x1, page.y0),
        view * Point::new(page.x1, page.y1),
        view * Point::new(page.x0, page.y1),
    ];
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in corners {
        x0 = x0.min(p.x);
        y0 = y0.min(p.y);
        x1 = x1.max(p.x);
        y1 = y1.max(p.y);
    }
    let (x0, y0) = (x0.floor(), y0.floor());
    (x0, y0, (x1.ceil() - x0).max(1.0), (y1.ceil() - y0).max(1.0))
}
