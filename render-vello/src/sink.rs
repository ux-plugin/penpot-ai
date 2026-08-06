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

use std::collections::{HashMap, HashSet};

use render_core::schedule::{LayerPaint, Schedule, Step, SurfaceRef, SurfaceRole};
use render_core::tiling::{self, TILE_BUFFER, TILE_MARGIN, TILE_SIZE};
use vello_common::kurbo::{Affine, Point, Rect};
use vello_example_scenes::AnyScene;
use vello_hybrid::{RenderSize, Renderer, Scene, TextureBindings};

use crate::blend::{Blit, BlurPass, Compositor};

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
    /// Physical surface per logical ref, this frame. Slice-1 allocates fresh each frame (no
    /// cross-frame reuse yet — that folds in with the tile cache later).
    surfaces: HashMap<SurfaceRef, Surface>,
    /// Surfaces written at least once this frame — first write clears, rest load.
    written: HashSet<SurfaceRef>,
    /// Device-space origin of each `Backdrop` surface (its top-left in device pixels), so a
    /// `PaintGather` can map the shape's device rect into the backdrop's local texel space.
    backdrop_origin: HashMap<SurfaceRef, (f64, f64)>,
}

impl Sink {
    pub(crate) fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        Self {
            compositor: Compositor::new(device, format),
            surfaces: HashMap::new(),
            written: HashSet::new(),
            backdrop_origin: HashMap::new(),
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
                Step::ComposeBackdrop { read_from, extent, write_to, .. } => {
                    self.compose_backdrop(read_from, *extent, *write_to, device, queue, full_view, format);
                }
                Step::PaintGather { backdrop, clip, write_to, .. } => {
                    self.paint_gather(*backdrop, *clip, *write_to, device, queue, full_view, format);
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
        write_to: SurfaceRef,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) {
        let (bdx, bdy, bw, bh) = device_rect(full_view, extent);
        let w = (bw.ceil() as u32).clamp(1, 4096);
        let h = (bh.ceil() as u32).clamp(1, 4096);
        self.ensure_surface(write_to, device, w, h, format);
        self.written.insert(write_to);
        self.backdrop_origin.insert(write_to, (bdx, bdy));
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
        for src_ref in read_from {
            let Some(tile) = src_ref.tile else { continue };
            let Some(src) = self.surfaces.get(src_ref) else { continue };
            let src_view = src.view.clone();
            let (ox, oy) = tiling::tile_device_origin(tile, full_view);
            self.compositor.blit(
                device,
                &mut enc,
                &bd_view,
                (w as f32, h as f32),
                &Blit {
                    src: &src_view,
                    dst: ((ox - bdx) as f32, (oy - bdy) as f32, ts, ts),
                    src_rect: (m, m, ts, ts),
                    src_size: (TILE_BUFFER as f32, TILE_BUFFER as f32),
                    alpha: 1.0,
                },
            );
        }
        queue.submit([enc.finish()]);
    }

    /// Blur the backdrop (separable Gaussian, once per gather — cached under the bumped ref) and
    /// composite it into `write_to`'s tile through the shape's device rect, replacing the sharp
    /// content under the glass with its blurred version. The shape's own body then paints on top.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    fn paint_gather(
        &mut self,
        backdrop: SurfaceRef,
        clip: Rect,
        write_to: SurfaceRef,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        full_view: Affine,
        format: wgpu::TextureFormat,
    ) {
        let Some(bd) = self.surfaces.get(&backdrop) else { return };
        let (bw, bh) = (bd.width, bd.height);
        let Some(&(bdx, bdy)) = self.backdrop_origin.get(&backdrop) else { return };

        // Blur once per gather; every dest tile blits from the same cached blurred backdrop.
        let blurred_ref = backdrop.bump();
        if !self.surfaces.contains_key(&blurred_ref) {
            // Device-space sigma: page sigma scaled by the view, matching the sample-rect margin.
            let sigma = {
                let radius = match backdrop.role {
                    SurfaceRole::Backdrop(id) => {
                        crate::abi::with_scene(|live, _, _| live.get(id).and_then(|n| n.background_blur))
                    }
                    _ => None,
                };
                let c = full_view.as_coeffs();
                let scale = (c[0] * c[0] + c[1] * c[1]).sqrt() as f32;
                render_core::blur::radius_to_sigma(radius.unwrap_or(0.0)) * scale
            };
            let bd_view = self.surfaces[&backdrop].view.clone();
            let scratch = new_target(device, bw, bh, format);
            let scratch_view = scratch.create_view(&wgpu::TextureViewDescriptor::default());
            let blurred = new_target(device, bw, bh, format);
            let blurred_view = blurred.create_view(&wgpu::TextureViewDescriptor::default());
            let mut enc = device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sink gather blur") });
            let size = (bw as f32, bh as f32);
            self.compositor.blur1d(device, &mut enc, &scratch_view, &BlurPass { src: &bd_view, size, dir: (1.0, 0.0), sigma });
            self.compositor.blur1d(device, &mut enc, &blurred_view, &BlurPass { src: &scratch_view, size, dir: (0.0, 1.0), sigma });
            queue.submit([enc.finish()]);
            self.surfaces.insert(blurred_ref, Surface { texture: blurred, view: blurred_view, width: bw, height: bh });
        }
        let blurred_view = self.surfaces[&blurred_ref].view.clone();

        let Some(tile) = write_to.tile else { return };
        let (ox, oy) = tiling::tile_device_origin(tile, full_view);
        let (sdx, sdy, sdw, sdh) = device_rect(full_view, clip);
        // Intersect the shape's device rect with this tile's device content region.
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
        self.compositor.blit(
            device,
            &mut enc,
            &to_view,
            (TILE_BUFFER as f32, TILE_BUFFER as f32),
            &Blit {
                src: &blurred_view,
                dst: ((ix0 - ox + m) as f32, (iy0 - oy + m) as f32, (ix1 - ix0) as f32, (iy1 - iy0) as f32),
                src_rect: ((ix0 - bdx) as f32, (iy0 - bdy) as f32, (ix1 - ix0) as f32, (iy1 - iy0) as f32),
                src_size: (bw as f32, bh as f32),
                alpha: 1.0,
            },
        );
        queue.submit([enc.finish()]);
    }
}

/// A fresh render-attachment + sampled texture (a blur scratch / result surface).
fn new_target(device: &wgpu::Device, w: u32, h: u32, format: wgpu::TextureFormat) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("sink blur target"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
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
