//! V2c.1 — leaf layer-blur cache.
//!
//! Layer blur on a leaf shape today runs inside `render_shape`'s
//! `save_layer(image_filter::blur)` chain — repeated per-tile per-frame
//! even when neither the shape nor its blur params changed. iso_layer_blur
//! benchmarks pay this cost across 200 leaves × ~16 tiles × 60 fps.
//!
//! V2c.1 lifts the blur out of the per-tile path: render the unblurred
//! body (fills + strokes) into a bbox-bounded offscreen scratch, apply
//! the blur as a single `save_layer(image_filter::blur)`, snapshot the
//! result, cache cross-frame in `effect_cache`, blit per-tile.
//!
//! Scope (V2c.1):
//! - leaf shapes only — no children, no inherited blur
//! - no inner-shadow shapes (drop shadows OK — they're scatter, separate)
//! - non-text only (text shadows live in the paragraph filter)
//! - non-scatter (scatter handles its own offscreen)
//! - no glass / bg-blur — those are gather, separate cache
//!
//! Container layer blur, inherited blur, and inner-shadow + layer-blur
//! combos are deferred to V2c.3 (BeginLayer/EndLayer scaffold).

use std::hash::{Hash, Hasher};

use skia_safe as skia;

use crate::shapes::{radius_to_sigma, Blur, BlurType, Shape, Type};
use crate::tile_grid::{EffectKey, LocalFx};

use super::{RenderState, SurfaceId};

/// One Local effect bound to a shape. Today only `LayerBlur` is here;
/// future Local effects (e.g. cached fills, cached inner shadows) will
/// live as additional variants.
pub enum LocalKind<'a> {
    /// Cached layer-blur output — bounded by `selrect ± 3σ`.
    LayerBlur { sigma: f32, _shape: &'a Shape },
}

impl<'a> LocalKind<'a> {
    /// Build a `LayerBlur` for a leaf shape that qualifies for caching.
    /// Returns `None` for shapes outside V2c.1 scope (text/SVG, scatter,
    /// inner shadows, no blur, hidden blur, zero sigma).
    pub fn from_shape_layer_blur(shape: &'a Shape) -> Option<Self> {
        // Debug instrumentation — POST a single line per call describing
        // the predicate outcome so the agent can spot which gate fails
        // for a given shape. Gated on `perf-trace` to stay zero-cost in
        // production builds.
        #[cfg(feature = "perf-trace")]
        let mut _reject: Option<&'static str> = None;
        // Text/SVG: blur is handled inside the paragraph filter or SVG
        // dom render, not via save_layer. Out of scope.
        if matches!(shape.shape_type, Type::Text(_)) || matches!(shape.shape_type, Type::SVGRaw(_))
        {
            #[cfg(feature = "perf-trace")]
            {
                _reject = Some("type_text_or_svg");
            }
            #[cfg(feature = "perf-trace")]
            return _post_layer_blur_decision(shape, _reject);
            #[cfg(not(feature = "perf-trace"))]
            return None;
        }
        let blur_opt = shape
            .blur
            .filter(|b| !b.hidden && b.blur_type == BlurType::LayerBlur && b.value > 0.0);
        let Some(blur) = blur_opt else {
            #[cfg(feature = "perf-trace")]
            {
                _reject = Some(match shape.blur {
                    None => "no_blur",
                    Some(b) if b.hidden => "blur_hidden",
                    Some(b) if b.blur_type != BlurType::LayerBlur => "blur_wrong_type",
                    Some(b) if b.value <= 0.0 => "blur_zero_value",
                    _ => "blur_unknown",
                });
            }
            #[cfg(feature = "perf-trace")]
            return _post_layer_blur_decision(shape, _reject);
            #[cfg(not(feature = "perf-trace"))]
            return None;
        };
        // Inner shadows + scatter + glass + bg-blur all want their own
        // cache plumbing. V2c.1 keeps the leaf body simple.
        if shape.inner_shadows_visible().next().is_some() {
            #[cfg(feature = "perf-trace")]
            {
                _reject = Some("has_inner_shadows");
            }
            #[cfg(feature = "perf-trace")]
            return _post_layer_blur_decision(shape, _reject);
            #[cfg(not(feature = "perf-trace"))]
            return None;
        }
        if shape
            .texture
            .as_ref()
            .is_some_and(|t| !t.hidden && t.radius > 0.0)
        {
            #[cfg(feature = "perf-trace")]
            {
                _reject = Some("has_texture_scatter");
            }
            #[cfg(feature = "perf-trace")]
            return _post_layer_blur_decision(shape, _reject);
            #[cfg(not(feature = "perf-trace"))]
            return None;
        }
        if shape.glass.as_ref().is_some_and(|g| !g.hidden) {
            #[cfg(feature = "perf-trace")]
            {
                _reject = Some("has_glass");
            }
            #[cfg(feature = "perf-trace")]
            return _post_layer_blur_decision(shape, _reject);
            #[cfg(not(feature = "perf-trace"))]
            return None;
        }
        if shape.background_blur.is_some_and(|b| !b.hidden) {
            #[cfg(feature = "perf-trace")]
            {
                _reject = Some("has_bg_blur");
            }
            #[cfg(feature = "perf-trace")]
            return _post_layer_blur_decision(shape, _reject);
            #[cfg(not(feature = "perf-trace"))]
            return None;
        }
        #[cfg(feature = "perf-trace")]
        crate::perf_trace::log_layer_blur_qualified(shape.id, blur.value, blur.sigma());
        Some(Self::LayerBlur {
            sigma: blur.sigma(),
            _shape: shape,
        })
    }

    /// Sigma the blur kernel will sample with, in WORLD pixels.
    /// `Surface::image_snapshot_with_bounds` covers `selrect ± 3σ` so
    /// the kernel never reads outside the cached image at sample time.
    fn sample_sigma_world(&self) -> f32 {
        match self {
            LocalKind::LayerBlur { sigma, .. } => *sigma,
        }
    }

    pub fn effect_key(&self) -> EffectKey {
        match self {
            LocalKind::LayerBlur { .. } => EffectKey::Local(LocalFx::LayerBlur),
        }
    }

    pub fn params_hash(&self) -> u64 {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        match self {
            LocalKind::LayerBlur { sigma, .. } => {
                0u8.hash(&mut h);
                sigma.to_bits().hash(&mut h);
            }
        }
        h.finish()
    }

    /// Bbox of the cached image in WORLD coords. Caller maps to
    /// device pixels at blit time using the per-tile render-context
    /// translation.
    pub fn extent_world(&self, shape: &Shape) -> skia::Rect {
        let r = shape.selrect;
        // 3σ padding covers ~99.7% of Gaussian energy. Plus a few
        // pixels of slack for stroke caps and antialiased edges.
        let pad = self.sample_sigma_world() * 3.0 + 4.0;
        skia::Rect::from_ltrb(r.left - pad, r.top - pad, r.right + pad, r.bottom + pad)
    }

    /// Render the layer-blurred shape body into `SurfaceId::Filter`,
    /// snapshot the bounded subrect, return `(image, world_bbox)`.
    /// Returns `None` if the bounding extent overflows the Filter
    /// surface (caller falls back to legacy per-tile blur path).
    pub fn render_to_image(
        &self,
        state: &mut RenderState,
        shape: &Shape,
    ) -> Option<(skia::Image, skia::Rect)> {
        let scale = state.get_scale();
        let extrect_world = self.extent_world(shape);
        if !extrect_world.is_finite()
            || extrect_world.width() <= 0.0
            || extrect_world.height() <= 0.0
        {
            return None;
        }
        let needed_w = (extrect_world.width() * scale).ceil() as i32;
        let needed_h = (extrect_world.height() * scale).ceil() as i32;
        let (filter_w, filter_h) = state.surfaces.filter_size();
        if needed_w > filter_w || needed_h > filter_h {
            // Out of scratch capacity — caller falls back to legacy
            // path which renders + blurs inline per tile.
            return None;
        }

        // Build the blur image filter at device sigma.
        let dev_sigma = self.sample_sigma_world() * scale;
        let blur_filter =
            skia::image_filters::blur((dev_sigma, dev_sigma), skia::TileMode::Decal, None, None)?;

        // Clear Filter to transparent so old content from the prior
        // BuildCache(LocalBlur) call doesn't leak into this snapshot.
        let canvas = state.surfaces.canvas_and_mark_dirty(SurfaceId::Filter);
        canvas.save();
        canvas.reset_matrix();
        canvas.clear(skia::Color::TRANSPARENT);
        canvas.restore();

        // Zero-margin CTM: world point W lands at filter pixel
        // `scale * (W - extrect_world.origin)`. No `+ margin/scale`
        // term because this is a one-shot render, not a tile-bleed
        // pass. Matches the scatter scratch convention.
        let canvas = state.surfaces.canvas(SurfaceId::Filter);
        canvas.save();
        canvas.scale((scale, scale));
        canvas.translate((-extrect_world.left, -extrect_world.top));

        // Apply shape transform around its center — same setup
        // `render_shape` uses on the per-tile path.
        let center = shape.center();
        let mut matrix = shape.transform;
        matrix.post_translate(center);
        matrix.pre_translate(-center);
        canvas.concat(&matrix);

        // Open the layer-blur layer. All subsequent draws (fills,
        // strokes) land inside; restore composites the blurred result
        // onto Filter.
        let mut layer_paint = skia::Paint::default();
        layer_paint.set_image_filter(blur_filter);
        let layer_rec = skia::canvas::SaveLayerRec::default().paint(&layer_paint);
        canvas.save_layer(&layer_rec);

        // Render fills + strokes. We bypass `render_shape` because
        // its own save_layer/blur chain would double-apply the blur;
        // the cache key already commits us to *this* exact body, so
        // we stage just fills + strokes directly.
        let antialias = shape.should_use_antialias(scale, state.options.antialias_threshold);
        let fill_result =
            crate::render::fills::render(state, shape, &shape.fills, antialias, SurfaceId::Filter, None);
        let stroke_result = if fill_result.is_ok() {
            let strokes: Vec<&crate::shapes::Stroke> = shape.visible_strokes().collect();
            crate::render::strokes::render(
                state,
                shape,
                &strokes,
                Some(SurfaceId::Filter),
                antialias,
                None,
            )
        } else {
            Ok(())
        };
        if fill_result.is_err() || stroke_result.is_err() {
            // Bail — caller's defensive fallback paints inline.
            let canvas = state.surfaces.canvas(SurfaceId::Filter);
            canvas.restore(); // close layer
            canvas.restore(); // pop CTM
            return None;
        }

        // Close the layer (composites blurred body onto Filter).
        let canvas = state.surfaces.canvas(SurfaceId::Filter);
        canvas.restore();
        // Pop CTM.
        canvas.restore();

        // Force the GPU to finish so the snapshot below sees the
        // composited bytes. `image_snapshot_with_bounds` triggers a
        // GPU flush internally on Ganesh, but being explicit here
        // matches the gather + scatter snapshot patterns.
        state.flush_and_submit();

        let snap = state
            .surfaces
            .snapshot_subrect(SurfaceId::Filter, skia::IRect::from_xywh(0, 0, needed_w, needed_h))?;
        Some((snap, extrect_world))
    }

    /// Blit a cached layer-blur snapshot onto `output`. The image is
    /// in device pixels at the build-time scale; we translate the
    /// canvas to put the image's (0, 0) at the world point
    /// `world_bbox.top_left` mapped into `output`'s device coords.
    pub fn paint_cached(
        state: &mut RenderState,
        image: &skia::Image,
        world_bbox: skia::Rect,
        output: SurfaceId,
    ) {
        let scale = state.get_scale();
        let translation = state
            .surfaces
            .get_render_context_translation(state.render_area, scale);

        // Map world (left, top) → output devpx. Same math as the
        // per-tile render_shape path uses for its content origin.
        let dev_x = (world_bbox.left + translation.0) * scale;
        let dev_y = (world_bbox.top + translation.1) * scale;

        let canvas = state.surfaces.canvas_and_mark_dirty(output);
        canvas.save();
        canvas.reset_matrix();
        let dst = skia::Rect::from_xywh(
            dev_x,
            dev_y,
            image.width() as f32,
            image.height() as f32,
        );
        let sampling = skia::SamplingOptions::new(skia::FilterMode::Linear, skia::MipmapMode::None);
        canvas.draw_image_rect_with_sampling_options(
            image,
            None,
            dst,
            sampling,
            &skia::Paint::default(),
        );
        canvas.restore();
    }
}

/// Sigma of `shape.blur` if it qualifies for V2c.1 leaf-layer-blur
/// caching. `None` when blur is hidden, zero, wrong type, or the
/// shape is outside scope (text/SVG, scatter, gather, inner shadow).
/// Used by the scheduler emit-step to decide between
/// `LocalFx::LayerBlur` and `LocalFx::ShapeBody`.
pub fn shape_qualifies_for_layer_blur_cache(shape: &Shape) -> bool {
    LocalKind::from_shape_layer_blur(shape).is_some()
}

/// perf-trace helper. POSTs the per-shape rejection reason + key
/// inspection fields so the agent can spot why a shape was excluded
/// from the layer-blur cache. Always returns `None` — wraps the
/// early-return pattern.
#[cfg(feature = "perf-trace")]
fn _post_layer_blur_decision<'a>(
    shape: &Shape,
    reject: Option<&'static str>,
) -> Option<LocalKind<'a>> {
    crate::perf_trace::log_layer_blur_decision(shape, reject);
    None
}

/// Compute `radius_to_sigma`-style sigma helper for tests. Kept here
/// so the cache key's `params_hash` stays in lockstep with
/// `Blur::sigma`.
#[allow(dead_code)]
fn blur_sigma(b: &Blur) -> f32 {
    radius_to_sigma(b.value)
}
