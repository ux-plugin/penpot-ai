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
//! The centre squares are blitted onto the surface with a direct `copy_texture_to_texture`. An
//! earlier attempt composited them through Vello's own `draw_texture_rects` (binding each tile as
//! an external texture), but binding ~15 spatially-adjacent tile textures in one pass tripped the
//! fork's external-texture *run* scheduler — some tiles fell back to the black placeholder texture,
//! producing a parity of black bands. A GPU copy sidesteps that scheduler entirely, is pixel-exact
//! (1:1, no sampling) and needs no shader. It requires WebGPU (copy-to-swapchain), which is what
//! this backend prefers; the WebGL2 fallback would need the draw path and is a later concern.

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

/// One reusable offscreen tile buffer: a [`TILE_BUFFER`]² texture and its view.
struct TileBuffer {
    texture: wgpu::Texture,
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
            // RENDER_ATTACHMENT to render into it, COPY_SRC to blit its centre to the surface.
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        TileBuffer { texture, view }
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
        // The scene applies the host viewport on top of the `root` we pass (`root * viewport`), so
        // when the app drives, `root` is identity and the real pan/zoom lives in the viewport. Tile
        // geometry must use that full page→device transform, not the bare `root`.
        // Slice 1 tiles plain content only. Spatial effects (blur/shadow) are grid-sensitive under
        // the fork's decimated blur and seam when run per-tile, so they are gated off here and will
        // return through their own `extrect`-anchored composited surfaces.
        // The scheduler path: render-core builds the schedule from the live model; the sink
        // executes it on the GPU. Falls through to the whole-scene path when off or when there is no
        // live model (the demo scenes).
        if crate::abi::scheduler() {
            let has_scene = crate::abi::with_scene(|live, _, _| !live.is_empty());
            if has_scene {
                // The sink owns the cross-frame tile cache, so bring it up first, then let it plan
                // which visible tiles are dirty this frame (a pan → only the newly-exposed strip; an
                // edit/zoom → all of them). Build the schedule for *just* those, execute, and the sink
                // blits the reused tiles from cache.
                if self.sink.is_none() {
                    self.sink = Some(crate::sink::Sink::new(device, self.format));
                }
                let sink = self.sink.as_mut().expect("sink just created");
                let full_view = crate::abi::effective_view(root);
                let (dirty_all, dirty_rects) = crate::abi::take_dirty();
                let dirty = sink.plan_frame(full_view, width, height, dirty_all, &dirty_rects);
                let dirty_set: std::collections::HashSet<TileKey> = dirty.iter().copied().collect();

                let _tb = crate::prof::now();
                let schedule = crate::abi::with_scene(|live, viewport, _modifiers| {
                    render_core::schedule::build_visible(live, root * viewport, &dirty_set)
                });
                crate::prof::add_build(crate::prof::now() - _tb);

                sink.execute(
                    &schedule, &dirty, renderer, device, queue, surface, scene_source, root, width,
                    height,
                );
                return;
            }
        }

        crate::scene::set_effects_enabled(crate::abi::tile_effects());

        // Diagnostic bypass: draw the whole scene in one pass to the surface, no tiling. Lets the
        // harness compare an artifact with and without the tile buffer path.
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

        // A scale change invalidates every cached tile — the 1:1 composite is only correct at the
        // scale a tile was rendered at (see the module doc). Recycle the buffers rather than drop
        // them: a zoom re-renders a whole screen next, so reusing the freed textures avoids
        // reallocating. A pure pan leaves `scale` bit-identical, so this keeps the cache intact.
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

        // Pass 1: reuse cached tiles, rasterize only the misses. Each miss renders into its own
        // buffer, placed by `offset * root` (the scene re-appends the viewport, so the effective
        // transform is `offset * full_view`), on its **own** encoder submitted before the next.
        // `Renderer` uploads a frame's strip/alpha/paint data into shared GPU buffers
        // (`programs.prepare` via the queue), so batching several tile renders onto one submit
        // would let each tile's upload overwrite the previous before the GPU ran its draws — every
        // tile would then sample the last tile's buffers (the stroke-teeth corruption the harness
        // reproduced). One submit per tile keeps each render's uploads paired with its own draws.
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
        // A hard, machine-readable proof of reuse: on a pan `rendered` is just the new strip and
        // `reused` is the rest; on a zoom every tile is a miss. Read via `_last_tile_stats`.
        crate::abi::set_tile_stats(rendered, reused);

        // Pass 2: blit each visible tile's centre [`TILE_SIZE`] square onto the surface at its
        // device origin, clipped to the surface. Every visible tile is now cached and fully
        // rendered, and the centres tile the plane contiguously, so this covers the whole viewport
        // with no gaps and no clear needed.
        let mut encoder = device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("composite") });
        for &key in &tiles {
            let (oxf, oyf) = tiling::tile_device_origin(key, full_view);
            let Some(copy) = TileBlit::clip(oxf, oyf, width, height) else {
                continue;
            };
            let Some(tile) = self.cache.get(&key) else {
                continue;
            };
            encoder.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &tile.buffer.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: copy.src_x,
                        y: copy.src_y,
                        z: 0,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyTextureInfo {
                    texture: surface,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: copy.dst_x,
                        y: copy.dst_y,
                        z: 0,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d {
                    width: copy.w,
                    height: copy.h,
                    depth_or_array_layers: 1,
                },
            );
        }
        queue.submit([encoder.finish()]);

        // Evict LRU tiles beyond the budget, always keeping the currently-visible ones.
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
            // The centre square starts at (margin, margin) in the buffer; shift by the clip amount.
            src_x: (margin + (dst_x0 - ox)) as u32,
            src_y: (margin + (dst_y0 - oy)) as u32,
            dst_x: dst_x0 as u32,
            dst_y: dst_y0 as u32,
            w: (dst_x1 - dst_x0) as u32,
            h: (dst_y1 - dst_y0) as u32,
        })
    }
}

