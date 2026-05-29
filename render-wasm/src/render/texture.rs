use std::cell::OnceCell;

use skia_safe::{self as skia, ColorChannel, RuntimeEffect};

use super::{RenderState, SurfaceId};
use crate::shapes::{Shape, Stroke, TextureEffect};
use crate::state::ShapesPoolRef;
use crate::tiles;

pub const RADIUS_SCALE: f32 = 3.0;

/// Cap the `displacement_map` filter's `scale` parameter (= 2× max per-axis
/// shift) at 2 tiles of filter pixels. That bounds the displacement reach at
/// **1 tile per side** regardless of zoom or UI radius, so the offscreen
/// scratch stays at most `viewport + 2 tiles` — fits easily inside any
/// modern GPU's texture size budget.
///
/// Under this cap: displacement magnitude is world-anchored (Option B) up to
/// roughly zoom ~3×, then caps in screen-pixel terms (Option A behavior) —
/// the extreme-zoom dead-zone is where users wouldn't see the difference
/// anyway.
pub const DISPLACEMENT_CAP_PX: f32 = 2.0 * tiles::TILE_SIZE;

/// Cap the **max noise grain** at the same magnitude — one cycle spans at
/// most 2 tiles of filter pixels. This keeps the noise texture-looking
/// (visible variation in the viewport) even at extreme zoom, where an
/// uncapped world-unit grain would be a single uniform color across the
/// whole visible area.
pub const NOISE_GRAIN_CAP_PX: f32 = 2.0 * tiles::TILE_SIZE;

/// SkSL wrapper that samples a child noise shader in **shape-local,
/// world-unit** coordinates.
///
/// The displacement filter runs in filter-pixel space, so without any
/// coord transform the noise would be sampled at `fractal_noise(filter_px)`
/// — and `filter_px` depends on the current render scale. When we zoom in,
/// the filter-pixel position of the shape's top-left changes, so the noise
/// value "under" each shape-relative point changes → the pattern appears
/// to shift/change on the shape as the user zooms.
///
/// By dividing `(p - shape_tl) * inv_scale`, we convert filter pixels back
/// into **shape-local world units** — a coord frame that depends only on
/// the shape's internal geometry, not on zoom. So `noise(dx, dy)` at a
/// given shape-local point stays constant across all zoom levels: the
/// pattern rides along with the shape, unchanged.
///
/// `base_freq = 1/size` then means "1 cycle per `size` world units" —
/// the UI "Grain Size" is interpreted consistently at any zoom.
const NOISE_SHAPE_LOCAL_SKSL: &str = "
uniform shader noise_child;
uniform float2 shape_tl;
uniform float inv_scale;

half4 main(float2 p) {
    return noise_child.eval((p - shape_tl) * inv_scale);
}
";

thread_local! {
    static NOISE_SHAPE_LOCAL_EFFECT: OnceCell<RuntimeEffect> = const { OnceCell::new() };
}

/// Builds a displacement-map image filter that warps its input using a
/// Perlin noise field. The filter is applied via `save_layer` around the
/// shape's full offscreen render so the entire shape is distorted
/// coherently — matching Figma's `TextureEffect`, which displaces pixels
/// rather than masking them.
///
/// Uses `fractal_noise` (not `turbulence`) because Skia's displacement_map
/// computes the offset as `scale * (n.channel - 0.5)`. Fractal noise has a
/// mean near 0.5 per channel, giving roughly zero net drift; turbulence is
/// the absolute value of the noise and its mean sits well below 0.5, which
/// would bias every pixel in the same direction and shift the whole shape.
///
/// ## Coord spaces used here
///
/// The caller (`render_and_filter_to_image`) opens the save_layer on a
/// **Filter surface at identity CTM**. That means the displacement filter
/// operates in **Filter pixel coordinates** — which, under the per-tile
/// convention we emulate, map to world coords as:
///
/// ```text
///     filter_pixel = scale * (world - extrect.origin) + margin
///     world        = (filter_pixel - margin) / scale + extrect.origin
/// ```
///
/// `extrect` here is whatever rect the caller decides to build the scratch
/// over — the viewport-clipped rect, not the full scheduler-extrect.
/// Because `shape_tl` and the `clip_to_shape` crop rect are expressed
/// relative to this `extrect.origin`, the shape-local coords remain valid
/// whichever `extrect` we pass in.
///
/// - `texture.noise_size` is "grain size in **world** units"; anchored in
///   shape-local coords so the pattern is zoom-stable.
/// - `texture.radius` is the UI slider value (0..100); the actual pixel
///   shift is `radius * RADIUS_SCALE` in layer pixels.
/// - `clip_to_shape = true` passes a crop rect in **filter-pixel** coords
///   (selrect mapped through the per-tile transform).
pub fn build_displacement_filter(
    texture: &TextureEffect,
    shape: &Shape,
    extrect: skia::Rect,
    scale: f32,
    margins: skia::ISize,
) -> Option<skia::ImageFilter> {
    if texture.hidden || texture.radius <= 0.0 {
        return None;
    }

    // Noise grain: user-requested size in world units. Cap it at
    // `NOISE_GRAIN_CAP_PX` filter pixels so a 100-world-unit grain doesn't
    // turn into a 25,600-pixel near-uniform blob at zoom 256×. Above the
    // cap the effective grain shrinks in world units with zoom, keeping
    // visible noise variation in the viewport.
    let raw_grain_world = texture.noise_size.max(1.0);
    let grain_cap_world = NOISE_GRAIN_CAP_PX / scale.max(1e-6);
    let effective_grain_world = raw_grain_world.min(grain_cap_world);
    let base_freq = 1.0 / effective_grain_world;

    // Shape-anchored, zoom-invariant noise via a SkSL wrapper that samples
    // `noise((p - shape_tl) / scale)`. See `NOISE_SHAPE_LOCAL_SKSL`.
    let noise_shader = skia::shaders::fractal_noise((base_freq, base_freq), 4, 0.0, None)?;

    let shape_tl_x = scale * (shape.selrect().left - extrect.left) + margins.width as f32;
    let shape_tl_y = scale * (shape.selrect().top - extrect.top) + margins.height as f32;
    let inv_scale = 1.0 / scale.max(1e-6);

    let anchored_shader = NOISE_SHAPE_LOCAL_EFFECT.with(|cell| {
        let effect = cell.get_or_init(|| {
            RuntimeEffect::make_for_shader(NOISE_SHAPE_LOCAL_SKSL, None)
                .expect("NOISE_SHAPE_LOCAL_SKSL compile failed")
        });

        let uniform_size = effect.uniform_size();
        let mut uniforms = vec![0u8; uniform_size];
        for u in effect.uniforms().iter() {
            let off = u.offset();
            match u.name().as_ref() {
                "shape_tl" => {
                    uniforms[off..off + 4].copy_from_slice(&shape_tl_x.to_ne_bytes());
                    uniforms[off + 4..off + 8].copy_from_slice(&shape_tl_y.to_ne_bytes());
                }
                "inv_scale" => {
                    uniforms[off..off + 4].copy_from_slice(&inv_scale.to_ne_bytes());
                }
                _ => {}
            }
        }

        let children = [skia::runtime_effect::ChildPtr::Shader(noise_shader)];
        effect.make_shader(skia::Data::new_copy(&uniforms), &children, None)
    })?;

    let displacement_source = skia::image_filters::shader(anchored_shader, None)?;

    // R drives X offset, G drives Y offset. The filter's `scale` parameter
    // is the max shift in the layer's pixel space (filter pixels). Max
    // per-axis offset = scale / 2.
    //
    // World-anchored target (Option B): `radius * RADIUS_SCALE` world units
    // of max shift, expressed in filter pixels as `radius*RADIUS_SCALE*scale`.
    // Shape looks identical at any zoom up to the cap.
    //
    // Cap: `DISPLACEMENT_CAP_PX = 2 × TILE_SIZE`. Beyond this, the shift
    // stops scaling with zoom — Option A behavior kicks in. This keeps the
    // offscreen scratch bounded at `viewport + 2 tiles` regardless of zoom,
    // which is what makes 256× zoom actually render without allocating
    // impossibly-huge textures.
    //
    // At the cap the max per-axis shift is exactly `TILE_SIZE` filter
    // pixels = 1 tile. In world units that's `TILE_SIZE / scale` — a full
    // tile at zoom 1, 1/256 of a tile at zoom 256×. Still visible (it's a
    // meaningful fraction of the viewport), just scales with zoom instead
    // of with shape size past the threshold.
    let s_target_px = texture.radius * RADIUS_SCALE * scale;
    let displacement_magnitude_px = s_target_px.min(DISPLACEMENT_CAP_PX);

    if texture.clip_to_shape {
        let selrect = shape.selrect();
        let crop = skia::Rect::from_xywh(
            scale * (selrect.left - extrect.left) + margins.width as f32,
            scale * (selrect.top - extrect.top) + margins.height as f32,
            scale * selrect.width(),
            scale * selrect.height(),
        );
        skia::image_filters::displacement_map(
            (ColorChannel::R, ColorChannel::G),
            displacement_magnitude_px,
            displacement_source,
            None,
            crop,
        )
    } else {
        skia::image_filters::displacement_map(
            (ColorChannel::R, ColorChannel::G),
            displacement_magnitude_px,
            displacement_source,
            None,
            None,
        )
    }
}

