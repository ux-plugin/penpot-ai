use skia_safe::{self as skia, Color4f, RRect};

use super::{RenderState, ShapesPoolRef, SurfaceId};
use crate::render::grid_layout;
use crate::shapes::{Layout, Shape, Type};

/// Hover-chrome stroke, in CSS pixels — matched to the editor's other canvas
/// chrome. Widths are authored in screen pixels and divided by the viewbox zoom
/// so the outline keeps its weight as you zoom, then capped in world units so it
/// doesn't turn into a slab when zoomed far out.
const HIGHLIGHT_STROKE_PX: f32 = 1.5;
const HIGHLIGHT_STROKE_MAX: f32 = 4.0;
const HIGHLIGHT_DASH_PX: f32 = 5.0;
const HIGHLIGHT_DASH_MAX: f32 = 14.0;

/// Trace a dashed stroke over `shape`'s own outline — corner radii and transform
/// included, so it hugs a rounded or rotated shape rather than its bounding box.
/// Drawn on the UI surface, so it lands on top of the design without being part
/// of it.
fn render_highlight(canvas: &skia::Canvas, shape: &Shape, css_zoom: f32, color: u32) {
    let mut paint = skia::Paint::default();
    paint.set_style(skia::PaintStyle::Stroke);
    paint.set_color(skia::Color::new(color));
    paint.set_anti_alias(true);
    paint.set_stroke_width((HIGHLIGHT_STROKE_PX / css_zoom).min(HIGHLIGHT_STROKE_MAX));
    let dash = (HIGHLIGHT_DASH_PX / css_zoom).min(HIGHLIGHT_DASH_MAX);
    paint.set_path_effect(skia::PathEffect::dash(&[dash, dash], 0.0));

    canvas.save();
    // The same recentre-then-transform the shape renderer uses: `transform` is
    // authored about the shape's centre, so it has to be sandwiched between the
    // two translates or a rotated shape's outline lands somewhere else.
    let center = shape.center();
    let mut matrix = shape.transform;
    matrix.post_translate(center);
    matrix.pre_translate(-center);
    canvas.concat(&matrix);

    match shape.shape_type.corners() {
        Some(radii) => {
            canvas.draw_rrect(RRect::new_rect_radii(shape.selrect(), &radii), &paint);
        }
        None => {
            canvas.draw_rect(shape.selrect(), &paint);
        }
    }
    canvas.restore();
}

pub fn render(render_state: &mut RenderState, shapes: ShapesPoolRef) {
    let canvas = render_state.surfaces.canvas(SurfaceId::UI);

    canvas.clear(Color4f::new(0.0, 0.0, 0.0, 0.0));
    canvas.save();

    let viewbox = render_state.viewbox;
    let zoom = viewbox.zoom * render_state.options.dpr();

    canvas.scale((zoom, zoom));

    canvas.translate((-viewbox.area.left, -viewbox.area.top));

    let canvas = render_state.surfaces.canvas(SurfaceId::UI);

    let show_grid_id = render_state.show_grid;
    // Read before `canvas` is used below — `canvas` holds a mutable borrow of
    // `render_state`, so state fields have to be copied out up front.
    let highlight = render_state.shape_highlight;

    if let Some(id) = show_grid_id {
        if let Some(shape) = shapes.get(&id) {
            grid_layout::render_overlay(
                zoom,
                render_state.options.antialias_threshold,
                canvas,
                shape,
                shapes,
            );
        }
    }

    // Render overlays for empty grid frames
    for shape in shapes.iter() {
        if shape.id.is_nil() || !shape.children.is_empty() {
            continue;
        }

        if show_grid_id == Some(shape.id) {
            continue;
        }

        let Type::Frame(frame) = &shape.shape_type else {
            continue;
        };

        if !matches!(frame.layout, Some(Layout::GridLayout(_, _))) {
            continue;
        }

        if shape.deleted() {
            continue;
        }

        if let Some(shape) = shapes.get(&shape.id) {
            grid_layout::render_overlay(
                zoom,
                render_state.options.antialias_threshold,
                canvas,
                shape,
                shapes,
            );
        }
    }

    // Last, so the hover outline sits above the grid overlays too.
    if let Some((id, color)) = highlight {
        if let Some(shape) = shapes.get(&id) {
            if !shape.deleted() {
                render_highlight(canvas, shape, viewbox.zoom, color);
            }
        }
    }

    canvas.restore();
    render_state.surfaces.draw_into(
        SurfaceId::UI,
        SurfaceId::Target,
        Some(&skia::Paint::default()),
    );
}
