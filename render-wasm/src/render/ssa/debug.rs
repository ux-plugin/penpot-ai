//! SSA debug overlay — visual + console diagnostics for the SSA
//! scheduler's per-tile paint geometry.
//!
//! The "shapes render at the wrong location" class of bug has a small
//! number of root causes:
//!
//! 1. Per-tile translation wrong (margins miscalculated, world_clip
//!    not per-tile, scale leaking in).
//! 2. `Step::Paint::clip_rect` not actually varying per tile.
//! 3. Shape transform applied before/after the tile transform in the
//!    wrong order (drawing in tile-local coords instead of world).
//! 4. Tile composite-to-Target uses the wrong device offset.
//!
//! The overlay surfaces all of these visually:
//!
//! - **Tile border** — a red 2px rectangle at the tile's world-space
//!   bounds. If borders form a clean adjacent grid → tile-to-target
//!   compositing is correct. If they overlap / are offset → composite
//!   placement is wrong.
//! - **Tile coord label** — `(tx, ty)` text at the tile's top-left.
//!   Reveals which tile a given on-screen region came from.
//! - **World-origin crosshair** — a green `+` at world `(0, 0)`. If
//!   the crosshair appears at the on-screen position the frontend
//!   reports as world (0,0), the tile transform is correct. If it's
//!   offset, the translation is wrong.
//! - **Selrect outline** — a cyan rectangle at `shape.selrect` (drawn
//!   after the tile transform). This is *where the shape thinks it
//!   should land in world coords*. Comparing the cyan outline to the
//!   actual painted pixels tells you whether the issue is the shape
//!   transform (cyan in right spot, pixels in wrong spot) or the tile
//!   transform (cyan in wrong spot).
//!
//! Plus a console log per Paint step with the full geometry tuple so
//! offsets/sizes can be cross-checked against frontend selrect numbers.
//!
//! Gated on `RenderOptions::is_debug_visible()` — already toggleable
//! via the existing `set_render_options(debug, dpr)` C ABI; no rebuild
//! needed to switch on / off.

use skia_safe::{self as skia, Paint, Point, Rect};

use crate::shapes::Shape;

use super::PaintCtx;

/// Color constants for the overlay. Bright + saturated so they're
/// visible against typical scene content.
mod color {
    use skia_safe::Color;
    pub const TILE_BORDER: Color = Color::RED;
    pub const TILE_LABEL: Color = Color::RED;
    pub const WORLD_ORIGIN: Color = Color::GREEN;
    pub const SELRECT: Color = Color::CYAN;
}

/// Draw the per-tile debug overlay on top of the paint result.
///
/// Called from the paint dispatch path AFTER the shape has been drawn,
/// so the overlay appears on top. The canvas state is the ctx's
/// surface canvas — this function applies its own transform via
/// `ctx.apply_tile_transform` so it can draw in world coords.
///
/// No-op when `is_debug_visible()` is false.
pub fn paint_overlay(ctx: &mut PaintCtx<'_>, shape: &Shape) {
    if !ctx.options.is_debug_visible() {
        return;
    }

    // Snapshot everything we need from ctx BEFORE borrowing the
    // canvas. Otherwise `ctx.surface.canvas()` reborrows ctx and
    // blocks any later `&self` calls on it.
    let xform = ctx.tile_transform_matrix();
    let scale = ctx.scale.max(1e-6);
    let world_clip = ctx.world_clip;
    let tile_x = ctx.tile.x();
    let tile_y = ctx.tile.y();
    let mut font = ctx.fonts.debug_font().clone();
    font.set_size(12.0 / scale);
    let label = format!("t=({},{})", tile_x, tile_y);
    let info = format!(
        "shape=({:.0},{:.0} {:.0}x{:.0}) clip=({:.0},{:.0} {:.0}x{:.0})",
        shape.selrect.left,
        shape.selrect.top,
        shape.selrect.width(),
        shape.selrect.height(),
        world_clip.left,
        world_clip.top,
        world_clip.width(),
        world_clip.height(),
    );
    let selrect = Rect::from_ltrb(
        shape.selrect.left,
        shape.selrect.top,
        shape.selrect.right,
        shape.selrect.bottom,
    );

    let canvas = ctx.surface.canvas();
    canvas.save();
    // See fills.rs — pool-reused surfaces require absolute matrix.
    canvas.reset_matrix();
    canvas.concat(&xform);

    // 1. Tile border at world_clip.
    let mut border_paint = Paint::default();
    border_paint.set_style(skia::PaintStyle::Stroke);
    border_paint.set_color(color::TILE_BORDER);
    border_paint.set_stroke_width(2.0 / scale);
    canvas.draw_rect(world_clip, &border_paint);

    // 2. Tile coord label + geometry info at top-left of world_clip.
    let mut label_paint = Paint::default();
    label_paint.set_color(color::TILE_LABEL);
    label_paint.set_anti_alias(true);
    canvas.draw_str(
        &label,
        Point::new(world_clip.left + 4.0 / scale, world_clip.top + 14.0 / scale),
        &font,
        &label_paint,
    );
    canvas.draw_str(
        &info,
        Point::new(world_clip.left + 4.0 / scale, world_clip.top + 28.0 / scale),
        &font,
        &label_paint,
    );

    // 3. World-origin crosshair (visible only in tiles whose world_clip
    // contains (0,0), but the draw call is cheap to always issue).
    let mut origin_paint = Paint::default();
    origin_paint.set_style(skia::PaintStyle::Stroke);
    origin_paint.set_color(color::WORLD_ORIGIN);
    origin_paint.set_stroke_width(2.0 / scale);
    let cross_size = 12.0 / scale;
    canvas.draw_line(
        Point::new(-cross_size, 0.0),
        Point::new(cross_size, 0.0),
        &origin_paint,
    );
    canvas.draw_line(
        Point::new(0.0, -cross_size),
        Point::new(0.0, cross_size),
        &origin_paint,
    );

    // 4. Selrect outline (the shape's claimed world bounds).
    let mut selrect_paint = Paint::default();
    selrect_paint.set_style(skia::PaintStyle::Stroke);
    selrect_paint.set_color(color::SELRECT);
    selrect_paint.set_stroke_width(1.0 / scale);
    canvas.draw_rect(selrect, &selrect_paint);

    canvas.restore();
}

/// Endpoint for the `/debug-mode` skill server. The skill's `start.sh`
/// picks an ephemeral port and writes the URL to
/// `~/.claude/skills/debug-mode/.runtime/<cwd-hash>/url`. We hardcode
/// the port at build time because emscripten wasm can't read the file
/// or env vars at runtime — update this constant when the server is
/// restarted on a new port, then rebuild.
const DEBUG_EVENT_ENDPOINT: &str = "http://127.0.0.1:50092/event";

/// Fire-and-forget POST of a `{tag, value, site}` event to the
/// debug-mode server. `value_json` must already be a valid JSON
/// fragment (object, array, string with quotes, number, etc.) — this
/// function embeds it directly into the body.
///
/// Compiles to a no-op off wasm.
#[cfg(target_arch = "wasm32")]
pub fn event(tag: &str, value_json: &str, site: &str) {
    // Build the JSON body. Tag + site are quoted strings (use Debug
    // for proper escaping); value is already a JSON fragment so it
    // goes in raw.
    let body = format!(
        "{{\"tag\":{:?},\"value\":{},\"site\":{:?}}}",
        tag, value_json, site,
    );
    let js = format!(
        "fetch({:?},{{method:'POST',mode:'no-cors',keepalive:true,headers:{{'content-type':'application/json'}},body:{:?}}}).catch(()=>{{}})",
        DEBUG_EVENT_ENDPOINT, body,
    );
    crate::run_script!(js);
}

#[cfg(not(target_arch = "wasm32"))]
pub fn event(_tag: &str, _value_json: &str, _site: &str) {}

/// Emit a structured log line for the current Paint step. One line per
/// step, prefixed `[ssa-debug]` so the server can demux multiple
/// concurrent sources from the same log file.
///
/// No-op when `is_debug_visible()` is false.
/// Per-PaintCtx structured event — for use from inside SSA renderers.
/// Always fires (no is_debug_visible gate) because the debug-mode
/// workflow is opt-in at the server side: if the server isn't running,
/// the fetch fails silently.
pub fn log_paint_step(ctx: &PaintCtx<'_>, shape: &Shape, effect_count: usize) {
    let value = format!(
        "{{\"tile\":[{},{}],\"shape\":{:?},\"selrect\":[{:.1},{:.1},{:.1},{:.1}],\"world_origin\":[{:.1},{:.1}],\"world_clip\":[{:.1},{:.1},{:.1},{:.1}],\"scale\":{:.3},\"margins\":[{},{}],\"effects\":{}}}",
        ctx.tile.x(),
        ctx.tile.y(),
        shape.id.to_string(),
        shape.selrect.left,
        shape.selrect.top,
        shape.selrect.width(),
        shape.selrect.height(),
        ctx.world_origin.x,
        ctx.world_origin.y,
        ctx.world_clip.left,
        ctx.world_clip.top,
        ctx.world_clip.width(),
        ctx.world_clip.height(),
        ctx.scale,
        ctx.margins.width,
        ctx.margins.height,
        effect_count,
    );
    event("ssa-paint", &value, "production_sink.rs::paint_into_pooled");
}
