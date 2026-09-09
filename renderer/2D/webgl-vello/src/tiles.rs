//! The Vello tile store (decision D18): the backend half of the tiling seam.
//!
//! `render_core::tiling` owns the *policy* — which page-space tiles are visible and how each maps
//! into its render buffer and onto the screen. This module owns the *store*: rendering a tile into
//! an offscreen buffer and compositing it back.
//!
//! ## Slice 2 — the page-space cache (pan reuse)
//!
//! Slice 1 re-rendered every visible tile every frame. This slice keys the rendered buffers by
//! [`TileKey`] and reuses them across frames, so a **pan** re-renders only the thin strip of
//! newly-exposed tiles and composites the rest straight from cache — the "document feel".
//!
//! The reuse is sound because a tile's content is *pan-invariant*: `tile_render_transform` maps a
//! page point to `scale·p + (margin − tile·512)` — the view's pan `(e, f)` cancels out, so tile
//! `(tx, ty)` rasterises identical pixels at a given scale regardless of where the canvas is
//! scrolled. The one thing that *does* change the pixels is the **scale**: this slice composites
//! the cached centre 1:1, which is only correct when the current scale equals the scale a tile was
//! rendered at. So a scale change (any zoom, even within one [`TileKey::zoom_bucket`]) drops the
//! whole cache and re-renders — zoom reuse (render at the bucket scale, composite scaled) is the
//! next slice. A pure pan keeps `view_scale` bit-identical (it reads only the linear part), so the
//! guard reuses on pan and never falsely on zoom.
//!
//! Eviction is LRU over a fixed [`MAX_CACHED_TILES`] budget of not-currently-visible tiles;
//! currently-visible tiles are always retained. Evicted textures return to a recycle pool
//! (`free`) rather than being dropped, so a zoom — which invalidates then re-renders a whole
//! screen — reuses the freed textures instead of reallocating.
//!
//! ## Why this fixes the effect coupling
//!
//! Rendering the whole scene into a viewport-sized target made the fork's `active_bbox` (its filter
//! viewport-clip) the *screen*, so a shape's blur/shadow got clipped at the viewport edge and
//! drifted with pan/zoom. Here each tile is rendered into its own [`TILE_BUFFER`]² `Scene`, so
//! `active_bbox` becomes the tile+margin buffer instead. The shape's effect has a full
//! [`TILE_MARGIN`] of bleed room on every side, interior tiles are fully covered (no false edge),
//! and we composite only the centre [`TILE_SIZE`] square — which tiles the plane contiguously.
//!
//! ## Compositing
//!
//! The centre squares are composited onto the surface with [`crate::blend::Compositor`] — a
//! premultiplied-SrcOver *draw* (one textured-quad blit per tile). This backend is WebGL2-only (real
//! WebGPU is owned by the classic `vello-gpu-renderer` backend), and wgpu's GL surface advertises
//! `COLOR_TARGET` only — it rejects `COPY_DST`, so a `copy_texture_to_texture` onto the swapchain is
//! impossible. A render pass is the one op WebGL2 allows on a surface. The centres tile the viewport
//! contiguously, so a one-time transparent clear + SrcOver over a zero destination reduces to
//! `out = src`: pixel-identical to the copy this replaced.
//!
//! This is a *standalone* blit pipeline binding one source texture per draw, so it sidesteps the
//! fork's external-texture *run* scheduler — an earlier attempt to composite via Vello's own
//! `draw_texture_rects` (binding ~15 adjacent tile textures in one pass) tripped that scheduler and
//! fell back to the black placeholder texture, producing bands of black.

use std::collections::HashMap;

use render_core::tiling::{self, TileKey, TILE_BUFFER, TILE_MARGIN, TILE_SIZE};
use vello_common::kurbo::Affine;
use vello_example_scenes::AnyScene;
use vello_hybrid::{RenderSize, Renderer, Scene, TextureBindings};

/// How many *not-currently-visible* tiles the cache keeps for pan reuse before evicting the
/// least-recently-used. Currently-visible tiles are always retained on top of this, so the true
/// cap is `MAX_CACHED_TILES + one screen`. At [`TILE_BUFFER`]² × 4 bytes (~4 MiB) per tile this
/// bounds cache VRAM to roughly `MAX_CACHED_TILES · 4 MiB`; 48 gives about a screen of pan slack.
const MAX_CACHED_TILES: usize = 48;

/// One reusable offscreen tile buffer: a view over a [`TILE_BUFFER`]² texture. Only the view is
/// held — a `wgpu::TextureView` keeps its texture alive — and the Compositor samples it by view.
struct TileBuffer {
    view: wgpu::TextureView,
}

/// A cached tile: its rendered buffer and the frame it was last composited on (for LRU eviction).
struct CachedTile {
    buffer: TileBuffer,
    last_used: u64,
}

/// The backend-owned tile store. Owns the page-space tile cache, a recycle pool of spare buffers
/// and a reusable tile scene sized to the buffer.
pub(crate) struct VelloTileStore {
    format: wgpu::TextureFormat,
    /// Rendered tiles keyed by page-anchored [`TileKey`]. All entries share `cached_scale`.
    cache: HashMap<TileKey, CachedTile>,
    /// The scale every cached tile was rendered at. `None` until the first frame; a change drops
    /// the cache (see the module doc — 1:1 composite is only valid at the render scale).
    cached_scale: Option<f64>,
    /// Spare buffers reclaimed from eviction, ready to be re-rendered into without reallocating.
    free: Vec<TileBuffer>,
    /// Monotonic frame counter driving LRU (`CachedTile::last_used`).
    frame: u64,
    /// The [`TILE_BUFFER`]² scene every tile is built into (reset per tile).
    tile_scene: Scene,
    /// The scheduler's GPU production sink, lazily built on first use (it needs the device). Active
    /// only on the `scheduler` path.
    sink: Option<crate::sink::Sink>,
    /// SrcOver blit pipeline, lazily built on first use (it needs the device). The legacy tile-cache
    /// path composites each cached tile's centre onto the surface with this — a *draw*, since WebGL2
    /// surfaces cannot be a copy destination.
    compositor: Option<crate::blend::Compositor>,
}

impl VelloTileStore {
    pub(crate) fn new(format: wgpu::TextureFormat) -> Self {
        let buffer = u16::try_from(TILE_BUFFER).unwrap_or(u16::MAX);
        Self {
            format,
            cache: HashMap::new(),
            cached_scale: None,
            free: Vec::new(),
            frame: 0,
            tile_scene: Scene::new(buffer, buffer),
            sink: None,
            compositor: None,
        }
    }

    /// Take a spare buffer from the recycle pool, or make a fresh one.
    fn take_buffer(&mut self, device: &wgpu::Device) -> TileBuffer {
        match self.free.pop() {
            Some(buffer) => buffer,
            None => self.make_buffer(device),
        }
    }

    fn make_buffer(&self, device: &wgpu::Device) -> TileBuffer {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("vello tile buffer"),
            size: wgpu::Extent3d {
                width: TILE_BUFFER,
                height: TILE_BUFFER,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        TileBuffer { view }
    }

    /// Render one frame as tiles: reuse cached tiles, rasterize only the misses into their own
    /// buffers (so effects run against the tile+margin, not the viewport), then blit every visible
    /// tile's centre onto `surface`.
    #[expect(
        clippy::too_many_arguments,
        reason = "the GPU context lives on the renderer wrapper, not the store"
    )]
    pub(crate) fn render_frame(
        &mut self,
        renderer: &mut Renderer,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        surface: &wgpu::Texture,
        scene_source: &mut AnyScene<Scene>,
        root: Affine,
        width: u32,
        height: u32,
    ) {
        if crate::abi::scheduler() {
            let has_scene = crate::abi::with_scene(|live, _, _| !live.is_empty());
            if has_scene {
                if self.sink.is_none() {
                    self.sink = Some(crate::sink::Sink::new(device, self.format));
                }
                let sink = self.sink.as_mut().expect("sink just created");
                let full_view = crate::abi::effective_view(root);
                let (dirty_all, dirty_rects) = crate::abi::take_dirty();
                let dirty = sink.plan_frame(full_view, width, height, dirty_all, &dirty_rects);
                let dirty_set: std::collections::HashSet<TileKey> = dirty.iter().copied().collect();

                let _tb = crate::prof::now();
                let schedule = crate::abi::with_scene(|live, viewport, modifiers| {
                    render_core::schedule::build_visible(live, root * viewport, modifiers, &dirty_set, None)
                });
                crate::prof::add_build(crate::prof::now() - _tb);

                let mut backend =
                    crate::hybrid_backend::HybridBackend { renderer, scene_source };
                sink.execute(
                    &schedule, &dirty, &mut backend, device, queue, surface, root, width, height,
                );
                return;
            }
        }

        crate::scene::set_effects_enabled(crate::abi::tile_effects());

        if crate::abi::tiling_bypass() {
            let mut whole = Scene::new(width as u16, height as u16);
            scene_source.render(&mut whole, root);
            let view = surface.create_view(&wgpu::TextureViewDescriptor::default());
            let mut encoder = device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("whole") });
            if let Err(e) = renderer.render(
                &whole,
                scene_source.resources_mut(),
                device,
                queue,
                &mut encoder,
                &RenderSize { width, height },
                &view,
                &TextureBindings::new(),
            ) {
                log::warn!("render-vello whole-scene skipped: {e:?}");
            }
            queue.submit([encoder.finish()]);
            return;
        }

        let full_view = crate::abi::effective_view(root);
        let scale = tiling::view_scale(full_view);
        let tiles = tiling::visible_tiles(full_view, width, height);
        if tiles.is_empty() {
            crate::abi::set_tile_stats(0, 0);
            return;
        }

        if self.cached_scale != Some(scale) {
            for (_, tile) in self.cache.drain() {
                self.free.push(tile.buffer);
            }
            self.cached_scale = Some(scale);
        }

        self.frame += 1;
        let frame = self.frame;
        let margin = f64::from(TILE_MARGIN);
        let render_size = RenderSize {
            width: TILE_BUFFER,
            height: TILE_BUFFER,
        };

        let mut rendered = 0u32;
        let mut reused = 0u32;
        for &key in &tiles {
            if let Some(tile) = self.cache.get_mut(&key) {
                tile.last_used = frame;
                reused += 1;
                continue;
            }
            let buffer = self.take_buffer(device);
            self.tile_scene.reset();
            let (ox, oy) = tiling::tile_device_origin(key, full_view);
            let offset = Affine::translate((margin - ox, margin - oy));
            scene_source.render(&mut self.tile_scene, offset * root);
            let mut tile_encoder = device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("tile") });
            if let Err(e) = renderer.render(
                &self.tile_scene,
                scene_source.resources_mut(),
                device,
                queue,
                &mut tile_encoder,
                &render_size,
                &buffer.view,
                &TextureBindings::new(),
            ) {
                log::warn!("render-vello tile skipped: {e:?}");
            }
            queue.submit([tile_encoder.finish()]);
            self.cache.insert(key, CachedTile { buffer, last_used: frame });
            rendered += 1;
        }
        crate::abi::set_tile_stats(rendered, reused);

        if self.compositor.is_none() {
            self.compositor = Some(crate::blend::Compositor::new(device, self.format));
        }
        let compositor = self.compositor.as_ref().expect("compositor just created");
        let surface_view = surface.create_view(&wgpu::TextureViewDescriptor::default());
        let target_size = (width as f32, height as f32);
        let tbuf = TILE_BUFFER as f32;
        let mut encoder = device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("composite") });
        crate::blend::Compositor::clear(&mut encoder, &surface_view, [0.0; 4], None);
        for &key in &tiles {
            let (oxf, oyf) = tiling::tile_device_origin(key, full_view);
            let Some(copy) = TileBlit::clip(oxf, oyf, width, height) else {
                continue;
            };
            let Some(tile) = self.cache.get(&key) else {
                continue;
            };
            compositor.blit(
                device,
                &mut encoder,
                &surface_view,
                target_size,
                &crate::blend::Blit {
                    src: &tile.buffer.view,
                    dst: (copy.dst_x as f32, copy.dst_y as f32, copy.w as f32, copy.h as f32),
                    src_rect: (copy.src_x as f32, copy.src_y as f32, copy.w as f32, copy.h as f32),
                    src_size: (tbuf, tbuf),
                    alpha: 1.0,
                },
            );
        }
        queue.submit([encoder.finish()]);

        self.evict(&tiles);
    }

    /// Drop least-recently-used cached tiles down to [`MAX_CACHED_TILES`] *non-visible* entries,
    /// never evicting a currently-visible tile; the freed buffers return to the recycle pool
    /// (capped, so VRAM stays bounded).
    fn evict(&mut self, visible: &[TileKey]) {
        if self.cache.len() <= MAX_CACHED_TILES {
            return;
        }
        let visible: std::collections::HashSet<TileKey> = visible.iter().copied().collect();
        let mut candidates: Vec<(u64, TileKey)> = self
            .cache
            .iter()
            .filter(|(key, _)| !visible.contains(key))
            .map(|(key, tile)| (tile.last_used, *key))
            .collect();
        candidates.sort_unstable_by_key(|(last_used, _)| *last_used);
        let mut over = self.cache.len().saturating_sub(MAX_CACHED_TILES);
        for (_, key) in candidates {
            if over == 0 {
                break;
            }
            if let Some(tile) = self.cache.remove(&key) {
                self.free.push(tile.buffer);
                over -= 1;
            }
        }
        self.free.truncate(MAX_CACHED_TILES);
    }
}

/// The clipped copy of a tile's centre square onto the surface: source texel origin in the tile
/// buffer, destination texel origin on the surface, and the copy extent — all in device pixels.
struct TileBlit {
    src_x: u32,
    src_y: u32,
    dst_x: u32,
    dst_y: u32,
    w: u32,
    h: u32,
}

impl TileBlit {
    /// Clip a tile's centre square (device origin `(ox, oy)`, size [`TILE_SIZE`]) to the surface,
    /// shifting the source origin by however much the destination was clipped. `None` when the
    /// square is entirely off-screen.
    fn clip(ox: f64, oy: f64, width: u32, height: u32) -> Option<Self> {
        let ox = ox.round() as i32;
        let oy = oy.round() as i32;
        let ts = TILE_SIZE as i32;
        let margin = TILE_MARGIN as i32;
        let (w, h) = (width as i32, height as i32);

        let dst_x0 = ox.max(0);
        let dst_y0 = oy.max(0);
        let dst_x1 = (ox + ts).min(w);
        let dst_y1 = (oy + ts).min(h);
        if dst_x1 <= dst_x0 || dst_y1 <= dst_y0 {
            return None;
        }
        Some(Self {
            src_x: (margin + (dst_x0 - ox)) as u32,
            src_y: (margin + (dst_y0 - oy)) as u32,
            dst_x: dst_x0 as u32,
            dst_y: dst_y0 as u32,
            w: (dst_x1 - dst_x0) as u32,
            h: (dst_y1 - dst_y0) as u32,
        })
    }
}

