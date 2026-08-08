//! The neutral document drawer — walks a `render_core::model::Scene` in z-order and draws it into
//! any `RenderingContext`.
//!
//! This is slice 1 of unifying the draw path across Vello backends: today render-vello's `scene.rs`
//! owns the full translation (all paint kinds, strokes, text, shadows, blur, clips) but is woven into
//! that crate's ABI globals; this is the backend-neutral *core* of it — solid-fill bodies for
//! rect/frame/circle plus isolation groups (opacity/blend → push/pop layer). It lets the classic
//! backend render real render-core documents *now*, and `scene.rs` will be refactored to delegate
//! here and add the specializations this slice defers (gradient/image/diamond paint, strokes, text,
//! shadows/blur, clip content).

use render_core::blend::DEFAULT_BLEND;
use render_core::kurbo::{Affine, Ellipse, Shape};
use render_core::model::{Brush, Node, Scene, ShapeKind};
use vello_example_scenes::{Fill, RenderingContext};

/// Draw every root subtree in z-order under `view` (the page→device transform).
pub fn draw_scene<C: RenderingContext>(ctx: &mut C, scene: &Scene, view: Affine) {
    for &root in scene.roots() {
        draw_node(ctx, scene, root, view);
    }
}

fn draw_node<C: RenderingContext>(ctx: &mut C, scene: &Scene, id: u128, view: Affine) {
    let Some(node) = scene.get(id) else { return };
    if node.hidden || node.kind == ShapeKind::Unsupported {
        return;
    }
    // A container with non-trivial opacity/blend isolates as a layer, so overlapping children compose
    // once and the group's opacity/blend applies to the whole subtree.
    let isolates = node.kind.is_container() && (node.opacity < 1.0 || node.blend != DEFAULT_BLEND);
    if isolates {
        let blend = (node.blend != DEFAULT_BLEND).then_some(node.blend);
        let alpha = (node.opacity < 1.0).then_some(node.opacity);
        ctx.push_layer(None, blend, alpha, None, None);
    }
    // A group has no body of its own; every other kind draws its fill.
    if node.kind != ShapeKind::Group {
        paint_body(ctx, node, view);
    }
    for &child in &node.children {
        draw_node(ctx, scene, child, view);
    }
    if isolates {
        ctx.pop_layer();
    }
}

/// Draw one node's solid-fill body. Non-solid paints (gradient/image/diamond) and non-fill content
/// (strokes/text/effects) are deferred — the specializations `scene.rs` will keep until this drawer
/// grows them.
fn paint_body<C: RenderingContext>(ctx: &mut C, node: &Node, view: Affine) {
    let Some(paint) = node.fills.first() else { return };
    let Brush::Solid(color) = &paint.brush else { return };
    ctx.set_fill_rule(Fill::NonZero);
    ctx.set_transform(view * node.effective_transform());
    ctx.set_paint(render_core::peniko::Brush::Solid(*color));
    if node.kind == ShapeKind::Circle {
        let b = node.bounds;
        let ellipse = Ellipse::new(b.center(), (b.width() / 2.0, b.height() / 2.0), 0.0);
        ctx.fill_path(&ellipse.to_path(0.1));
    } else {
        ctx.fill_rect(&node.bounds);
    }
}
