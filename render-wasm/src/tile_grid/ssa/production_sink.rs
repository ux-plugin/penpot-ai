//! Real-GL `DispatchSink` — the production implementation.
//!
//! Owns the per-schedule `SurfaceMap` and routes every Step to an
//! **SSA-native** renderer. There is no adapter pattern bridging into
//! the legacy `Surfaces.current` + `scheduler_render_effects` model:
//! the sink takes pool surfaces straight out of the map, wraps them
//! in a `render::ssa::PaintCtx` carrying the Step's explicit
//! `world_origin` / `clip_rect` / `tile`, and calls
//! `render::ssa::dispatch_effect` for each EffectKey. The
//! `render::ssa::*` per-effect renderers paint directly into the
//! ctx's surface — no globals, no swap-into-Current, no
//! `update_render_context` mutation.
//!
//! Per-handler routing:
//!
//! - `paint` — pulls binding for the Step's `write_to[0]`, builds
//!   PaintCtx, iterates non-gather effects through `dispatch_effect`.
//! - `snapshot` — `map.get_mut(from).image_snapshot_with_bounds(rect)`
//!   for pool sources, `Surfaces::target_image_snapshot_for_rect` for
//!   the Target sentinel.
//! - `compose_backdrop` — no-op stub; gather renderer port will fuse
//!   per-tile snapshots into the backdrop surface here.
//! - `paint_gather` — same PaintCtx flow as `paint` but for
//!   `EffectKey::Gather(_)` effects only.
//! - `composite` (to Target) — `image_snapshot()` the source, then
//!   `Surfaces::ssa_composite_image_to_target(image, tile_rect)`.
//! - `write_tile_cache` — `image_snapshot()` the source, then
//!   `Surfaces::ssa_cache_tile_image(viewbox, tile, rect, image)`.
//!
//! Both `ssa_composite_image_to_target` and `ssa_cache_tile_image`
//! are clean public methods on `Surfaces` that take their work
//! product (an Image) explicitly — they do NOT depend on
//! `Surfaces.current` being set up.
//!
//! The `render::ssa::*` renderer module is partial:
//! `fills`/`strokes`/`shape_body` are ported (solid subset);
//! `shadows`/`gather`/`glass`/`scatter`/`local`/`text` are stubs
//! returning Ok(()). Scenes using stubbed effects render with that
//! effect missing — no hacks bridge to legacy to fill the gap.

use rustc_hash::FxHashMap;
use skia_safe as skia;

use super::super::EffectKey;
use super::dispatcher::{DispatchSink, TraceEvent};
use super::step::Step;
use super::surface_map::SurfaceMap;
use super::surface_ref::SurfaceRef;
use crate::error::Result;
use crate::state::ShapesPoolRef;
use crate::tiles::Tile;
use crate::uuid::Uuid;

/// Production `DispatchSink`. Holds the live refs it needs to execute
/// real render steps.
///
/// Generic over the surface-allocator borrow path — `&'a mut RenderState`
/// for the legacy adapter, plus `&'a mut SurfaceAllocator` for pool
/// management. The borrow paths are disjoint at the field level, so
/// the borrow checker accepts them held simultaneously here as long
/// as no method takes both as `&mut` at the same time.
pub struct ProductionSink<'a> {
    /// Per-tile surface bindings. Pure data — surface allocation /
    /// deallocation routes through `self.allocator` + `self.gpu_state()`.
    map: SurfaceMap<'static>,
    /// Cross-frame surface pool. Caller-owned; the sink borrows it
    /// for its lifetime.
    allocator: &'a mut super::allocator::SurfaceAllocator,
    /// RenderState — the sink reads `gpu_state` (for SurfaceMap
    /// allocations), `surfaces.{target, tiles, cache, margins}` (for
    /// Target compositing + tile cache writes via the
    /// `ssa_composite_image_to_target` / `ssa_cache_tile_image`
    /// public methods on Surfaces), `viewbox` (zoom for tile size),
    /// `tile_viewbox` (for tile cache keying), `fonts`/`images`/
    /// `options`/`nested_fills` (carried in PaintCtx).
    ///
    /// `RenderState::scheduler_render_effects` is no longer called —
    /// `render::ssa::dispatch_effect` replaces it.
    state: &'a mut crate::render::RenderState,
    /// Shape pool, separate from RenderState. The render entry points
    /// (in render_state.rs) hold and pass both.
    shapes: ShapesPoolRef<'a>,
    /// Default tile dimensions for surfaces acquired via the
    /// `Dispatcher`'s default-size path.
    default_tile_size: (i32, i32),
    /// Per-frame snapshot images, keyed by Snapshot ref. Populated by
    /// the `Snapshot` step handler; read by future `ComposeBackdrop`
    /// fusion / gather-renderer ports. Currently no SSA renderer
    /// reads it (gather/glass ports stub), so the map is populated
    /// but unconsumed. Stays in place for the upcoming gather port.
    snapshot_images: FxHashMap<SurfaceRef, skia::Image>,
    /// World-space extent each backdrop surface was fused at. Populated
    /// by `compose_backdrop` (which holds the canonical `extent`
    /// straight from the schedule's `Step::ComposeBackdrop`), consumed
    /// by `paint_gather` so the gather renderer positions the backdrop
    /// image at the exact same world origin the fusion used.
    ///
    /// Recomputing it independently in `paint_gather` (e.g. via
    /// `GatherKind::extent_world`) produces a different rect — the
    /// schedule uses `compute_gather_sample_rect` which adds glass
    /// displacement / frost / scale-aware blur padding that
    /// `extent_world`'s `3σ+4` margin doesn't match. The mismatch
    /// anchors the backdrop image at the wrong origin → no visible
    /// blur + ghost at the top-left corner.
    backdrop_extents: FxHashMap<SurfaceRef, skia::Rect>,
    /// Acquire/release counters surfaced via `perf_trace`.
    acquire_count: u64,
    release_count: u64,
}

// SAFETY: `SurfaceMap<'static>` here is a misuse of the 'a parameter —
// the map only ever holds `Binding { surface, w, h }` triples, none of
// which contain borrows. The 'a was originally for allocator + gpu
// fields that no longer exist. Marker added so it's clear this is a
// data-only map.
unsafe impl<'a> Send for ProductionSink<'a> {}

impl<'a> ProductionSink<'a> {
    pub fn new(
        allocator: &'a mut super::allocator::SurfaceAllocator,
        state: &'a mut crate::render::RenderState,
        shapes: ShapesPoolRef<'a>,
        default_tile_size: (i32, i32),
    ) -> Self {
        Self {
            map: empty_map_static(),
            allocator,
            state,
            shapes,
            default_tile_size,
            snapshot_images: FxHashMap::default(),
            backdrop_extents: FxHashMap::default(),
            acquire_count: 0,
            release_count: 0,
        }
    }

    pub fn acquire_count(&self) -> u64 {
        self.acquire_count
    }

    pub fn release_count(&self) -> u64 {
        self.release_count
    }

    /// Drain the surface map at end of schedule. Returns any remaining
    /// surfaces to the allocator pool.
    pub fn finish(mut self) {
        self.map.drain_with(self.allocator);
        self.snapshot_images.clear();
        self.backdrop_extents.clear();
    }

    /// Dispatch a Paint step's effects through the legacy V2
    /// per-effect dispatcher. The pooled surface is installed as
    /// `SurfaceId::Current`; legacy code paints into it as if it were
    /// the singleton scratch.
    ///
    /// Splits `effects` into "non-gather" (body / scatter / local)
    /// and "gather" (Glass / BgBlur). Body effects go directly into
    /// Current. Gather effects are deferred — they're emitted as
    /// separate `PaintGather` steps by the schedule builder, so this
    /// path filters them out to avoid double-rendering.
    fn paint_into_pooled(
        &mut self,
        shape: Uuid,
        write_to: SurfaceRef,
        effects: &[EffectKey],
        world_origin: skia::Point,
        clip_rect: skia::Rect,
    ) -> Result<()> {
        let element = match self.shapes.get(&shape) {
            Some(s) => s.clone(),
            None => return Ok(()),
        };

        // Filter gather effects — emitted separately as PaintGather.
        let non_gather: Vec<EffectKey> = effects
            .iter()
            .copied()
            .filter(|e| !matches!(e, EffectKey::Gather(_)))
            .collect();
        if non_gather.is_empty() {
            return Ok(());
        }

        let tile = write_to.tile.expect("non-Target ref has a tile");
        let mut binding = self
            .map
            .take(write_to)
            .expect("SSA invariant: write_to bound before paint");

        // SSA-native dispatch — explicit PaintCtx, no swap_current,
        // no update_render_context, no scheduler_render_effects.
        {
            let scale = self.state.get_scale();
            // Pool surfaces match legacy `Current` layout exactly
            // (1024×1024, 256-px margins around a 512×512 content
            // region). Renderer math `margin/scale - world_clip.left`
            // maps world tile origin to surface pixel (margin, margin),
            // leaving filter kernels room on every side.
            let margins = self.state.surfaces.margins;
            let sampling = skia::SamplingOptions::default();
            let mut ctx = crate::render::ssa::PaintCtx {
                surface: &mut binding.surface,
                tile,
                world_origin,
                world_clip: clip_rect,
                scale,
                fonts: &self.state.fonts,
                images: &mut self.state.images,
                viewbox: &self.state.viewbox,
                options: &self.state.options,
                nested_fills: &mut self.state.nested_fills,
                sampling,
                gpu: &mut self.state.gpu_state,
                allocator: self.allocator,
                margins,
                fills_scratch: &mut self.state.surfaces.shape_fills,
                strokes_scratch: &mut self.state.surfaces.shape_strokes,
                inner_shadows_scratch: &mut self.state.surfaces.inner_shadows,
                drop_shadows_scratch: &mut self.state.surfaces.drop_shadows,
                text_drop_shadows_scratch: &mut self.state.surfaces.text_drop_shadows,
                filter_scratch: &mut self.state.surfaces.filter,
                tree: self.shapes,
                gather_backdrop: None,
            };
            for effect in &non_gather {
                crate::render::ssa::dispatch_effect(&mut ctx, &element, *effect)?;
            }
        }

        self.map.put_back(write_to, binding);
        Ok(())
    }
}

impl<'a> DispatchSink for ProductionSink<'a> {
    fn default_tile_size(&self) -> (i32, i32) {
        self.default_tile_size
    }

    fn acquire(&mut self, r: SurfaceRef, size: (i32, i32)) -> Result<()> {
        if r.is_target() {
            return Ok(());
        }
        if self.map.is_bound(r) {
            return Ok(());
        }
        self.acquire_count += 1;
        self.map.bind_for_write_with(
            r,
            size.0,
            size.1,
            "ssa",
            self.allocator,
            &mut self.state.gpu_state,
        )?;
        Ok(())
    }

    fn release(&mut self, r: SurfaceRef) {
        if r.is_target() {
            return;
        }
        if self.map.is_bound(r) {
            self.release_count += 1;
            self.map.release_with(r, self.allocator);
        }
        // Drop any associated snapshot image.
        self.snapshot_images.remove(&r);
        // Drop any associated backdrop extent (set by compose_backdrop,
        // consumed by paint_gather; keyed by backdrop surface).
        self.backdrop_extents.remove(&r);
    }

    fn paint(&mut self, step: &Step) -> Result<()> {
        if let Step::Paint {
            shape,
            effects,
            write_to,
            world_origin,
            clip_rect,
        } = step
        {
            let target = match write_to.first() {
                Some(r) if !r.is_target() => *r,
                _ => return Ok(()),
            };
            self.paint_into_pooled(*shape, target, effects, *world_origin, *clip_rect)?;
        }
        Ok(())
    }

    fn snapshot(&mut self, step: &Step) -> Result<()> {
        if let Step::Snapshot {
            from,
            rect,
            write_to,
        } = step
        {
            let img = if from.is_target() {
                self.state.surfaces.target_image_snapshot_for_rect(*rect)
            } else {
                // Direct map access — no swap-into-Current adapter.
                self.map
                    .get_mut(*from)
                    .and_then(|s| s.image_snapshot_with_bounds(*rect))
            };
            if let Some(img) = img {
                self.snapshot_images.insert(*write_to, img);
            }
        }
        Ok(())
    }

    fn compose_backdrop(&mut self, step: &Step) -> Result<()> {
        // Fuse per-tile snapshot images into a single backdrop surface
        // covering the gather's world `extent`. Layout:
        //   1. Pre-fill the backdrop with the frame's bg color so
        //      regions NOT covered by any snapshot (gaps between
        //      source tiles, areas where no shape lives) still show
        //      bg through the blur — matching legacy semantics where
        //      Target snapshot already had bg color baked in.
        //   2. Draw each per-tile snapshot at `(tile.world_origin -
        //      extent.origin) * scale` device-pixel offset. Sub-pixel
        //      (no `.round()`) so adjacent tiles' edges align — the
        //      blur kernel magnifies any seam into a visible artifact.
        let Step::ComposeBackdrop {
            read_from,
            extent,
            write_to,
            ..
        } = step
        else {
            return Ok(());
        };

        let scale = self.state.get_scale();
        let extent_left = extent.left;
        let extent_top = extent.top;
        let bg_color = self.state.background_color;

        // Record the canonical fused-backdrop extent for paint_gather.
        // The schedule's `Step::ComposeBackdrop.extent` is the source of
        // truth — paint_gather must position the backdrop image using
        // this same rect, NOT a re-derivation via `extent_world`.
        self.backdrop_extents.insert(*write_to, *extent);

        // Resolve snapshot images BEFORE borrowing the backdrop surface
        // (snapshot_images is on self; backdrop surface is on self.map).
        let snaps: Vec<(skia::Image, Tile)> = read_from
            .iter()
            .filter_map(|r| {
                let tile = match r.role {
                    super::surface_ref::SurfaceRole::Snapshot { source_tile, .. } => {
                        source_tile
                    }
                    _ => return None,
                };
                let img = self.snapshot_images.get(r).cloned()?;
                Some((img, tile))
            })
            .collect();

        let Some(backdrop) = self.map.get_mut(*write_to) else {
            return Ok(());
        };
        let canvas = backdrop.canvas();
        canvas.save();
        canvas.reset_matrix();
        // Step 1: pre-fill with bg color. Cover the whole backdrop
        // surface so any region a snapshot doesn't paint still
        // contributes the bg color to the blur kernel.
        canvas.clear(bg_color);

        // Step 2: stamp each snapshot at its tile-aligned device offset.
        for (img, source_tile) in &snaps {
            let (tx_world, ty_world) = crate::tiles::get_tile_pos(*source_tile, scale);
            let dx = (tx_world - extent_left) * scale;
            let dy = (ty_world - extent_top) * scale;
            canvas.draw_image(img, (dx, dy), None);
        }

        canvas.restore();
        Ok(())
    }

    fn paint_gather(&mut self, step: &Step) -> Result<()> {
        if let Step::PaintGather {
            shape,
            backdrop,
            effects,
            write_to,
        } = step
        {
            let element = match self.shapes.get(shape) {
                Some(s) => s.clone(),
                None => return Ok(()),
            };

            let gather_effects: Vec<EffectKey> = effects
                .iter()
                .copied()
                .map(EffectKey::Gather)
                .collect();
            if gather_effects.is_empty() {
                return Ok(());
            }
            let r = *write_to;
            if r.is_target() {
                return Ok(());
            }

            // Pull the backdrop's image + world-extent ready for the
            // gather renderer.
            //
            // CRITICAL: read the extent from `backdrop_extents` —
            // populated by the `compose_backdrop` handler with the
            // schedule's canonical `Step::ComposeBackdrop.extent`.
            // Re-deriving via `GatherKind::extent_world(shape)` here
            // produces a DIFFERENT rect because the schedule uses
            // `compute_gather_sample_rect`, which adds displacement /
            // frost / scale-aware blur padding that `extent_world`'s
            // `3σ + 4` margin does not match. Using the wrong rect
            // anchors the backdrop image at the wrong world origin
            // (manifests as a ghost in the top-left + missing blur).
            let extent_world = self.backdrop_extents.get(backdrop).copied();
            let backdrop_img: Option<skia::Image> =
                self.map.get_mut(*backdrop).map(|s| s.image_snapshot());

            let backdrop_payload: Option<(skia::Image, skia::Rect)> =
                match (backdrop_img, extent_world) {
                    (Some(i), Some(e)) => Some((i, e)),
                    _ => None,
                };

            // SSA-native dispatch — direct map access, PaintCtx, no
            // swap-into-Current adapter. Gather renderers (glass,
            // bg_blur) currently stub in `render::ssa::dispatch`, so
            // gather scenes render with the gather effect missing
            // until those ports land. The dispatch path is hack-free.
            let tile = r.tile.expect("non-Target ref has a tile");
            // Use `get_scale()` (zoom * dpr), matching the schedule
            // builder's clip_rect / world_origin closures. Using just
            // `viewbox.zoom` would mis-size world tiles by the DPR
            // factor on high-DPI displays.
            let frame_scale = self.state.get_scale();
            let tile_size_f = crate::tiles::get_tile_size(frame_scale);
            let world_origin = skia::Point::new(
                tile.x() as f32 * tile_size_f,
                tile.y() as f32 * tile_size_f,
            );
            let world_clip = skia::Rect::from_xywh(
                world_origin.x,
                world_origin.y,
                tile_size_f,
                tile_size_f,
            );
            let mut binding = self
                .map
                .take(r)
                .expect("SSA invariant: write_to bound before paint_gather");
            {
                let scale = self.state.get_scale();
                // Pool surfaces match legacy `Current` — see
                // `paint_into_pooled` for the full rationale.
                let margins = self.state.surfaces.margins;
                let sampling = skia::SamplingOptions::default();
                let mut ctx = crate::render::ssa::PaintCtx {
                    surface: &mut binding.surface,
                    tile,
                    world_origin,
                    world_clip,
                    scale,
                    fonts: &self.state.fonts,
                    images: &mut self.state.images,
                    viewbox: &self.state.viewbox,
                    options: &self.state.options,
                    nested_fills: &mut self.state.nested_fills,
                    sampling,
                    gpu: &mut self.state.gpu_state,
                    allocator: self.allocator,
                    margins,
                    fills_scratch: &mut self.state.surfaces.shape_fills,
                    strokes_scratch: &mut self.state.surfaces.shape_strokes,
                    inner_shadows_scratch: &mut self.state.surfaces.inner_shadows,
                    drop_shadows_scratch: &mut self.state.surfaces.drop_shadows,
                    text_drop_shadows_scratch: &mut self.state.surfaces.text_drop_shadows,
                    filter_scratch: &mut self.state.surfaces.filter,
                    tree: self.shapes,
                    gather_backdrop: backdrop_payload.clone(),
                };
                for effect in &gather_effects {
                    crate::render::ssa::dispatch_effect(&mut ctx, &element, *effect)?;
                }
            }
            self.map.put_back(r, binding);
        }
        Ok(())
    }

    fn composite(&mut self, step: &Step) -> Result<()> {
        if let Step::Composite { from, to, rect, paint: layer_paint, .. } = step {
            if to.is_target() {
                if from.is_target() {
                    return Ok(());
                }
                // `rect` is in WORLD coords (the schedule builder's
                // `clip_rect_for(tile)`). Target's canvas has identity
                // matrix, so we must hand it DEVICE-pixel coords with
                // the viewbox-pan offset baked in — exactly what
                // legacy `get_current_tile_bounds` produces:
                //   device_x = tile.x * TILE_SIZE - viewbox.left * scale
                //
                // Equivalently, from the world rect: convert by
                //   device_x = world_rect.left * scale - viewbox.left * scale
                // (both forms agree because tile world bounds and
                // tile.x * TILE_SIZE / scale match per tile_size = TILE_SIZE/scale).
                let tile = match from.tile {
                    Some(t) => t,
                    None => return Ok(()),
                };
                let scale = self.state.get_scale();
                let offset_x = self.state.viewbox.area.left * scale;
                let offset_y = self.state.viewbox.area.top * scale;
                let device_rect = skia::Rect::from_xywh(
                    tile.x() as f32 * crate::tiles::TILE_SIZE - offset_x,
                    tile.y() as f32 * crate::tiles::TILE_SIZE - offset_y,
                    crate::tiles::TILE_SIZE,
                    crate::tiles::TILE_SIZE,
                );
                let _ = rect; // (kept for trace clarity; replaced by device_rect)
                // Pool surface is 1024×1024 with 256-px margins. Snapshot
                // only the 512×512 content region — mirrors legacy
                // `composite_current_to_target` which extracts the same
                // sub-rect from `Current`.
                let m = self.state.surfaces.margins;
                let content_rect = skia::IRect::from_xywh(
                    m.width,
                    m.height,
                    crate::tiles::TILE_SIZE as i32,
                    crate::tiles::TILE_SIZE as i32,
                );
                let img = self
                    .map
                    .get_mut(*from)
                    .and_then(|s| s.image_snapshot_with_bounds(content_rect));
                if let Some(img) = img {
                    self.state
                        .surfaces
                        .ssa_composite_image_to_target(&img, device_rect);
                }
                Ok(())
            } else {
                // Scope-fold composite: ScopeOf → parent scope
                // (which is itself ScopeOf or TileOutput). Snapshot
                // the `from` surface, apply the `LayerPaint`
                // (opacity/blend/frame-clip-blur), draw into `to`'s
                // canvas at the same device origin. Both surfaces
                // share the same per-tile coord system (pool tile
                // size, same margins), so a (0, 0) draw with identity
                // matrix preserves alignment.
                let img = self.map.get_mut(*from).map(|s| s.image_snapshot());
                let Some(img) = img else { return Ok(()) };
                let mut sk_paint = skia::Paint::default();
                sk_paint.set_alpha(
                    (layer_paint.opacity.clamp(0.0, 1.0) * 255.0) as u8,
                );
                sk_paint.set_blend_mode(layer_paint.blend_mode);
                if let Some(sigma) = layer_paint.frame_blur_sigma_dev {
                    if sigma > 0.0 {
                        if let Some(filter) = skia::image_filters::blur(
                            (sigma, sigma),
                            None,
                            None,
                            None,
                        ) {
                            sk_paint.set_image_filter(filter);
                        }
                    }
                }
                let Some(to_surface) = self.map.get_mut(*to) else {
                    return Ok(());
                };
                let canvas = to_surface.canvas();
                canvas.save();
                canvas.reset_matrix();
                canvas.draw_image(&img, (0.0, 0.0), Some(&sk_paint));
                canvas.restore();
                let _ = rect;
                Ok(())
            }
        } else {
            Ok(())
        }
    }

    fn write_tile_cache(&mut self, step: &Step) -> Result<()> {
        if let Step::WriteTileCache { from, tile } = step {
            let r = *from;
            let tile = *tile;
            if r.is_target() {
                return Ok(());
            }
            // Cache uses the **tile-snapped** offset that legacy
            // `get_aligned_tile_bounds` produces:
            //   aligned_x = floor(viewbox.left * scale / TILE_SIZE) * TILE_SIZE
            //   device_x = tile.x * TILE_SIZE - aligned_x
            // The cache surface has a built-in pre-translate
            // (interest_area_threshold * TILE_SIZE on each axis) that
            // gives 1-tile margin around the viewbox range, so the
            // resulting cache pixel for tile T lands at
            // (T-isx)*TILE_SIZE where isx is the cache's left tile.
            //
            // Different from Target's `composite` rect which uses
            // unsnapped `viewbox.left * scale` (sub-pixel pan-aware).
            let scale = self.state.get_scale();
            let aligned_start_x = (self.state.viewbox.area.left * scale
                / crate::tiles::TILE_SIZE)
                .floor()
                * crate::tiles::TILE_SIZE;
            let aligned_start_y = (self.state.viewbox.area.top * scale
                / crate::tiles::TILE_SIZE)
                .floor()
                * crate::tiles::TILE_SIZE;
            let tile_rect = skia::Rect::from_xywh(
                tile.x() as f32 * crate::tiles::TILE_SIZE - aligned_start_x,
                tile.y() as f32 * crate::tiles::TILE_SIZE - aligned_start_y,
                crate::tiles::TILE_SIZE,
                crate::tiles::TILE_SIZE,
            );

            // Snapshot only the content region (margins stripped) —
            // same sub-rect legacy `cache_current_tile_texture` uses
            // when extracting from `Current`.
            let m = self.state.surfaces.margins;
            let content_rect = skia::IRect::from_xywh(
                m.width,
                m.height,
                crate::tiles::TILE_SIZE as i32,
                crate::tiles::TILE_SIZE as i32,
            );
            let img = self
                .map
                .get_mut(r)
                .and_then(|s| s.image_snapshot_with_bounds(content_rect));
            if let Some(img) = img {
                self.state.surfaces.ssa_cache_tile_image(
                    &self.state.tile_viewbox,
                    &tile,
                    &tile_rect,
                    img,
                );
            }
        }
        Ok(())
    }

    fn begin_layer(&mut self, step: &Step) -> Result<()> {
        if let Step::BeginLayer {
            write_to, paint, ..
        } = step
        {
            let Some(surface) = self.map.get_mut(*write_to) else {
                return Ok(());
            };
            let canvas = surface.canvas();
            let mut sk_paint = skia::Paint::default();
            sk_paint.set_alpha((paint.opacity.clamp(0.0, 1.0) * 255.0) as u8);
            sk_paint.set_blend_mode(paint.blend_mode);
            if let Some(sigma) = paint.frame_blur_sigma_dev {
                if sigma > 0.0 {
                    if let Some(filter) =
                        skia::image_filters::blur((sigma, sigma), None, None, None)
                    {
                        sk_paint.set_image_filter(filter);
                    }
                }
            }
            let rec = skia::canvas::SaveLayerRec::default().paint(&sk_paint);
            canvas.save_layer(&rec);
        }
        Ok(())
    }

    fn end_layer(&mut self, step: &Step) -> Result<()> {
        if let Step::EndLayer { write_to, .. } = step {
            let Some(surface) = self.map.get_mut(*write_to) else {
                return Ok(());
            };
            surface.canvas().restore();
        }
        Ok(())
    }

    fn clear_tile_cache_region(&mut self, step: &Step) -> Result<()> {
        if let Step::ClearTileCacheRegion { tile, rect } = step {
            let _ = rect;
            // Mirror the tile-snapped cache-rect formula used by
            // `write_tile_cache` — same coord convention or the wipe
            // will hit the wrong cache pixels.
            let scale = self.state.get_scale();
            let aligned_start_x = (self.state.viewbox.area.left * scale
                / crate::tiles::TILE_SIZE)
                .floor()
                * crate::tiles::TILE_SIZE;
            let aligned_start_y = (self.state.viewbox.area.top * scale
                / crate::tiles::TILE_SIZE)
                .floor()
                * crate::tiles::TILE_SIZE;
            let device_rect = skia::Rect::from_xywh(
                tile.x() as f32 * crate::tiles::TILE_SIZE - aligned_start_x,
                tile.y() as f32 * crate::tiles::TILE_SIZE - aligned_start_y,
                crate::tiles::TILE_SIZE,
                crate::tiles::TILE_SIZE,
            );
            self.state.surfaces.ssa_clear_tile_cache_rect(
                &self.state.tile_viewbox,
                tile,
                &device_rect,
            );
        }
        Ok(())
    }

    fn on_event(&mut self, _event: TraceEvent) {
        // perf_trace integration lands with the cutover wiring.
    }
}

/// Construct a `SurfaceMap` whose lifetime parameter we ignore —
/// the map's only borrow fields are dead since the refactor below;
/// keeping the lifetime parameter compatible with `SurfaceMap` until
/// it's removed in a follow-up cleanup.
fn empty_map_static() -> SurfaceMap<'static> {
    SurfaceMap::new_data_only()
}
