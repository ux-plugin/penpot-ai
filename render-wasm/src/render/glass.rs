use std::cell::OnceCell;

use skia_safe::{self as skia, RRect, RuntimeEffect};

use crate::shapes::{GlassEffect, Shape, Type, GLASS_DISPLACEMENT_SKSL, GLASS_REFRACTION_SKSL, GLASS_SKSL};

use super::gpu_state::GpuState;
use super::{RenderState, SurfaceId};

thread_local! {
    static DISPLACEMENT_EFFECT: OnceCell<RuntimeEffect> = const { OnceCell::new() };
    static REFRACTION_EFFECT: OnceCell<RuntimeEffect> = const { OnceCell::new() };
    static COMPOSITE_EFFECT: OnceCell<RuntimeEffect> = const { OnceCell::new() };
}

/// Build the glass composite shader (pass 3) using the cached, compiled
/// `GLASS_SKSL` runtime effect. Exposed `pub(crate)` so `render::ssa::glass`
/// can reuse the same compiled shader the legacy path uses — avoids a
/// duplicate compile + ensures pixel parity for the composite math.
pub(crate) fn make_glass_composite_shader(
    iw: i32,
    ih: i32,
    glass: &GlassEffect,
    scale: f32,
    blurred_shader: skia::Shader,
    original_shader: skia::Shader,
    displacement_shader: skia::Shader,
) -> Option<skia::Shader> {
    COMPOSITE_EFFECT.with(|cell| {
        let effect = cell.get_or_init(|| compile(GLASS_SKSL));

        let uniform_size = effect.uniform_size();
        let mut data = vec![0u8; uniform_size];

        for u in effect.uniforms().iter() {
            let name: &str = &u.name();
            let off = u.offset();
            match name {
                "u_resolution" => {
                    write_f32(&mut data, off, iw as f32);
                    write_f32(&mut data, off + 4, ih as f32);
                }
                "u_frost" => {
                    write_f32(&mut data, off, glass.frost);
                }
                "u_specularOpacity" => {
                    write_f32(&mut data, off, glass.specular_opacity);
                }
                "u_specularSaturation" => {
                    write_f32(&mut data, off, glass.specular_saturation);
                }
                "u_scale" => {
                    write_f32(&mut data, off, scale);
                }
                _ => {}
            }
        }

        let children = vec![
            skia::runtime_effect::ChildPtr::Shader(blurred_shader),
            skia::runtime_effect::ChildPtr::Shader(original_shader),
            skia::runtime_effect::ChildPtr::Shader(displacement_shader),
        ];

        effect.make_shader(skia::Data::new_copy(&data), &children, None)
    })
}

pub(crate) fn compile(src: &str) -> RuntimeEffect {
    RuntimeEffect::make_for_shader(src, None).expect("SkSL compile failed")
}

pub(crate) fn write_f32(data: &mut [u8], offset: usize, val: f32) {
    data[offset..offset + 4].copy_from_slice(&val.to_ne_bytes());
}

pub(crate) fn write_i32(data: &mut [u8], offset: usize, val: i32) {
    data[offset..offset + 4].copy_from_slice(&val.to_ne_bytes());
}

/// Clip canvas to the shape's actual geometry.
pub(crate) fn clip_to_shape(canvas: &skia::Canvas, shape: &Shape) {
    match &shape.shape_type {
        Type::Rect(data) if data.corners.is_some() => {
            let rrect = RRect::new_rect_radii(shape.selrect, data.corners.as_ref().unwrap());
            canvas.clip_rrect(rrect, skia::ClipOp::Intersect, true);
        }
        Type::Frame(data) if data.corners.is_some() => {
            let rrect = RRect::new_rect_radii(shape.selrect, data.corners.as_ref().unwrap());
            canvas.clip_rrect(rrect, skia::ClipOp::Intersect, true);
        }
        Type::Rect(_) | Type::Frame(_) => {
            canvas.clip_rect(shape.selrect, skia::ClipOp::Intersect, true);
        }
        Type::Circle => {
            let mut pb = skia::PathBuilder::new();
            pb.add_oval(shape.selrect, None, None);
            canvas.clip_path(&pb.detach(), skia::ClipOp::Intersect, true);
        }
        _ => {
            if let Some(path) = shape.get_skia_path() {
                canvas.clip_path(&path, skia::ClipOp::Intersect, true);
            } else {
                canvas.clip_rect(shape.selrect, skia::ClipOp::Intersect, true);
            }
        }
    }
}

/// Create a blurred version of an image as a shader, using Skia's built-in blur.
/// Uses a GPU surface to keep all operations on the GPU (raster surfaces cannot
/// read back GPU-backed textures in the WASM/WebGL context).
pub(crate) fn make_blurred_shader(
    gpu_state: &mut GpuState,
    image: &skia::Image,
    sigma: f32,
    sampling: skia::SamplingOptions,
) -> Option<skia::Shader> {
    let blur_filter =
        skia::image_filters::blur((sigma, sigma), skia::TileMode::Clamp, None, None)?;

    // Use a budgeted GPU surface — Skia manages the texture lifecycle so it
    // gets freed when no longer referenced, preventing GPU memory leaks.
    let mut temp_surface = gpu_state
        .create_budgeted_surface(image.width(), image.height())
        .ok()?;

    {
        let temp_canvas = temp_surface.canvas();
        let mut paint = skia::Paint::default();
        paint.set_image_filter(blur_filter);
        temp_canvas.draw_image(image, (0.0, 0.0), Some(&paint));
    }

    temp_surface.image_snapshot().to_shader(
        (skia::TileMode::Clamp, skia::TileMode::Clamp),
        sampling,
        None,
    )
}

/// Pass 1: Render the displacement field to a temporary F16 GPU surface and return
/// it as a child shader for subsequent passes.
///
/// The displacement shader computes SDF, surface profiles, Snell's Law
/// refraction, specular highlights, and outputs raw float values:
///   half4(dx, dy, specular, mask)
pub(crate) fn render_displacement_pass(
    gpu_state: &mut GpuState,
    iw: i32,
    ih: i32,
    box_center_dev: skia::Point,
    box_half_w_dev: f32,
    box_half_h_dev: f32,
    corner_radius_dev: f32,
    glass: &GlassEffect,
    scale: f32,
) -> Option<skia::Shader> {
    DISPLACEMENT_EFFECT.with(|cell| {
        let effect = cell.get_or_init(|| compile(GLASS_DISPLACEMENT_SKSL));

        // Fill geometry/physics uniforms
        let uniform_size = effect.uniform_size();
        let mut data = vec![0u8; uniform_size];

        for u in effect.uniforms().iter() {
            let name: &str = &u.name();
            let off = u.offset();
            match name {
                "u_resolution" => {
                    write_f32(&mut data, off, iw as f32);
                    write_f32(&mut data, off + 4, ih as f32);
                }
                "u_mouse" => {
                    write_f32(&mut data, off, box_center_dev.x);
                    write_f32(&mut data, off + 4, box_center_dev.y);
                    write_f32(&mut data, off + 8, 0.0);
                    write_f32(&mut data, off + 12, 0.0);
                }
                "u_surfaceType" => {
                    write_i32(&mut data, off, glass.surface_type);
                }
                "u_bezelWidth" => {
                    write_f32(&mut data, off, glass.bezel_width * scale);
                }
                "u_glassThickness" => {
                    write_f32(&mut data, off, glass.glass_thickness);
                }
                "u_refractiveIndex" => {
                    write_f32(&mut data, off, glass.refractive_index);
                }
                "u_specularAngle" => {
                    write_f32(&mut data, off, glass.specular_angle);
                }
                "u_glassSize" => {
                    write_f32(&mut data, off, box_half_w_dev);
                    write_f32(&mut data, off + 4, box_half_h_dev);
                }
                "u_cornerRadius" => {
                    write_f32(&mut data, off, corner_radius_dev);
                }
                "u_splay" => {
                    write_f32(&mut data, off, glass.splay);
                }
                "u_tiltAngle" => {
                    write_f32(&mut data, off, glass.tilt_angle);
                }
                "u_edgeBoost" => {
                    write_f32(&mut data, off, glass.edge_boost);
                }
                "u_zoom" => {
                    write_f32(&mut data, off, glass.zoom);
                }
                "u_scale" => {
                    write_f32(&mut data, off, scale);
                }
                _ => {}
            }
        }

        // No child shaders — pure computation
        let disp_shader = effect.make_shader(skia::Data::new_copy(&data), &[], None)?;

        // Render to a temporary F16 GPU surface for full-precision displacement values
        let mut temp_surface = gpu_state
            .create_budgeted_surface_f16(iw, ih)
            .ok()?;

        {
            let canvas = temp_surface.canvas();
            let mut paint = skia::Paint::default();
            paint.set_shader(disp_shader);
            paint.set_blend_mode(skia::BlendMode::Src);
            canvas.draw_paint(&paint);
        }

        let disp_image = temp_surface.image_snapshot();

        // Linear sampling is fine with F16 raw values
        disp_image.to_shader(
            (skia::TileMode::Clamp, skia::TileMode::Clamp),
            skia::SamplingOptions::new(skia::FilterMode::Linear, skia::MipmapMode::None),
            None,
        )
    })
}

/// Pass 2: Apply refraction and chromatic aberration to the unblurred backdrop.
/// Renders to a GPU surface and returns the refracted image.
pub(crate) fn render_refraction_pass(
    gpu_state: &mut GpuState,
    iw: i32,
    ih: i32,
    backdrop_shader: skia::Shader,
    displacement_shader: skia::Shader,
    glass: &GlassEffect,
    scale: f32,
) -> Option<skia::Image> {
    REFRACTION_EFFECT.with(|cell| {
        let effect = cell.get_or_init(|| compile(GLASS_REFRACTION_SKSL));

        let uniform_size = effect.uniform_size();
        let mut data = vec![0u8; uniform_size];

        for u in effect.uniforms().iter() {
            let name: &str = &u.name();
            let off = u.offset();
            match name {
                "u_resolution" => {
                    write_f32(&mut data, off, iw as f32);
                    write_f32(&mut data, off + 4, ih as f32);
                }
                "u_chromaticAberration" => {
                    write_f32(&mut data, off, glass.chromatic_aberration * scale);
                }
                "u_scale" => {
                    write_f32(&mut data, off, scale);
                }
                _ => {}
            }
        }

        // Child shaders: backdrop (unblurred) + displacement
        let children = vec![
            skia::runtime_effect::ChildPtr::Shader(backdrop_shader),
            skia::runtime_effect::ChildPtr::Shader(displacement_shader),
        ];

        let refract_shader = effect.make_shader(skia::Data::new_copy(&data), &children, None)?;

        // Render to GPU surface
        let mut temp_surface = gpu_state
            .create_budgeted_surface(iw, ih)
            .ok()?;

        {
            let canvas = temp_surface.canvas();
            let mut paint = skia::Paint::default();
            paint.set_shader(refract_shader);
            paint.set_blend_mode(skia::BlendMode::Src);
            canvas.draw_paint(&paint);
        }

        Some(temp_surface.image_snapshot())
    })
}

