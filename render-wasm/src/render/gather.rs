//! Phase 7 — unified gather backdrop pipeline.
//!
//! A "gather" effect is one that samples the canvas under a shape and
//! redraws into the shape's silhouette: glass refraction, background
//! blur. Both share the same plumbing:
//!
//!   1. snapshot a backdrop image (subset of source surface)
//!   2. cache by shape geometry + backdrop hash + scale
//!   3. consume the cached image during paint
//!
//! This module abstracts (1)/(3) behind a single `GatherKind` enum.
//! `BuildCache(Gather)` and the `Paint` Gather arms in `tile_grid.rs`
//! both go through it. The cache (`effect_cache`) is keyed by
//! `EffectCacheKey { effect: EffectKey::Gather(_), .. }` regardless of
//! sub-variant.
//!
//! Bbox-bounded snapshots: the snapshot covers `selrect` grown by the
//! effect's sample radius (3σ), not the whole source surface. This
//! caps memory pressure at `selrect_area * 4` bytes per cache entry
//! instead of `viewport_area * 4`, keeping iso_glass-style scenes
//! comfortably inside the 96 MB cap.
//!
//! See `docs/CACHE_PHASES.md` (or the phase 7 plan in CLAUDE.md) for
//! the full architecture.

use skia_safe as skia;
use uuid::Uuid;

use crate::shapes::{Blur, GlassEffect, Shape};
use crate::tile_grid::{EffectKey, GatherFx};

use super::{RenderState, SurfaceId};

/// One gather effect bound to a shape. Borrows the effect data from
/// the shape so the wrapper is cheap to construct per-tile.
pub enum GatherKind<'a> {
    Glass(&'a GlassEffect),
    BgBlur(&'a Blur),
}

impl<'a> GatherKind<'a> {
    /// Pick the gather effect for a shape. When both glass and bg_blur
    /// are present (rare), glass wins — matches scheduler emit order
    /// in `effects_for_shape`.
    pub fn from_shape(shape: &'a Shape) -> Option<Self> {
        if let Some(g) = shape.glass.as_ref().filter(|g| !g.hidden) {
            return Some(Self::Glass(g));
        }
        if let Some(b) = shape.background_blur.as_ref().filter(|b| !b.hidden) {
            return Some(Self::BgBlur(b));
        }
        None
    }

    /// EffectKey discriminant for cache lookups. Keeps Glass and
    /// BgBlur in separate cache slots so a shape carrying both
    /// (rare) gets one entry per variant.
    pub fn effect_key(&self) -> EffectKey {
        match self {
            Self::Glass(_) => EffectKey::Gather(GatherFx::Glass),
            Self::BgBlur(_) => EffectKey::Gather(GatherFx::BackgroundBlur),
        }
    }

    /// Hash of effect parameters that materially change the rendered
    /// output. Same hashes as the per-variant helpers in
    /// `effect_cache`, routed by sub-variant.
    pub fn params_hash(&self) -> u64 {
        match self {
            Self::Glass(g) => crate::effect_cache::hash_glass_params(g),
            Self::BgBlur(b) => crate::effect_cache::hash_blur_params(b),
        }
    }

    /// Sigma in world-pixel units that determines how far the effect
    /// samples beyond `selrect`. The snapshot bbox grows by `3 * sigma`
    /// on each side so the kernel never reads outside the cached image.
    fn sample_sigma_world(&self) -> f32 {
        match self {
            Self::Glass(g) => g.total_blur_sigma(),
            Self::BgBlur(b) => crate::shapes::radius_to_sigma(b.value),
        }
    }

    /// Backdrop snapshot bounds in *world* coords. Caller maps to the
    /// chosen source surface's device pixels via the standard
    /// translation used by `render_glass_with_backdrop_image` /
    /// `render_background_blur`.
    pub fn extent_world(&self, shape: &Shape) -> skia::Rect {
        let r = shape.selrect;
        // Use 3σ margin (covers ~99.7% of Gaussian energy) so the
        // sample kernel never reaches outside the cached image.
        // Glass also has refraction displacement; cap by displacement
        // amplitude (≈ glass_thickness * scale) at the snapshot
        // call-site if needed. For now 3σ + a small constant covers
        // the common case.
        let pad = self.sample_sigma_world() * 3.0 + 4.0;
        skia::Rect::from_ltrb(r.left - pad, r.top - pad, r.right + pad, r.bottom + pad)
    }

    /// Surface from which the backdrop snapshot is taken. Root-level
    /// gathers source from `Target` (post `composite_current_to_target`)
    /// so the snapshot reflects the world-space continuous canvas;
    /// nested gathers source from `Current` (the parent band's
    /// in-progress tile surface).
    pub fn snapshot_source(&self, is_root_level: bool) -> SurfaceId {
        if is_root_level {
            SurfaceId::Target
        } else {
            SurfaceId::Current
        }
    }

    /// Render the gather using a pre-fetched backdrop image. Routes
    /// to the per-variant renderer.
    ///
    /// `bounds_origin_devpx` (when `Some`) is the top-left of the
    /// backdrop image in the backdrop surface's device-pixel coords.
    /// `None` keeps the legacy "full surface snapshot" semantics.
    pub fn render(
        &self,
        state: &mut RenderState,
        shape: &Shape,
        backdrop: skia::Image,
        backdrop_id: SurfaceId,
        output: SurfaceId,
        bounds_origin_devpx: Option<skia::IPoint>,
    ) {
        match self {
            Self::Glass(glass) => {
                crate::render::glass::render_glass_with_backdrop_image(
                    state,
                    shape,
                    glass,
                    output,
                    backdrop_id,
                    Some(backdrop),
                    bounds_origin_devpx,
                );
            }
            Self::BgBlur(_) => {
                state.render_background_blur_from_image(
                    shape,
                    backdrop,
                    bounds_origin_devpx,
                    output,
                );
            }
        }
    }
}

/// Helper to compute the world-extent in *device pixels of the
/// chosen source surface*. For `SurfaceId::Target`, origin = viewbox
/// top-left at margins offset. For `SurfaceId::Current`, origin =
/// render_area top-left at render-context translation.
///
/// The returned rect is clipped to the source surface's bounds so the
/// snapshot never tries to sample outside the surface.
pub fn extent_in_source_devpx(
    state: &mut RenderState,
    shape: &Shape,
    gather: &GatherKind<'_>,
    source: SurfaceId,
) -> skia::IRect {
    let scale = state.get_scale();
    let world = gather.extent_world(shape);

    let (origin_x, origin_y, surf_w, surf_h) = match source {
        SurfaceId::Target => {
            let margins = state.surfaces.margins();
            let viewbox = state.viewbox;
            let ox = margins.width as f32 + (world.left - viewbox.area.left) * scale;
            let oy = margins.height as f32 + (world.top - viewbox.area.top) * scale;
            // Target dim: margins + viewbox*scale + margins
            let surf = state.surfaces.surface_dim(source);
            (ox, oy, surf.0, surf.1)
        }
        _ => {
            let translation = state
                .surfaces
                .get_render_context_translation(state.render_area, scale);
            // Current/etc: world point p maps to (p + translation) * scale
            // = p*scale + translation*scale.
            let ox = (world.left + translation.0) * scale;
            let oy = (world.top + translation.1) * scale;
            let surf = state.surfaces.surface_dim(source);
            (ox, oy, surf.0, surf.1)
        }
    };

    let w = (world.width() * scale).ceil() as i32;
    let h = (world.height() * scale).ceil() as i32;
    let l = origin_x.floor() as i32;
    let t = origin_y.floor() as i32;
    let r = l + w;
    let b = t + h;

    // Clamp to source surface bounds.
    let l = l.max(0);
    let t = t.max(0);
    let r = r.min(surf_w);
    let b = b.min(surf_h);
    if r <= l || b <= t {
        skia::IRect::new_empty()
    } else {
        skia::IRect::from_ltrb(l, t, r, b)
    }
}

/// Convenience wrapper used by the BuildCache(Gather) arm: returns the
/// id-keyed cache slot insertion + the bounds origin so the Paint arm
/// can pull both back out atomically.
pub struct GatherSnapshot {
    pub shape_id: Uuid,
    pub image: skia::Image,
    pub origin_devpx: skia::IPoint,
}
