//! Raw-SVG shapes (`ShapeKind::Svg`), drawn through the shared [`RenderingContext`] so **both** vello
//! backends render them identically — the neutral counterpart of render-wasm's Skia SVG DOM.
//!
//! The markup is parsed with `usvg` (the same parser the vello fork's `vello_toy` uses) and its tree
//! is walked into `RenderingContext` calls: groups carry a transform + optional clip, paths carry a
//! fill and/or a stroke. The SVG's own viewBox is mapped into the node's `bounds`, then the node's
//! page→device `matrix` is applied on top, so an SVG scales and rotates with its shape.
//!
//! **Scope (first slice):** solid-colour fills/strokes, nested groups, transforms, clip paths, fill
//! rule and paint order — which covers the vast majority of imported icon SVGs. Deferred, matching
//! the fork's toy walker: SVG gradients, `<image>`, `<text>` (usvg is built without fontdb here), and
//! SVG filter effects.

use crate::kurbo::{Affine, BezPath, Rect, Stroke};
use crate::peniko::Color;
use usvg::tiny_skia_path::PathSegment;
use usvg::{Node, Paint, PaintOrder};
use vello_example_scenes::{Fill, RenderingContext};

/// Parse `content` and draw it into `ctx`, scaled from the SVG's viewBox into `bounds` and placed by
/// the node's `matrix` (page→device). A parse error or an empty document draws nothing.
pub fn render_svg<C: RenderingContext>(ctx: &mut C, content: &str, bounds: Rect, matrix: Affine) {
    let Ok(tree) = usvg::Tree::from_str(content, &usvg::Options::default()) else {
        return;
    };
    let size = tree.size();
    let (sw, sh) = (f64::from(size.width()), f64::from(size.height()));
    if sw <= 0.0 || sh <= 0.0 {
        return;
    }
    let base = matrix
        * Affine::translate((bounds.x0, bounds.y0))
        * Affine::scale_non_uniform(bounds.width() / sw, bounds.height() / sh);

    let mut stack = vec![base];
    render_group(ctx, &mut stack, tree.root());
}

fn render_group<C: RenderingContext>(ctx: &mut C, stack: &mut Vec<Affine>, group: &usvg::Group) {
    let current = *stack.last().unwrap();
    let clip = group.clip_path().map(|p| {
        let mut path = BezPath::new();
        extract_clip_path(p.root(), &mut path);
        current * convert_transform(&p.transform()) * (convert_group_transform(group) * path)
    });
    if let Some(c) = &clip {
        ctx.push_layer(Some(c), None, None, None, None);
    }

    stack.push(current * convert_transform(&group.transform()));
    for child in group.children() {
        match child {
            Node::Group(g) => render_group(ctx, stack, g),
            Node::Path(p) => render_path(ctx, stack, p),
            Node::Image(_) | Node::Text(_) => {}
        }
    }
    stack.pop();

    if clip.is_some() {
        ctx.pop_layer();
    }
}

fn render_path<C: RenderingContext>(ctx: &mut C, stack: &mut Vec<Affine>, path: &usvg::Path) {
    if !path.is_visible() {
        return;
    }
    ctx.set_transform(*stack.last().unwrap());
    ctx.set_paint_transform(Affine::IDENTITY);

    let do_fill = |ctx: &mut C| {
        if let Some(fill) = path.fill() {
            let Paint::Color(c) = fill.paint() else { return };
            ctx.set_fill_rule(convert_fill_rule(fill.rule()));
            ctx.set_paint(Color::from_rgba8(c.red, c.green, c.blue, fill.opacity().to_u8()));
            ctx.fill_path(&convert_path_data(path));
        }
    };
    let do_stroke = |ctx: &mut C| {
        if let Some(stroke) = path.stroke() {
            let Paint::Color(c) = stroke.paint() else { return };
            ctx.set_stroke(Stroke::new(f64::from(stroke.width().get())));
            ctx.set_paint(Color::from_rgba8(c.red, c.green, c.blue, stroke.opacity().to_u8()));
            ctx.stroke_path(&convert_path_data(path));
        }
    };
    if path.paint_order() == PaintOrder::FillAndStroke {
        do_fill(ctx);
        do_stroke(ctx);
    } else {
        do_stroke(ctx);
        do_fill(ctx);
    }
}

/// Flatten a clip-path subtree into one path (crude: no nested-clip / fill-rule handling, matching the
/// fork's toy renderer — enough for the common single-contour icon clip).
fn extract_clip_path(group: &usvg::Group, path: &mut BezPath) {
    for child in group.children() {
        match child {
            Node::Group(g) => extract_clip_path(g, path),
            Node::Path(p) => path.extend(convert_path_data(p)),
            Node::Image(_) | Node::Text(_) => {}
        }
    }
}

fn convert_group_transform(group: &usvg::Group) -> Affine {
    convert_transform(&group.transform())
}

fn convert_fill_rule(rule: usvg::FillRule) -> Fill {
    match rule {
        usvg::FillRule::NonZero => Fill::NonZero,
        usvg::FillRule::EvenOdd => Fill::EvenOdd,
    }
}

fn convert_transform(t: &usvg::Transform) -> Affine {
    Affine::new([
        f64::from(t.sx),
        f64::from(t.ky),
        f64::from(t.kx),
        f64::from(t.sy),
        f64::from(t.tx),
        f64::from(t.ty),
    ])
}

fn convert_path_data(path: &usvg::Path) -> BezPath {
    let mut bez = BezPath::new();
    for seg in path.data().segments() {
        match seg {
            PathSegment::MoveTo(p) => bez.move_to((f64::from(p.x), f64::from(p.y))),
            PathSegment::LineTo(p) => bez.line_to((f64::from(p.x), f64::from(p.y))),
            PathSegment::QuadTo(p1, p2) => {
                bez.quad_to((f64::from(p1.x), f64::from(p1.y)), (f64::from(p2.x), f64::from(p2.y)));
            }
            PathSegment::CubicTo(p1, p2, p3) => bez.curve_to(
                (f64::from(p1.x), f64::from(p1.y)),
                (f64::from(p2.x), f64::from(p2.y)),
                (f64::from(p3.x), f64::from(p3.y)),
            ),
            PathSegment::Close => bez.close_path(),
        }
    }
    bez
}
