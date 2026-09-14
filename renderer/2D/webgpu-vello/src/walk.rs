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
use render_core::vello::text::TextState;
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
    modifiers: &Modifiers,
) {
    for &root in scene.roots() {
        draw_node(ctx, resources, env, text, scene, root, view, modifiers);
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
    modifiers: &Modifiers,
) {
    let roots = scene.roots();
    let end = end.min(roots.len());
    for &root in &roots[start.min(end)..end] {
        draw_node(ctx, resources, env, text, scene, root, view, modifiers);
    }
}

/// Per-shape encoded body fragments: a leaf node's whole self-mark (box drop shadows, body, box
/// inner shadows) encoded once at IDENTITY into its own scene, keyed by the model's content
/// revision. The frame walk splices a hit with [`vello::Scene::append`] under the node's full
/// matrix — the append re-bases every transform entry, and a fragment's entries are the same
/// affines a direct draw would have produced composed with IDENTITY, so the spliced stream is the
/// stream the walk would have encoded. Paint transforms are bounds-derived (never matrix-derived)
/// and `push_layer(None)` clips to a space-independent huge rect, so a fragment is a pure function
/// of node content. Only view/modifier motion never invalidates: pan, zoom and drags splice.
#[derive(Default)]
pub struct BodyCache {
    map: std::collections::HashMap<u128, (u64, vello::Scene)>,
    pub hits: u64,
    pub misses: u64,
}

impl BodyCache {
    /// Drop every fragment. Called when a shared registry a fragment can bake from advances —
    /// a new font face (re-shapes existing text) or a newly uploaded image/diamond bake — since
    /// those change rendering without any node revision bump.
    pub fn clear(&mut self) {
        self.map.clear();
    }
}

/// Draw shape `id` and its subtree with fragment splicing for leaf bodies — the whole-viewport
/// walk's unit of work. A leaf body is encoded once per scene revision into a cached fragment and
/// appended under its matrix on every frame; containers are walked live so their clip, mask and
/// isolation brackets surround the children exactly as [`draw_scene`] does.
pub fn draw_shape_cached<E: DrawEnv>(
    ctx: &mut crate::ClassicCtx,
    env: &E,
    text: &mut TextState,
    scene: &Scene,
    id: u128,
    view: Affine,
    modifiers: &Modifiers,
    cache: &mut BodyCache,
) {
    let Some(node) = scene.get(id) else { return };
    if node.hidden || node.kind == ShapeKind::Unsupported {
        return;
    }
    let modifier = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
    let matrix = view * modifier * node.effective_transform();
    if node.children.is_empty() && !node.kind.is_container() {
        let rev = scene.rev(id);
        if cache.map.get(&id).is_none_or(|&(r, _)| r != rev) {
            cache.misses += 1;
            let mut fctx = crate::ClassicCtx::new(1, 1);
            let mut resources = ();
            draw_box_drop_shadows(&mut fctx, node, Affine::IDENTITY);
            draw_node_kind_body(&mut fctx, &mut resources, env, text, node, Affine::IDENTITY, true);
            draw_box_inner_shadows(&mut fctx, node, Affine::IDENTITY);
            cache.map.insert(id, (rev, fctx.into_fragment()));
        } else {
            cache.hits += 1;
        }
        let (_, frag) = &cache.map[&id];
        ctx.append_fragment(frag, matrix);
        return;
    }
    let mut resources = ();
    let isolates = node.kind.is_container() && (node.opacity < 1.0 || node.blend != DEFAULT_BLEND);
    draw_box_drop_shadows(ctx, node, matrix);
    if isolates {
        let blend = (node.blend != DEFAULT_BLEND).then_some(node.blend);
        let alpha = (node.opacity < 1.0).then_some(node.opacity);
        ctx.push_layer(None, blend, alpha, None, None);
    }
    draw_node_kind_body(ctx, &mut resources, env, text, node, matrix, true);
    draw_box_inner_shadows(ctx, node, matrix);
    let mask_id = (node.kind == ShapeKind::Group && node.masked && node.children.len() >= 2)
        .then(|| node.children[0]);
    let mask_layer = mask_id.is_some() && !isolates;
    if mask_layer {
        ctx.push_layer(None, None, None, None, None);
    }
    let clip = (node.clip && !node.children.is_empty()).then(|| outline(node));
    if let Some(path) = &clip {
        ctx.set_transform(matrix);
        ctx.push_clip_layer(path);
    }
    for (i, &child) in node.children.iter().enumerate() {
        if mask_id.is_some() && i == 0 {
            continue;
        }
        draw_shape_cached(ctx, env, text, scene, child, view, modifiers, cache);
    }
    if let Some(mid) = mask_id {
        if let Some(mask) = scene.get(mid) {
            let mask_modifier = modifiers.get(&mid).copied().unwrap_or(Affine::IDENTITY);
            let mask_matrix = view * mask_modifier * mask.effective_transform();
            let dst_in = BlendMode::new(Mix::Normal, Compose::DestIn);
            ctx.push_layer(None, Some(dst_in), None, None, None);
            draw_node_body(ctx, &mut resources, env, text, mask, mask_matrix);
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

#[cfg_attr(not(test), allow(dead_code))]
fn draw_node<C: RenderingContext, E: DrawEnv>(
    ctx: &mut C,
    resources: &mut C::Resources,
    env: &E,
    text: &mut TextState,
    scene: &Scene,
    id: u128,
    view: Affine,
    modifiers: &Modifiers,
) {
    let Some(node) = scene.get(id) else { return };
    if node.hidden || node.kind == ShapeKind::Unsupported {
        return;
    }
    let modifier = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
    let matrix = view * modifier * node.effective_transform();
    let isolates = node.kind.is_container() && (node.opacity < 1.0 || node.blend != DEFAULT_BLEND);
    draw_box_drop_shadows(ctx, node, matrix);
    if isolates {
        let blend = (node.blend != DEFAULT_BLEND).then_some(node.blend);
        let alpha = (node.opacity < 1.0).then_some(node.opacity);
        ctx.push_layer(None, blend, alpha, None, None);
    }
    draw_node_kind_body(ctx, resources, env, text, node, matrix, true);
    draw_box_inner_shadows(ctx, node, matrix);
    let mask_id = (node.kind == ShapeKind::Group && node.masked && node.children.len() >= 2)
        .then(|| node.children[0]);
    let mask_layer = mask_id.is_some() && !isolates;
    if mask_layer {
        ctx.push_layer(None, None, None, None, None);
    }
    let clip = (node.clip && !node.children.is_empty()).then(|| outline(node));
    if let Some(path) = &clip {
        ctx.set_transform(matrix);
        ctx.push_clip_layer(path);
    }
    for (i, &child) in node.children.iter().enumerate() {
        if mask_id.is_some() && i == 0 {
            continue;
        }
        draw_node(ctx, resources, env, text, scene, child, view, modifiers);
    }
    if let Some(mid) = mask_id {
        if let Some(mask) = scene.get(mid) {
            let mask_modifier = modifiers.get(&mid).copied().unwrap_or(Affine::IDENTITY);
            let mask_matrix = view * mask_modifier * mask.effective_transform();
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
    group_inline: bool,
) {
    match node.kind {
        ShapeKind::Text => {
            render_core::vello::text::draw_text_node(ctx, resources, text, env, node, matrix);
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
    let base_radius = match node.kind {
        ShapeKind::Rect | ShapeKind::Frame => node.corners.map_or(0.0, |c| c.top_left),
        ShapeKind::Circle => node.bounds.width().min(node.bounds.height()) / 2.0,
        _ => return,
    };
    for shadow in node.shadows.iter().filter(|s| !s.inset) {
        let (sigma, offset_ratio) = cap_shadow_blur(radius_to_sigma(shadow.blur), matrix);
        let spread = f64::from(shadow.spread);
        let rect = node.bounds.inflate(spread, spread);
        let radius = (base_radius + spread).max(0.0) as f32;
        ctx.set_paint(shadow.color);
        ctx.set_paint_transform(Affine::IDENTITY);
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
    let opaque = Color::WHITE;
    let dest_out = BlendMode::new(Mix::Normal, Compose::DestOut);
    for shadow in node.shadows.iter().filter(|s| s.inset) {
        let (sigma, offset_ratio) = cap_shadow_blur(radius_to_sigma(shadow.blur), matrix);

        ctx.set_paint_transform(Affine::IDENTITY);
        ctx.set_transform(matrix);
        ctx.push_layer(Some(&shape), None, None, None, None);

        ctx.set_paint(shadow.color);
        ctx.set_transform(matrix);
        ctx.fill_path(&shape);

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
