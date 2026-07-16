//! SSA renderer for a single-shape custom SkSL material — a post-body
//! overlay effect (drawn over the shape's fill/strokes, not replacing them).
//!
//! Unlike `glass`/`noise` — whose uniforms are hand-matched by name — a
//! material's uniforms are bound generically: the binder walks
//! `effect.uniforms()` and, for each declared uniform, either fills an
//! engine-owned value (`u_resolution`, `u_scale`, `u_time`) or copies the
//! matching user value from `material.uniforms`. Adding a `uniform` to the
//! source therefore needs no Rust change.
//!
//! Scope (first slice): self-contained shaders only — no child samplers
//! (`backdrop`/`field`) and `u_time` is always `0.0` (no clock yet). The
//! shader is evaluated in shape-local coordinates: `fragCoord` spans
//! `0..selrect.size` and `u_resolution` is that size.

use std::cell::RefCell;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use skia_safe::{self as skia, RuntimeEffect};

use crate::error::Result;
use crate::shapes::{Material, Shape, UniformValue};

use super::PaintCtx;

/// Maximum device-pixel extent of a material's render buffer. Beyond this the
/// shader is rendered into a reduced offscreen and upsampled, so extreme zoom
/// can't make the fragment shader run over an unbounded pixel count (or exceed
/// the ~4096 minimum WebGL max-texture-size). Material patterns are
/// low-frequency, so the upscale is visually cheap.
const RES_CAP_PX: f32 = 2048.0;

/// Uniforms the renderer fills itself — never surfaced as editor controls.
const ENGINE_UNIFORMS: [&str; 3] = ["u_resolution", "u_scale", "u_time"];

/// Max compiled effects retained. The cache is a *liveness memo*, not a
/// history: live sources are re-requested every frame so they stay resident,
/// while dead ones (every keystroke in the editor produces a source that is
/// compiled once and never looked up again) age out. Without a bound this
/// grows forever — a real leak once the editor/preview compile per keystroke.
const CACHE_CAP: usize = 64;

thread_local! {
    /// Compiled effects keyed by source hash. User sources aren't `const`,
    /// so a single `OnceCell` (as glass/noise use) won't do — distinct
    /// sources must coexist, and an unchanged source must hit the cache.
    ///
    /// LRU-bounded to `CACHE_CAP`: `order` holds keys oldest-first and is
    /// touched on every hit. Eviction only costs a recompile, never
    /// correctness.
    static CACHE: RefCell<HashMap<u64, RuntimeEffect>> = RefCell::new(HashMap::new());
    static CACHE_ORDER: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) };
}

/// Mark `key` as most-recently-used, evicting the oldest entries past the cap.
fn touch_cache_key(key: u64) {
    CACHE_ORDER.with(|order| {
        let mut order = order.borrow_mut();
        if let Some(pos) = order.iter().position(|k| *k == key) {
            order.remove(pos);
        }
        order.push(key);
        while order.len() > CACHE_CAP {
            let evicted = order.remove(0);
            CACHE.with(|cache| {
                cache.borrow_mut().remove(&evicted);
            });
        }
    });
}

/// Engine-supplied uniform values. Never user-set; filled by the renderer.
/// `pub(crate)` so the isolated focus-mode preview (`render::preview`) can bind
/// the same uniforms against its own surface instead of duplicating them.
pub(crate) struct EngineUniforms {
    pub resolution: (f32, f32),
    pub scale: f32,
    pub time: f32,
}

fn hash_source(src: &str) -> u64 {
    let mut h = DefaultHasher::new();
    src.hash(&mut h);
    h.finish()
}

/// Compile (cached). Returns the cached effect on hit; compiles + caches on
/// miss. Never panics — a compile error is returned as `Err(message)` so the
/// caller can keep the last good frame instead of crashing.
fn get_or_compile(src: &str) -> std::result::Result<RuntimeEffect, String> {
    let key = hash_source(src);
    let hit = CACHE.with(|cache| cache.borrow().get(&key).cloned());
    if let Some(effect) = hit {
        touch_cache_key(key);
        return Ok(effect);
    }
    let effect = RuntimeEffect::make_for_shader(src, None).map_err(|e| e.to_string())?;
    CACHE.with(|cache| {
        cache.borrow_mut().insert(key, effect.clone());
    });
    // Insert then evict, so `touch` can drop the oldest without ever evicting
    // the entry we just added (it's the newest).
    touch_cache_key(key);
    Ok(effect)
}

/// A reflected uniform surfaced to the editor so it can auto-generate a control
/// (a slider per component, or a color swatch when `is_color`).
pub struct ReflectedUniform {
    pub name: String,
    /// 1..=4; `0` for types with no simple control (matrices).
    pub components: u32,
    pub is_color: bool,
    /// Array length (1 when scalar).
    pub count: u32,
}

/// Outcome of compiling a material's source for the editor: compile status plus
/// the reflected editable uniforms and `uniform shader` inputs.
pub struct ReflectResult {
    pub ok: bool,
    pub error: Option<String>,
    pub uniforms: Vec<ReflectedUniform>,
    pub inputs: Vec<String>,
}

fn type_components(ty: skia::runtime_effect::uniform::Type) -> u32 {
    use skia::runtime_effect::uniform::Type;
    match ty {
        Type::Float | Type::Int => 1,
        Type::Float2 | Type::Int2 => 2,
        Type::Float3 | Type::Int3 => 3,
        Type::Float4 | Type::Int4 => 4,
        _ => 0,
    }
}

/// Compile (cached) and reflect the material's editable uniforms + shader
/// inputs. Engine-owned uniforms are omitted. On compile error, `ok = false`
/// carries the message and the lists are empty.
pub fn compile_and_reflect(src: &str) -> ReflectResult {
    let effect = match get_or_compile(src) {
        Ok(e) => e,
        Err(error) => {
            return ReflectResult {
                ok: false,
                error: Some(error),
                uniforms: Vec::new(),
                inputs: Vec::new(),
            }
        }
    };
    let uniforms = effect
        .uniforms()
        .iter()
        .filter(|u| !ENGINE_UNIFORMS.iter().any(|e| *e == u.name()))
        .map(|u| ReflectedUniform {
            name: u.name().to_string(),
            components: type_components(u.ty()),
            is_color: u.is_color(),
            count: u.count().max(1) as u32,
        })
        .collect();
    let inputs = effect
        .children()
        .iter()
        .map(|c| c.name().to_string())
        .collect();
    ReflectResult {
        ok: true,
        error: None,
        uniforms,
        inputs,
    }
}

fn write_f32(data: &mut [u8], offset: usize, val: f32) {
    data[offset..offset + 4].copy_from_slice(&val.to_ne_bytes());
}

fn write_value(data: &mut [u8], offset: usize, value: &UniformValue) {
    match value {
        UniformValue::F32(x) => write_f32(data, offset, *x),
        UniformValue::Vec2(v) => v.iter().enumerate().for_each(|(i, x)| write_f32(data, offset + i * 4, *x)),
        UniformValue::Vec3(v) => v.iter().enumerate().for_each(|(i, x)| write_f32(data, offset + i * 4, *x)),
        UniformValue::Vec4(v) => v.iter().enumerate().for_each(|(i, x)| write_f32(data, offset + i * 4, *x)),
    }
}

/// Pack the uniform buffer: engine-owned uniforms by fixed name, everything
/// else from the material's slots matched by name. Unmatched uniforms stay
/// zeroed.
fn bind(effect: &RuntimeEffect, material: &Material, engine: &EngineUniforms) -> Vec<u8> {
    let mut data = vec![0u8; effect.uniform_size()];
    for u in effect.uniforms().iter() {
        let name: &str = &u.name();
        let off = u.offset();
        match name {
            "u_resolution" => {
                write_f32(&mut data, off, engine.resolution.0);
                write_f32(&mut data, off + 4, engine.resolution.1);
            }
            "u_scale" => write_f32(&mut data, off, engine.scale),
            "u_time" => write_f32(&mut data, off, engine.time),
            _ => {
                if let Some(slot) = material.uniforms.iter().find(|s| s.name == name) {
                    write_value(&mut data, off, &slot.value);
                }
            }
        }
    }
    data
}

/// Compile + bind a material into a paint shader. `None` on compile error
/// (caller draws nothing rather than crashing). No child samplers yet.
///
/// `pub(crate)` so the isolated preview reuses the exact same compile + bind
/// path as the on-canvas render — the preview can't drift from the real thing.
pub(crate) fn make_material_shader(
    material: &Material,
    engine: &EngineUniforms,
    local_matrix: Option<&skia::Matrix>,
) -> Option<skia::Shader> {
    let effect = get_or_compile(&material.source).ok()?;
    let data = bind(&effect, material, engine);
    let children: [skia::runtime_effect::ChildPtr; 0] = [];
    effect.make_shader(skia::Data::new_copy(&data), &children, local_matrix)
}

/// Draw the material shader over the shape's finished body, clipped to the
/// shape's geometry and composited SrcOver (non-destructive — the fill and
/// strokes underneath show through wherever the shader outputs alpha < 1).
///
/// The shader is evaluated in shape-local world units (`u_resolution =
/// selrect.size`, `fragCoord` spans `0..size`). When the shape's on-screen
/// footprint exceeds `RES_CAP_PX` the shader is rendered into a reduced
/// offscreen and upsampled — bounding fragment work at extreme zoom.
pub fn render(ctx: &mut PaintCtx<'_>, shape: &Shape, material: &Material) -> Result<()> {
    let selrect = shape.selrect;
    let (w, h) = (selrect.width(), selrect.height());
    if w <= 0.0 || h <= 0.0 {
        return Ok(());
    }

    // Device-pixel footprint at the current zoom, and the cap factor `q <= 1`
    // that keeps the render buffer's longest side within `RES_CAP_PX`.
    let (dw, dh) = (w * ctx.scale, h * ctx.scale);
    let longest = dw.max(dh);
    let q = if longest > RES_CAP_PX {
        RES_CAP_PX / longest
    } else {
        1.0
    };

    // `u_resolution` stays in world units (zoom-independent pattern); `u_scale`
    // reflects the scale of the buffer actually being rendered into.
    let engine = EngineUniforms {
        resolution: (w, h),
        scale: ctx.scale * q,
        time: 0.0,
    };
    // Offset the shader so `fragCoord` starts at the shape's top-left.
    let local = skia::Matrix::translate((selrect.x(), selrect.y()));
    let Some(shader) = make_material_shader(material, &engine, Some(&local)) else {
        return Ok(());
    };

    if q >= 1.0 {
        // Footprint within budget — draw the shader straight onto the target.
        // Compute the tile+shape matrix before borrowing the canvas (`&self`
        // method vs the `&mut surface` borrow below).
        let matrix = ctx.tile_and_shape_transform_matrix(shape);
        let canvas = ctx.surface.canvas();
        canvas.save();
        canvas.concat(&matrix);
        crate::render::glass::clip_to_shape(canvas, shape);
        let mut paint = skia::Paint::default();
        paint.set_anti_alias(true);
        paint.set_shader(shader);
        canvas.draw_paint(&paint);
        canvas.restore();
        return Ok(());
    }

    // Over budget — render the shader into a capped offscreen, then upsample.
    let ow = ((dw * q).round() as i32).max(1);
    let oh = ((dh * q).round() as i32).max(1);
    let mut off = ctx.gpu.create_budgeted_surface(ow, oh)?;
    {
        let oc = off.canvas();
        oc.clear(skia::Color::TRANSPARENT);
        // Map the shape's world rect onto the offscreen's pixels.
        oc.scale((ow as f32 / w, oh as f32 / h));
        oc.translate((-selrect.x(), -selrect.y()));
        crate::render::glass::clip_to_shape(oc, shape);
        let mut paint = skia::Paint::default();
        paint.set_anti_alias(true);
        paint.set_shader(shader);
        oc.draw_paint(&paint);
    }
    let image = off.image_snapshot();

    let matrix = ctx.tile_and_shape_transform_matrix(shape);
    let sampling = ctx.sampling;
    let canvas = ctx.surface.canvas();
    canvas.save();
    canvas.concat(&matrix);
    crate::render::glass::clip_to_shape(canvas, shape);
    let src = skia::Rect::new(0.0, 0.0, ow as f32, oh as f32);
    let paint = skia::Paint::default();
    canvas.draw_image_rect_with_sampling_options(
        &image,
        Some((&src, skia::canvas::SrcRectConstraint::Fast)),
        selrect,
        sampling,
        &paint,
    );
    canvas.restore();
    Ok(())
}
