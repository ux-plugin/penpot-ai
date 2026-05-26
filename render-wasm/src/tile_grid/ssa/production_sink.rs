//! Real-GL `DispatchSink` — the production implementation.
//!
//! Owns the per-schedule `SurfaceMap` and bridges into the legacy
//! `RenderState::scheduler_render_effects` for each `Paint` step.
//! The bridge uses an adapter pattern:
//!
//!   1. Pull the pooled surface for the step's `write_to` ref out of
//!      the `SurfaceMap`.
//!   2. `mem::swap` it into `Surfaces.current` (the slot the legacy
//!      per-effect renderers paint into).
//!   3. Call `scheduler_render_effects`.
//!   4. Swap back; put the (now-painted) surface back into the map.
//!
//! This keeps the per-effect renderers (`render::glass`, `render::gather`,
//! `render::scatter`, `render::local`, `render::shape_body`,
//! `render::strokes`, `render::shadows`) **untouched**.
//!
//! `Composite { to: Target }` steps use the legacy
//! `Surfaces::composite_current_to_target` — Target is a sentinel, the
//! map never holds it. `WriteTileCache` uses the legacy
//! `Surfaces::cache_current_tile_texture`.
//!
//! Snapshot / ComposeBackdrop / PaintGather use legacy paths too:
//!   - Snapshot calls `image_snapshot_with_bounds` on the source pool
//!     surface; the result image is held until the consumer fires
//!     (currently kept in a side-table — moved into the map's
//!     `Binding` for a "snapshot image" variant in follow-up work).
//!   - ComposeBackdrop is a no-op for now (the snapshots cover the
//!     simple case where the gather sample fits in one tile).
//!   - PaintGather routes the gather shape's effect to the legacy
//!     `render::gather` / `render::glass` paths via
//!     `scheduler_render_effects` with `EffectKey::Gather(_)` only.

#![cfg(feature = "ssa-ir")]

use rustc_hash::FxHashMap;
use skia_safe as skia;

use super::super::EffectKey;
use super::dispatcher::{DispatchSink, TraceEvent};
use super::step::Step;
use super::surface_map::SurfaceMap;
use super::surface_ref::SurfaceRef;
use crate::error::Result;
use crate::state::ShapesPoolRef;
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
    /// The legacy RenderState — its `gpu_state`, `surfaces`,
    /// `scheduler_render_effects` etc. are all the sink needs to
    /// route SSA steps to the existing per-effect renderers.
    state: &'a mut crate::render::v2::RenderState,
    /// Shape pool, separate from RenderState. The orchestrator
    /// (the cutover wiring in v2.rs) holds and passes both.
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
        state: &'a mut crate::render::v2::RenderState,
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
            let scale = self.state.viewbox.zoom;
            let margins = self.state.surfaces.margins;
            let sampling = skia::SamplingOptions::default();
            let mut ctx = crate::render::ssa::PaintCtx {
                surface: &mut binding.surface,
                tile,
                world_origin,
                world_clip: clip_rect,
                scale,
                fonts: &self.state.fonts,
                images: &self.state.images,
                viewbox: &self.state.viewbox,
                options: &self.state.options,
                nested_fills: &mut self.state.nested_fills,
                sampling,
                gpu: &mut self.state.gpu_state,
                allocator: self.allocator,
                margins,
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
        // ComposeBackdrop fuses multiple per-tile snapshots into one
        // backdrop image. The current SSA path passes the snapshots
        // straight to PaintGather (which samples them via the gather
        // shader); a real fusion (port of `build_gather_backdrop_scoped`)
        // lands when scope-aware gather scenes need it.
        //
        // For the hack-removal cleanup: this is already a no-op (no
        // adapter use), so nothing to rewrite here.
        let _ = step;
        Ok(())
    }

    fn paint_gather(&mut self, step: &Step) -> Result<()> {
        if let Step::PaintGather {
            shape,
            backdrop: _,
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

            // SSA-native dispatch — direct map access, PaintCtx, no
            // swap-into-Current adapter. Gather renderers (glass,
            // bg_blur) currently stub in `render::ssa::dispatch`, so
            // gather scenes render with the gather effect missing
            // until those ports land. The dispatch path is hack-free.
            let tile = r.tile.expect("non-Target ref has a tile");
            let world_origin = skia::Point::new(
                tile.x() as f32 * crate::tiles::get_tile_size(self.state.viewbox.zoom),
                tile.y() as f32 * crate::tiles::get_tile_size(self.state.viewbox.zoom),
            );
            let tile_size_f = crate::tiles::get_tile_size(self.state.viewbox.zoom);
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
                let scale = self.state.viewbox.zoom;
                let margins = self.state.surfaces.margins;
                let sampling = skia::SamplingOptions::default();
                let mut ctx = crate::render::ssa::PaintCtx {
                    surface: &mut binding.surface,
                    tile,
                    world_origin,
                    world_clip,
                    scale,
                    fonts: &self.state.fonts,
                    images: &self.state.images,
                    viewbox: &self.state.viewbox,
                    options: &self.state.options,
                    nested_fills: &mut self.state.nested_fills,
                    sampling,
                    gpu: &mut self.state.gpu_state,
                    allocator: self.allocator,
                    margins,
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
        if let Step::Composite { from, to, rect, .. } = step {
            if to.is_target() {
                if from.is_target() {
                    return Ok(());
                }
                // Direct snapshot from the source pool surface →
                // composite into Target. No swap-into-Current adapter.
                let img = self
                    .map
                    .get_mut(*from)
                    .and_then(|s| s.image_snapshot());
                if let Some(img) = img {
                    self.state
                        .surfaces
                        .ssa_composite_image_to_target(&img, *rect);
                }
                Ok(())
            } else {
                // Scope-fold composite (ScopeOf → parent scope) —
                // SSA-native impl lands with scope emission. Flat
                // scenes don't need this path.
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
            let scale = self.state.viewbox.zoom;
            let tile_size = crate::tiles::get_tile_size(scale);
            let tile_rect = skia::Rect::from_xywh(
                tile.x() as f32 * tile_size,
                tile.y() as f32 * tile_size,
                tile_size,
                tile_size,
            );

            // Direct snapshot → cache, no swap-into-Current.
            let img = self.map.get_mut(r).and_then(|s| s.image_snapshot());
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
