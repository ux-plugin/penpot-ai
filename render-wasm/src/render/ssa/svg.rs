//! SSA-native SVG renderer. Port of `render::v2::render_svg_into_target`.
//!
//! Draws `shape.svg` (a `skia::svg::Dom`) into `ctx.surface` under
//! the tile+shape (+optional `svg_transform`) matrix. Falls back to
//! parsing `sr.content` against the font provider if the prebuilt DOM
//! is absent.

use skia_safe::{self as skia};

use crate::error::Result;
use crate::shapes::{Shape, Type};

use super::PaintCtx;

pub fn render(ctx: &mut PaintCtx<'_>, shape: &Shape) -> Result<()> {
    let Type::SVGRaw(sr) = &shape.shape_type else {
        return Ok(());
    };

    // Build the full canvas matrix: scale * translate * shape.transform
    // (pivoted) * svg_transform (if any).
    let mut matrix = ctx.tile_and_shape_transform_matrix(shape);
    if let Some(svg_xf) = shape.svg_transform() {
        matrix.pre_concat(&svg_xf);
    }

    // The SVG renderer needs a font manager when the prebuilt DOM
    // isn't available — pull it from the font provider before the
    // canvas borrow.
    let font_manager_opt = if shape.svg.is_none() {
        Some(skia::FontMgr::from(ctx.fonts.font_provider().clone()))
    } else {
        None
    };

    let canvas = ctx.surface.canvas();
    canvas.save();
    canvas.reset_matrix();
    canvas.concat(&matrix);

    if let Some(svg) = shape.svg.as_ref() {
        svg.render(canvas);
    } else if let Some(font_manager) = font_manager_opt {
        match skia::svg::Dom::from_str(&sr.content, font_manager) {
            Ok(dom) => dom.render(canvas),
            Err(e) => {
                let _ = e;
                // Silently ignore parse errors — matches legacy
                // `eprintln` behavior in wasm where stderr is hidden.
            }
        }
    }

    canvas.restore();
    Ok(())
}
