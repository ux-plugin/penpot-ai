//! The truly-shared leaf paint both Vello backends draw through — a node's own fills and strokes
//! ([`paint_body`]) and the paint-kind resolution under them ([`set_paint`]: solid, gradient, image,
//! diamond), plus the [`DrawEnv`] seam they need.
//!
//! This holds **only** what is identical for both backends and generic over any `RenderingContext` —
//! no tree walk, no effects, no `if backend` branch. Each backend owns its own walker and its own
//! effect constructions (hybrid in `render-vello/src/scene.rs`; classic in
//! `vello-gpu-renderer/src/walk.rs`) and calls down into these leaf helpers, so the two never diverge
//! at the leaves while staying free to map effects onto their own primitives above.
//!
//! ## The [`DrawEnv`] seam
//! The only thing paint resolution needs from the host is *which atlas id* an image or baked-diamond
//! reference maps to — a lookup that lives in render-vello's ABI globals and must not leak into this
//! backend-neutral crate. [`DrawEnv`] injects it: the hybrid backend supplies an env backed by its
//! ABI atlas map; the classic backend supplies one that returns `None` until image staging lands.

use crate::blend::DEFAULT_BLEND;
use crate::geometry::outline;
use crate::gradient::DIAMOND_TILE;
use crate::kurbo::{Affine, BezPath, Rect, Shape};
use crate::model::{self as m, Brush, Node, ShapeKind, StrokeAlign};
use vello_common::paint::ImageId;
use vello_example_scenes::{Fill, RenderingContext};

/// The host services the neutral drawer needs but cannot own, injected so this crate stays free of
/// the ABI globals: image/diamond atlas resolution and font-family aliasing for text layout.
pub trait DrawEnv {
    /// Resolve an image or baked-diamond content reference to its atlas id, or `None` when the
    /// pixels have not been staged yet — in which case that paint draws nothing this frame and
    /// appears the frame after the upload lands. The classic backend returns `None` until it has an
    /// image atlas.
    fn resolve_image(&self, id: u128) -> Option<ImageId>;

    /// The font-family name a `(font id, weight, italic)` reference was registered under in the
    /// backend's Parley `FontContext`, so text layout can select it by name. The hybrid backend
    /// returns its ABI alias; a backend registers faces under whatever names it returns here.
    fn font_alias(&self, id: u128, weight: u16, italic: bool) -> String;
}

/// Paint a node's own geometry (fills then strokes), ignoring its children — the backend-neutral
/// twin of `scene.rs`'s `paint_self`. `matrix` is the fully-composed page→device→shape transform.
///
/// `group_inline` decides who owns a **leaf's** opacity/blend. The whole-scene walkers pass `true`:
/// there is no composite step, so a leaf's own opacity/blend must be applied here, inline, wrapping
/// its marks in a layer (matching render-wasm's per-shape save-layer). The tiled sink passes `false`:
/// the scheduler now routes every non-trivial-layer-paint shape to its own surface and applies the
/// opacity/blend at the `Composite` step (which reads the tile's real backdrop, so a `Multiply` etc.
/// composites correctly and — unlike a per-tile inline layer — cannot seam where the shape straddles
/// a tile boundary). Painting the body raw here is exactly what that composite wants.
pub fn paint_body<C: RenderingContext, E: DrawEnv>(
    ctx: &mut C,
    env: &E,
    node: &Node,
    matrix: Affine,
    group_inline: bool,
) {
    // A group has no geometry of its own; it exists to carry the layer.
    if node.kind == ShapeKind::Group {
        return;
    }
    if node.fills.is_empty() && node.strokes.is_empty() {
        return;
    }

    ctx.set_fill_rule(Fill::NonZero);
    ctx.set_transform(matrix);

    // A leaf's own opacity/blend, applied inline only when the caller owns compositing here
    // (`group_inline`); under the sink it is deferred to the `Composite` step — see the doc above.
    let leaf_layer = group_inline
        && !node.kind.is_container()
        && (node.opacity < 1.0 || node.blend != DEFAULT_BLEND);
    if leaf_layer {
        let blend = (node.blend != DEFAULT_BLEND).then_some(node.blend);
        let alpha = (node.opacity < 1.0).then_some(node.opacity);
        ctx.push_layer(None, blend, alpha, None, None);
    }

    // Every fill paints, back to front, so a translucent fill blends over the ones beneath it.
    // render-wasm draws `fills[0]` on top (`merge_fills` / `fills.iter().rev()`), so iterate in
    // reverse — `fills[last]` first, `fills[0]` last. `SrcOver` is associative, so painting the shape
    // once per fill matches render-wasm's single merged-shader result exactly. A fill this backend
    // can't paint yet (an unstaged image/diamond) is skipped, and the fills under it still draw.
    for fill in node.fills.iter().rev() {
        if !set_paint(ctx, env, fill, node.bounds) {
            continue;
        }
        match node.kind {
            // The one case worth a fast path: a square-cornered rect needs no path at all.
            ShapeKind::Rect | ShapeKind::Frame if node.corners.is_none() => {
                ctx.fill_rect(&node.bounds)
            }
            ShapeKind::Path => {
                if let Some(path) = &node.path {
                    ctx.fill_path(path);
                }
            }
            _ => ctx.fill_path(&outline(node)),
        }
    }

    // Strokes go over the fills, back to front, on this node's own outline.
    if !node.strokes.is_empty() {
        let path = outline(node);
        for stroke in &node.strokes {
            if !set_paint(ctx, env, &stroke.paint, node.bounds) {
                continue;
            }
            match stroke.align {
                // Centre: kurbo strokes are centre-aligned already, so paint the outline directly.
                StrokeAlign::Center => {
                    ctx.set_stroke(stroke.style.clone());
                    ctx.stroke_path(&path);
                }
                // Inner/outer put the full stroke weight on one side of the edge (Skia/Figma
                // semantics), which a centre-aligned stroke cannot express. Draw a **double-width**
                // centre stroke — a `2·w` band straddling the edge, `w` inside and `w` outside — then
                // clip to just the half we want: the shape interior for inner, its complement for
                // outer. What survives is exactly a `w`-wide band flush against the edge, matching
                // render-wasm's `clip(Intersect)` (inner) / draw-then-`Clear`-the-interior (outer).
                StrokeAlign::Inner | StrokeAlign::Outer => {
                    let mut style = stroke.style.clone();
                    style.width *= 2.0;
                    let clip = match stroke.align {
                        StrokeAlign::Inner => path.clone(),
                        _ => complement_of(&path),
                    };
                    ctx.push_layer(Some(&clip), None, None, None, None);
                    ctx.set_stroke(style);
                    ctx.stroke_path(&path);
                    ctx.pop_layer();
                }
            }
        }
    }

    // The paint transform is context state, not an argument: left set, the next shape's solid fill
    // would be drawn through this shape's gradient mapping.
    ctx.set_paint_transform(Affine::IDENTITY);
    if leaf_layer {
        ctx.pop_layer();
    }
}

/// Install a paint as the current one. Returns false when this backend cannot draw it *this frame*
/// (an image/diamond whose pixels have not been staged), so the caller can fall through to the next
/// fill rather than drawing nothing.
///
/// **Gradient coordinates are normalised to the shape's own box**, not page space — Penpot's
/// exporter emits `0..1` and render-wasm maps them with `translate(rect.origin) · scale(rect.size)`
/// as a shader-local matrix. Vello's paint transform has exactly those semantics (applied to the
/// paint after the geometry's transform), so the same mapping is expressed the same way. Drawn
/// without it, every gradient collapses into the top-left pixel of the page.
///
/// The paint's own transform composes *inside* that: it carries a radial gradient's rotation and
/// ellipse ratio, and an angular one's shear, all in unit-box space. `crate::gradient` builds
/// it alongside the gradient so neither backend re-derives the matrix.
pub fn set_paint<C: RenderingContext, E: DrawEnv>(
    ctx: &mut C,
    env: &E,
    paint: &m::Paint,
    bounds: Rect,
) -> bool {
    match &paint.brush {
        Brush::Solid(color) => {
            ctx.set_paint_transform(Affine::IDENTITY);
            ctx.set_paint(*color);
            true
        }
        Brush::Gradient(g) => {
            ctx.set_paint_transform(unit_box_to(bounds) * paint.transform);
            ctx.set_paint(g.clone());
            true
        }
        Brush::Image(image) => {
            // Resolve the reference against the atlas the renderer filled from `store_image_rgba`.
            // Absent means the pixels have not arrived yet — draw nothing this frame rather than a
            // placeholder, and the next frame after the upload will show it.
            let Some(image_id) = env.resolve_image(image.id) else {
                return false;
            };
            let target = image.dest.unwrap_or(bounds);
            ctx.set_paint_transform(image_paint_transform(image, target));
            ctx.set_paint(vello_common::paint::Image {
                image: vello_common::paint::ImageSource::opaque_id(image_id),
                sampler: vello_common::peniko::ImageSampler {
                    // Clamp at the edges: with the cover/stretch transform the fill never samples
                    // outside the image, so the extend mode only matters at sub-pixel borders.
                    x_extend: vello_common::peniko::Extend::Pad,
                    y_extend: vello_common::peniko::Extend::Pad,
                    quality: vello_common::peniko::ImageQuality::Medium,
                    alpha: f32::from(image.opacity) / 255.0,
                },
            });
            true
        }
        Brush::Diamond(d) => {
            // Diamond has no peniko kind, so it is baked to a tile and drawn as an image. The
            // renderer's pre-pass (`stage_diamond_bakes`) rasterises the L1 field and uploads it
            // under this content key; here it resolves exactly like an image fill. Absent means the
            // bake has not landed yet — draw nothing this frame, painted the next.
            let Some(image_id) = env.resolve_image(d.content_key()) else {
                return false;
            };
            // The bake covers the unit box, but it is an *image* now, sampled in pixel space — so
            // the transform maps the whole tile `[0, TILE]²` onto the shape, exactly the stretch a
            // plain image uses. (Mapping unit space `[0,1]` here samples only the tile's first pixel
            // across the whole shape — which is how the first cut rendered solid.) The non-square
            // distortion comes from this stretch, matching render-wasm's normalised-space shader.
            // Stop alphas are baked in; the sampler adds none.
            let tile = f64::from(DIAMOND_TILE);
            ctx.set_paint_transform(
                Affine::translate((bounds.x0, bounds.y0))
                    * Affine::scale_non_uniform(bounds.width() / tile, bounds.height() / tile),
            );
            ctx.set_paint(vello_common::paint::Image {
                image: vello_common::paint::ImageSource::opaque_id(image_id),
                sampler: vello_common::peniko::ImageSampler {
                    x_extend: vello_common::peniko::Extend::Pad,
                    y_extend: vello_common::peniko::Extend::Pad,
                    quality: vello_common::peniko::ImageQuality::Medium,
                    alpha: 1.0,
                },
            });
            true
        }
    }
}

/// Map the image's pixel space onto its target rect, in the shape's local coordinates.
///
/// Two placements, matching render-wasm's `get_source_rect`:
/// - **stretch** (default): the image fills the box exactly, distorting aspect if it must.
/// - **cover** (`keep_aspect`): the image is scaled by the larger axis ratio and centred, so it
///   covers the box with no letterboxing; the overflow is clipped by the fill to `target`.
fn image_paint_transform(image: &m::ImageFill, target: Rect) -> Affine {
    let (iw, ih) = (f64::from(image.width.max(1)), f64::from(image.height.max(1)));
    let (tw, th) = (target.width(), target.height());

    if image.keep_aspect {
        let scale = (tw / iw).max(th / ih);
        // Centre the scaled image over the target; the fill clips whatever spills past it.
        let ox = target.x0 + (tw - iw * scale) * 0.5;
        let oy = target.y0 + (th - ih * scale) * 0.5;
        Affine::translate((ox, oy)) * Affine::scale(scale)
    } else {
        Affine::translate((target.x0, target.y0)) * Affine::scale_non_uniform(tw / iw, th / ih)
    }
}

/// A clip region covering **everything except** the given path's interior — a huge rect with a
/// path-shaped hole — used to keep only the *outer* half of a double-width stroke.
///
/// Both backends punch the clip with the **non-zero** winding rule (classic hard-codes `NonZero`;
/// hybrid follows the current fill rule, which `paint_body` leaves at `NonZero`). A hole only appears
/// under non-zero when the inner contour winds *opposite* the outer rect, so the path is reversed
/// whenever its signed area shares the rect's sign — making the winding cancel inside it regardless
/// of the source path's original direction.
fn complement_of(path: &BezPath) -> BezPath {
    // Far larger than any surface, so the rect's own edges never clip the finite outer band.
    let mut out = Rect::new(-1.0e6, -1.0e6, 1.0e6, 1.0e6).to_path(0.0);
    let mut hole = path.clone();
    if hole.area().signum() == out.area().signum() {
        hole = hole.reverse_subpaths();
    }
    out.extend(hole.iter());
    out
}

/// Maps the unit box onto `bounds` — the space Penpot's gradient coordinates live in.
fn unit_box_to(bounds: Rect) -> Affine {
    // A zero-extent axis would collapse the paint onto a line and hand the rasteriser a singular
    // matrix; leaving that axis unscaled keeps the fill finite and visible.
    let sx = if bounds.width().abs() > f64::EPSILON {
        bounds.width()
    } else {
        1.0
    };
    let sy = if bounds.height().abs() > f64::EPSILON {
        bounds.height()
    } else {
        1.0
    };
    Affine::translate((bounds.x0, bounds.y0)) * Affine::scale_non_uniform(sx, sy)
}
