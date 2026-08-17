//! Classic vello's document walker — the z-order tree walk plus its native box-shadow constructions.
//!
//! The classic backend's counterpart to hybrid's `render-vello/src/scene.rs` `NeutralModelScene`
//! walk. It walks a [`render_core::model::Scene`] and draws it into a [`ClassicCtx`](crate::ClassicCtx)
//! (any [`RenderingContext`]), leaning on the *truly shared* leaf helpers in
//! [`render_core::vello::draw`] ([`paint_body`], `set_paint`, the [`DrawEnv`] seam) and
//! [`render_core::vello::text`] so the two backends' leaf paint never diverges.
//!
//! Everything here — the walk, isolation groups, clips, and the native box drop/inner-shadow
//! constructions — is classic's own; hybrid owns its equivalents in `scene.rs`. The two are
//! deliberately duplicated (each backend maps effects onto different primitives) and share only params
//! plus a golden pixel test, never an `if backend` branch in shared code.

use render_core::blend::DEFAULT_BLEND;
use render_core::blur::radius_to_sigma;
use render_core::geometry::{cap_shadow_blur, outline};
use render_core::host::Modifiers;
use render_core::kurbo::Affine;
use render_core::model::{Node, Scene, ShapeKind};
use render_core::peniko::{BlendMode, Color, Compose, Mix};
use render_core::schedule::PaintOp;
use render_core::vello::draw::{paint_body, DrawEnv};
use render_core::vello::text::{draw_text_block, TextState};
use vello_example_scenes::RenderingContext;

/// Draw every root subtree in z-order under `view` (the page→device transform) — the non-scheduled
/// whole-tree path (the scheduled one is [`draw_paint_batch`]).
///
/// `text` carries the Parley engine so text nodes lay out on the way past; a document with no text
/// never touches it. Isolation groups (opacity/blend), solid/gradient/image/diamond fills (via the
/// shared [`paint_body`]), strokes, text blocks, box drop/inner shadows, and child clips. Still
/// outside it: layer blur, filter graphs, and path-shaped shadows (the sink's effect surfaces).
///
/// The renderer drives the scheduled [`draw_paint_batch`] path; this whole-tree walk is exercised by
/// the crate's own neutral-completeness tests, hence the `not(test)` dead-code allowance.
#[cfg_attr(not(test), allow(dead_code))]
pub fn draw_scene<C: RenderingContext, E: DrawEnv>(
    ctx: &mut C,
    resources: &mut C::Resources,
    env: &E,
    text: &mut TextState,
    scene: &Scene,
    view: Affine,
) {
    for &root in scene.roots() {
        draw_node(ctx, resources, env, text, scene, root, view);
    }
}

/// Draw the root subtrees in the half-open z-index range `[start, end)` — the whole-viewport gather
/// phasing renders the content below a gather (`[prev, gather)`), then the gather's body-and-above
/// (`[gather, next)`) as separate passes so a backdrop-reading effect can run between them. Splitting
/// at top-level roots keeps every isolation layer whole (a root subtree is never cut).
#[cfg_attr(not(test), allow(dead_code))]
pub fn draw_scene_range<C: RenderingContext, E: DrawEnv>(
    ctx: &mut C,
    resources: &mut C::Resources,
    env: &E,
    text: &mut TextState,
    scene: &Scene,
    view: Affine,
    start: usize,
    end: usize,
) {
    let roots = scene.roots();
    let end = end.min(roots.len());
    for &root in &roots[start.min(end)..end] {
        draw_node(ctx, resources, env, text, scene, root, view);
    }
}

#[cfg_attr(not(test), allow(dead_code))]
fn draw_node<C: RenderingContext, E: DrawEnv>(
    ctx: &mut C,
    resources: &mut C::Resources,
    env: &E,
    text: &mut TextState,
    scene: &Scene,
    id: u128,
    view: Affine,
) {
    let Some(node) = scene.get(id) else { return };
    if node.hidden || node.kind == ShapeKind::Unsupported {
        return;
    }
    let matrix = view * node.effective_transform();
    // A container with non-trivial opacity/blend isolates as a layer, so overlapping children compose
    // once and the group's opacity/blend applies to the whole subtree. Drop shadows sit behind
    // everything this node draws (outside its opacity/blend layer), so `draw_node_body` (which draws
    // them first) runs before the isolation layer is pushed.
    let isolates = node.kind.is_container() && (node.opacity < 1.0 || node.blend != DEFAULT_BLEND);
    draw_box_drop_shadows(ctx, node, matrix);
    if isolates {
        let blend = (node.blend != DEFAULT_BLEND).then_some(node.blend);
        let alpha = (node.opacity < 1.0).then_some(node.opacity);
        ctx.push_layer(None, blend, alpha, None, None);
    }
    // Whole-scene walk: a leaf's opacity/blend is applied inline (containers are isolated above).
    draw_node_kind_body(ctx, resources, env, text, node, matrix, true);
    draw_box_inner_shadows(ctx, node, matrix);
    // A masked group's first child is a mask clipping the rest to its alpha (a soft `DstIn` mask, not
    // a silhouette clip). The content must be isolated so the `DstIn` only touches the group's own
    // pixels — reuse the opacity/blend isolation layer when there is one, else push a plain one.
    let mask_id = (node.kind == ShapeKind::Group && node.masked && node.children.len() >= 2)
        .then(|| node.children[0]);
    let mask_layer = mask_id.is_some() && !isolates;
    if mask_layer {
        ctx.push_layer(None, None, None, None, None);
    }
    // A frame with `clip` set clips its children (not its own body — a frame's stroke straddles its
    // edge). The clip path is captured under this node's transform, matching render-wasm.
    let clip = (node.clip && !node.children.is_empty()).then(|| outline(node));
    if let Some(path) = &clip {
        ctx.set_transform(matrix);
        ctx.push_layer(Some(path), None, None, None, None);
    }
    for (i, &child) in node.children.iter().enumerate() {
        // The mask child is not drawn as content; it is drawn into the `DstIn` layer below.
        if mask_id.is_some() && i == 0 {
            continue;
        }
        draw_node(ctx, resources, env, text, scene, child, view);
    }
    // Mask pass: the mask child, drawn in a `DstIn` layer, multiplies the content's alpha — content
    // survives only where the mask has alpha. The same construction the scheduler emits as
    // `PushMaskLayer`/`Body`/`PopLayer`.
    if let Some(mid) = mask_id {
        if let Some(mask) = scene.get(mid) {
            let mask_matrix = view * mask.effective_transform();
            let dst_in = BlendMode::new(Mix::Normal, Compose::DestIn);
            ctx.push_layer(None, Some(dst_in), None, None, None);
            draw_node_body(ctx, resources, env, text, mask, mask_matrix);
            ctx.pop_layer();
        }
    }
    if clip.is_some() {
        ctx.pop_layer();
    }
    if mask_layer {
        ctx.pop_layer();
    }
    if isolates {
        ctx.pop_layer();
    }
}

/// The node's own body — text lays out through the shared text path; a group has no body; every other
/// kind fills/strokes its geometry. No shadows, isolation, clip or children: just this node's mark.
fn draw_node_kind_body<C: RenderingContext, E: DrawEnv>(
    ctx: &mut C,
    resources: &mut C::Resources,
    env: &E,
    text: &mut TextState,
    node: &Node,
    matrix: Affine,
    // Whole-scene walk applies a leaf's opacity/blend inline (`true`); the sink defers it to the
    // `Composite` step and paints the body raw (`false`). See `draw::paint_body`.
    group_inline: bool,
) {
    match node.kind {
        ShapeKind::Text => {
            draw_text_block(ctx, resources, &mut text.font_cx, &mut text.layout_cx, env, node, matrix);
        }
        ShapeKind::Svg => {
            if let Some(content) = &node.svg {
                render_core::vello::svg::render_svg(ctx, content, node.bounds, matrix);
            }
        }
        ShapeKind::Group => {}
        _ => paint_body(ctx, env, node, matrix, group_inline),
    }
}

/// One shape's full self-mark for a scheduler `Paint` step: its box drop shadows, its body, then its
/// box inner shadows — but **not** its children, isolation layer or clip (the schedule emits those as
/// their own steps / `PushLayer`/`PopLayer` ops). Classic's per-`Body(id)` unit, the counterpart of
/// `scene.rs`'s `paint_node_body`. Box drop/inner shadows draw inline via the native
/// blurred-rounded-rect (the isolated `RasterEffectOutput` surface makes the inner shadow's silhouette
/// whole); the remaining spread effects — layer blur, filter graphs, path-shaped shadows — are still
/// the sink's job via its effect surfaces and are absent here.
pub fn draw_node_body<C: RenderingContext, E: DrawEnv>(
    ctx: &mut C,
    resources: &mut C::Resources,
    env: &E,
    text: &mut TextState,
    node: &Node,
    matrix: Affine,
) {
    if node.hidden || node.kind == ShapeKind::Unsupported {
        return;
    }
    draw_box_drop_shadows(ctx, node, matrix);
    // Sink per-`Body(id)`: opacity/blend is applied by the scheduler's `Composite` step, so paint raw.
    draw_node_kind_body(ctx, resources, env, text, node, matrix, false);
    draw_box_inner_shadows(ctx, node, matrix);
}

/// Draw one scheduler `Paint` step — a z-ordered run of [`PaintOp`]s — into `ctx`. `Body(id)` draws
/// that node's self-mark ([`draw_node_body`]) at `view · modifier · node.transform`; `PushLayer`/
/// `PopLayer` bracket a group's opacity/blend isolation. This is what classic's `RasterBackend::
/// build_bodies` runs; the whole-tree [`draw_scene`] is the non-scheduled path.
pub fn draw_paint_batch<C: RenderingContext, E: DrawEnv>(
    ctx: &mut C,
    resources: &mut C::Resources,
    env: &E,
    text: &mut TextState,
    model: &Scene,
    view: Affine,
    modifiers: &Modifiers,
    ops: &[PaintOp],
) {
    for op in ops {
        match *op {
            PaintOp::Body(id) => {
                if let Some(node) = model.get(id) {
                    let modifier = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
                    let matrix = view * modifier * node.effective_transform();
                    draw_node_body(ctx, resources, env, text, node, matrix);
                }
            }
            PaintOp::PushLayer(id) => {
                if let Some(node) = model.get(id) {
                    let alpha = (node.opacity < 1.0).then_some(node.opacity);
                    let blend = (node.blend != DEFAULT_BLEND).then_some(node.blend);
                    ctx.push_layer(None, blend, alpha, None, None);
                }
            }
            // A masked group's `DstIn` sub-layer: the next `Body` (the mask) composites onto the
            // content already in the enclosing isolation layer with `DstIn`, so the content survives
            // only where the mask has alpha — a real (soft) alpha mask, not a silhouette clip.
            PaintOp::PushMaskLayer => {
                let dst_in = BlendMode::new(Mix::Normal, Compose::DestIn);
                ctx.push_layer(None, Some(dst_in), None, None, None);
            }
            PaintOp::PopLayer => ctx.pop_layer(),
        }
    }
}

/// Draw a node's non-inset drop shadows as blurred rounded rects, the box-shaped common case
/// (rect/frame/circle). Classic vello's native blurred-rounded-rect, so no filter layer is needed.
/// Deferred: path-shaped shadows (a blurred rect is the wrong silhouette). `matrix` is the node's
/// page→device transform.
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

/// Draw a node's inset (inner) shadows for the box-shaped common case (rect/frame/circle) via the
/// native blurred-rounded-rect primitive — classic's analogue of the hybrid fork's `InnerShadow`
/// filter. Mirrors render-wasm's Skia construction (`drop_shadow_only` → colour `SrcOut` → `SrcIn`
/// shape): inside a layer clipped to the shape (the `SrcIn`), flood it with the shadow colour, then
/// punch out the shape's silhouette shifted by the offset and blurred (`DestOut`) — leaving colour
/// only on the offset side, which is the inner band.
///
/// Path/text inner shadows are deferred (a blurred rrect is the wrong silhouette), exactly like path
/// drop shadows, and spread is ignored (parity with render-wasm and the hybrid fork). `matrix` is the
/// node's page→device transform.
fn draw_box_inner_shadows<C: RenderingContext>(ctx: &mut C, node: &Node, matrix: Affine) {
    if !node.shadows.iter().any(|s| s.inset) {
        return;
    }
    let base_radius = match node.kind {
        ShapeKind::Rect | ShapeKind::Frame => node.corners.map_or(0.0, |c| c.top_left),
        ShapeKind::Circle => node.bounds.width().min(node.bounds.height()) / 2.0,
        _ => return,
    };
    let shape = outline(node);
    // `DestOut` reads only the punch's alpha, so an opaque colour fully clears the shifted silhouette.
    let opaque = Color::WHITE;
    let dest_out = BlendMode::new(Mix::Normal, Compose::DestOut);
    for shadow in node.shadows.iter().filter(|s| s.inset) {
        // Cap the device blur like the drop shadow; the offset shrinks by the same factor past the cap
        // so the band keeps its shape under zoom.
        let (sigma, offset_ratio) = cap_shadow_blur(radius_to_sigma(shadow.blur), matrix);

        // `SrcIn` to the shape: everything below composites over the body, clipped to the silhouette.
        ctx.set_paint_transform(Affine::IDENTITY);
        ctx.set_transform(matrix);
        ctx.push_layer(Some(&shape), None, None, None, None);

        // The shadow colour, flooding the whole shape …
        ctx.set_paint(shadow.color);
        ctx.set_transform(matrix);
        ctx.fill_path(&shape);

        // … minus the shape's silhouette shifted by the offset and blurred: the remainder is the band.
        ctx.push_layer(None, Some(dest_out), None, None, None);
        ctx.set_paint(opaque);
        ctx.set_transform(
            matrix * Affine::translate((shadow.offset.x * offset_ratio, shadow.offset.y * offset_ratio)),
        );
        ctx.fill_blurred_rounded_rect(&node.bounds, base_radius as f32, sigma);
        ctx.pop_layer();

        ctx.pop_layer();
    }
    ctx.set_paint_transform(Affine::IDENTITY);
}
