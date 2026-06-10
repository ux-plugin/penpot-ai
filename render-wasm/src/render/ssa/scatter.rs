//! SSA-native scatter (texture displacement) effect.
//!
//! Renders the shape's body wrapped in a Skia `save_layer` whose paint
//! carries the displacement `image_filter` produced by
//! `render::texture::build_displacement_filter`. Skia applies the
//! filter when the layer is closed: the body content drawn inside the
//! layer gets warped by the Perlin-noise displacement before
//! compositing onto the destination.
//!
//! **Coord convention.** We use the *per-tile* coord frame — the
//! displacement filter is built with `extrect = ctx.world_clip` (the
//! current tile's world rect) and `margins = ctx.margins` (standard
//! per-tile margins). The shape-anchored noise (`NOISE_SHAPE_LOCAL_SKSL`)
//! resolves to world-stable values regardless of which tile renders it,
//! so adjacent tiles' displaced bodies seam together correctly.
//!
//! **Layer bounds.** We pass the shape's *extrect* (selrect + effect
//! outset) as the `save_layer.bounds` so the displacement layer is
//! sized to that region only. Without explicit bounds, Skia uses the
//! current clip — which is the full tile surface — and the displacement
//! filter would noise-warp pixels across the *entire tile* (eating
//! into neighboring shapes' content). The bounded layer constrains the
//! warp to a per-shape region.
//!
//! **Compositing.** Layer closes with default `SrcOver` — transparent
//! layer pixels let underlying canvas content through, opaque ones
//! over-paint it. Anything the gather phase already deposited on this
//! tile (glass refraction, prior NonGather bodies) shows through where
//! the displaced body doesn't cover.
//!
//! **Coverage.** Implemented:
//!   - Leaf shapes (Rect / Circle / Path / Frame without recursive
//!     children)
//! TODO:
//!   - Combine displacement with glass refraction — legacy warps glass
//!     + body together in the displacement scratch. SSA's split
//!     pipeline (PaintGather to TileOutput, then Blit on top) leaves
//!     glass un-warped beneath the displaced body. Would require a
//!     scratch surface owned by the Blit to render glass+body into
//!     before displacement.
//!   - Recursive frame/group scatter — children inherit the parent's
//!     save_layer in legacy; SSA's per-shape Paint steps don't pass
//!     layer state across shapes.

use skia_safe as skia;

use crate::error::Result;
use crate::shapes::{Shape, Type};

use super::PaintCtx;

pub fn render_blit(ctx: &mut PaintCtx<'_>, shape: &Shape) -> Result<()> {
    let Some(texture) = shape
        .texture
        .as_ref()
        .filter(|t| !t.hidden && t.radius > 0.0)
    else {
        return Ok(());
    };

    // Build the displacement filter in per-tile coord space.
    let disp_filter = match crate::render::texture::build_displacement_filter(
        texture,
        shape,
        ctx.world_clip,
        ctx.scale,
        ctx.margins,
    ) {
        Some(f) => f,
        None => return Ok(()),
    };

    // Compute the device-pixel bounds rect for `save_layer`. The shape's
    // extrect (selrect + every effect's outset, including the
    // displacement's own) is what we want — the layer fits the
    // warped silhouette but no more, and crucially DOESN'T extend
    // across the rest of the tile. World→device for the current tile:
    //   dev = (world - world_clip.origin) * scale + margin
    let extrect_world = shape.extrect(ctx.tree, ctx.scale);
    let scale = ctx.scale;
    let margin_w = ctx.margins.width as f32;
    let margin_h = ctx.margins.height as f32;
    let bounds_dev = skia::Rect::from_ltrb(
        (extrect_world.left - ctx.world_clip.left) * scale + margin_w,
        (extrect_world.top - ctx.world_clip.top) * scale + margin_h,
        (extrect_world.right - ctx.world_clip.left) * scale + margin_w,
        (extrect_world.bottom - ctx.world_clip.top) * scale + margin_h,
    );

    // Open the displacement save_layer at identity CTM with the
    // computed bounds. Inside, the body renderers below set their own
    // per-tile CTM and write to `ctx.surface.canvas()` — which is the
    // active save_layer.
    {
        let canvas = ctx.surface.canvas();
        canvas.save();
        canvas.reset_matrix();
        let mut layer_paint = skia::Paint::default();
        layer_paint.set_image_filter(disp_filter);
        let rec = skia::canvas::SaveLayerRec::default()
            .paint(&layer_paint)
            .bounds(&bounds_dev);
        canvas.save_layer(&rec);
    }

    // Render body INSIDE the layer. Text needs glyphs drawn FLAT (no
    // isolating save_layer) so the displacement filter's implicit source
    // captures them — `ssa::text::render` wraps glyphs in nested
    // save_layers the filter can't see through, making text vanish at
    // any radius. The generic fills/strokes pass below draws the shape
    // path (empty for text), so it can't be used either.
    let body_result = if matches!(shape.shape_type, Type::Text(_)) {
        super::text::render_glyphs_flat(ctx, shape);
        Ok(())
    } else {
        // Mirrors `render::texture::render_and_filter_to_image`'s leaf
        // closure. Inner shadows are out of scope here; they fire as a
        // separate body effect via the dispatcher's `ShapeBody` arm
        // (not currently in the scatter body plan, but available if we
        // extend `paint_plan_for_shape_ssa`).
        let antialias =
            shape.should_use_antialias(ctx.scale, ctx.options.antialias_threshold);

        let fills_vec: Vec<_> = shape.fills.iter().cloned().collect();
        let fill_result = super::fills::render(ctx, shape, &fills_vec, antialias, None);

        // Shape's own noise overlay (`shape.shape_noise`) — separate from
        // the texture's internal displacement noise. Lands inside the
        // displacement layer so it gets warped along with the body.
        super::noise::render_shape_noise(ctx, shape);

        // Strokes (border) — also warped by the parent displacement.
        let stroke_refs: Vec<_> = shape.visible_strokes().collect();
        let stroke_result = if !stroke_refs.is_empty() {
            super::strokes::render(ctx, shape, &stroke_refs, antialias, None)
        } else {
            Ok(())
        };

        fill_result.and(stroke_result)
    };

    // Close save_layer (Skia applies displacement filter now) + restore.
    {
        let canvas = ctx.surface.canvas();
        canvas.restore(); // close save_layer (displacement applied)
        canvas.restore(); // pop the outer save
    }

    body_result
}
