//! The neutral document drawer — walks a `render_core::model::Scene` in z-order and draws it into
//! any `RenderingContext`.
//!
//! This is the backend-neutral *core* of render-vello's `scene.rs`: the tree walk, the isolation
//! groups (opacity/blend → push/pop layer), and every fill/stroke paint kind (solid, gradient,
//! image, diamond). It is the single copy both Vello backends share — the classic backend renders
//! real render-core documents through it today, and `scene.rs` delegates its own leaf paint here so
//! the two never diverge. The specialisations still owned by `scene.rs` and deferred here are text,
//! drop shadows / layer blur, clip content, and modifier (gesture) transforms.
//!
//! ## The [`DrawEnv`] seam
//! The only thing paint resolution needs from the host is *which atlas id* an image or baked-diamond
//! reference maps to — a lookup that lives in render-vello's ABI globals and must not leak into this
//! backend-neutral crate. [`DrawEnv`] injects it: the hybrid backend supplies an env backed by its
//! ABI atlas map; the classic backend supplies one that returns `None` until image staging lands.

use render_core::blend::DEFAULT_BLEND;
use render_core::blur::radius_to_sigma;
use render_core::geometry::{cap_shadow_blur, outline};
use render_core::gradient::DIAMOND_TILE;
use render_core::kurbo::{Affine, Rect};
use render_core::model::{self as m, Brush, Node, Scene, ShapeKind};
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

/// Draw every root subtree in z-order under `view` (the page→device transform).
///
/// `text` carries the Parley engine so text nodes lay out on the way past; a document with no text
/// never touches it. This is the full neutral walk — isolation groups (opacity/blend), solid/gradient/
/// image/diamond fills, strokes, text blocks, and child clips — shared by both Vello backends. Still
/// outside it (drawn by `scene.rs`'s richer hybrid walk, not yet lifted): shadows, layer blur, filter
/// graphs, and the modifier (gesture) transforms.
pub fn draw_scene<C: RenderingContext, E: DrawEnv>(
    ctx: &mut C,
    resources: &mut C::Resources,
    env: &E,
    text: &mut crate::text::TextState,
    scene: &Scene,
    view: Affine,
) {
    for &root in scene.roots() {
        draw_node(ctx, resources, env, text, scene, root, view);
    }
}

fn draw_node<C: RenderingContext, E: DrawEnv>(
    ctx: &mut C,
    resources: &mut C::Resources,
    env: &E,
    text: &mut crate::text::TextState,
    scene: &Scene,
    id: u128,
    view: Affine,
) {
    let Some(node) = scene.get(id) else { return };
    if node.hidden || node.kind == ShapeKind::Unsupported {
        return;
    }
    let matrix = view * node.effective_transform();
    // Drop shadows sit behind everything this node draws (outside its opacity/blend layer), so they
    // go first, before the isolation layer.
    draw_box_drop_shadows(ctx, node, matrix);
    // A container with non-trivial opacity/blend isolates as a layer, so overlapping children compose
    // once and the group's opacity/blend applies to the whole subtree.
    let isolates = node.kind.is_container() && (node.opacity < 1.0 || node.blend != DEFAULT_BLEND);
    if isolates {
        let blend = (node.blend != DEFAULT_BLEND).then_some(node.blend);
        let alpha = (node.opacity < 1.0).then_some(node.opacity);
        ctx.push_layer(None, blend, alpha, None, None);
    }
    // The node's own body: text lays out through the shared text path; a group has no body; every
    // other kind fills/strokes its geometry.
    match node.kind {
        ShapeKind::Text => {
            crate::text::draw_text_block(
                ctx,
                resources,
                &mut text.font_cx,
                &mut text.layout_cx,
                env,
                node,
                matrix,
            );
        }
        ShapeKind::Group => {}
        _ => paint_body(ctx, env, node, matrix),
    }
    // A frame with `clip` set clips its children (not its own body — a frame's stroke straddles its
    // edge). The clip path is captured under this node's transform, matching render-wasm.
    let clip = (node.clip && !node.children.is_empty()).then(|| outline(node));
    if let Some(path) = &clip {
        ctx.set_transform(matrix);
        ctx.push_layer(Some(path), None, None, None, None);
    }
    for &child in &node.children {
        draw_node(ctx, resources, env, text, scene, child, view);
    }
    if clip.is_some() {
        ctx.pop_layer();
    }
    if isolates {
        ctx.pop_layer();
    }
}

/// Draw a node's non-inset drop shadows as blurred rounded rects, the box-shaped common case
/// (rect/frame/circle). Both backends have a `fill_blurred_rounded_rect` primitive — classic vello's
/// native blurred-rounded-rect and sparse-strips' own — so no filter layer is needed. Deferred to the
/// sink's `run_graph` path: path-shaped shadows (a blurred rect is the wrong silhouette) and inner
/// shadows (they darken *inside* the shape's own pixels). `matrix` is the node's page→device transform.
fn draw_box_drop_shadows<C: RenderingContext>(ctx: &mut C, node: &Node, matrix: Affine) {
    if node.shadows.is_empty() {
        return;
    }
    // The un-spread corner radius; a plain rect is 0, a circle is a full round (stadium for a
    // non-square box — an approximation until path shadows land).
    let base_radius = match node.kind {
        ShapeKind::Rect | ShapeKind::Frame => node.corners.map_or(0.0, |c| c.top_left),
        ShapeKind::Circle => node.bounds.width().min(node.bounds.height()) / 2.0,
        _ => return,
    };
    for shadow in node.shadows.iter().filter(|s| !s.inset) {
        // Cap the device blur (parity with render-wasm / the hybrid path); the offset shrinks by the
        // same factor past the cap so the shadow keeps its shape under zoom.
        let (sigma, offset_ratio) = cap_shadow_blur(radius_to_sigma(shadow.blur), matrix);
        let spread = f64::from(shadow.spread);
        let rect = node.bounds.inflate(spread, spread);
        let radius = (base_radius + spread).max(0.0) as f32;
        ctx.set_paint(shadow.color);
        ctx.set_paint_transform(Affine::IDENTITY);
        // Offset rides in the shape's own space, so it rotates with the shape and scales with zoom.
        ctx.set_transform(
            matrix
                * Affine::translate((shadow.offset.x * offset_ratio, shadow.offset.y * offset_ratio)),
        );
        ctx.fill_blurred_rounded_rect(&rect, radius, sigma);
    }
}

/// Paint a node's own geometry (fills then strokes), ignoring its children — the backend-neutral
/// twin of `scene.rs`'s `paint_self`. `matrix` is the fully-composed page→device→shape transform.
pub fn paint_body<C: RenderingContext, E: DrawEnv>(
    ctx: &mut C,
    env: &E,
    node: &Node,
    matrix: Affine,
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

    // The first fill this backend can paint wins — not simply the first fill, or a shape whose top
    // fill is an image would render as nothing while a solid underneath it went unused.
    let painted = node.fills.iter().any(|f| set_paint(ctx, env, f, node.bounds));
    if painted {
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
    if node.strokes.is_empty() {
        ctx.set_paint_transform(Affine::IDENTITY);
        return;
    }
    let path = outline(node);
    for stroke in &node.strokes {
        if !set_paint(ctx, env, &stroke.paint, node.bounds) {
            continue;
        }
        ctx.set_stroke(stroke.style.clone());
        ctx.stroke_path(&path);
    }

    // The paint transform is context state, not an argument: left set, the next shape's solid fill
    // would be drawn through this shape's gradient mapping.
    ctx.set_paint_transform(Affine::IDENTITY);
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
/// ellipse ratio, and an angular one's shear, all in unit-box space. `render_core::gradient` builds
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
