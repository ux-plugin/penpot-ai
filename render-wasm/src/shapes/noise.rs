use skia_safe::{self as skia, Color, Paint, Rect, Shader};

#[derive(Debug, Clone, Copy, PartialEq)]
#[repr(u8)]
pub enum NoiseType {
    Monotone = 0,
    Duotone = 1,
    Multitone = 2,
}

impl From<u8> for NoiseType {
    fn from(value: u8) -> Self {
        match value {
            0 => Self::Monotone,
            1 => Self::Duotone,
            2 => Self::Multitone,
            _ => Self::Monotone,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NoiseEffect {
    pub noise_type: NoiseType,
    pub noise_size: f32,
    pub density: f32,
    pub color: Color,
    pub secondary_color: Color,
    pub hidden: bool,
}

impl NoiseEffect {
    pub fn new(
        noise_type: NoiseType,
        noise_size: f32,
        density: f32,
        color: Color,
        secondary_color: Color,
        hidden: bool,
    ) -> Self {
        Self {
            noise_type,
            noise_size,
            density,
            color,
            secondary_color,
            hidden,
        }
    }

    fn base_frequency(&self) -> f32 {
        let size = self.noise_size.max(1.0);
        1.0 / size
    }

    fn make_noise_shader(&self) -> Option<Shader> {
        let freq = self.base_frequency();
        skia::shaders::turbulence((freq, freq), 4, 0.0, None)
    }

    /// Build the paints needed to render this noise effect.
    /// Returns a list of (paint, alpha) pairs to draw over the shape bounds.
    pub fn build_paints(&self) -> Vec<Paint> {
        if self.hidden {
            return vec![];
        }

        let noise_shader = match self.make_noise_shader() {
            Some(s) => s,
            None => return vec![],
        };

        match self.noise_type {
            NoiseType::Monotone => {
                let mut paint = Paint::default();
                paint.set_anti_alias(true);
                paint.set_blend_mode(skia::BlendMode::Overlay);
                let color_shader = skia::shaders::color(self.color);
                let composed = skia::shaders::blend(
                    skia::BlendMode::SrcIn,
                    color_shader,
                    noise_shader,
                );
                if let Some(s) = composed {
                    paint.set_shader(s);
                }
                vec![paint]
            }

            NoiseType::Duotone => {
                let density_alpha = (self.density.clamp(0.0, 1.0) * 255.0) as u8;

                let mut paint1 = Paint::default();
                paint1.set_anti_alias(true);
                paint1.set_blend_mode(skia::BlendMode::Overlay);
                let color_shader1 = skia::shaders::color(self.color);
                let composed1 = skia::shaders::blend(
                    skia::BlendMode::SrcIn,
                    color_shader1,
                    noise_shader.clone(),
                );
                if let Some(s) = composed1 {
                    paint1.set_shader(s);
                }

                let sec_color = Color::from_argb(
                    density_alpha,
                    self.secondary_color.r(),
                    self.secondary_color.g(),
                    self.secondary_color.b(),
                );
                let mut paint2 = Paint::default();
                paint2.set_anti_alias(true);
                paint2.set_blend_mode(skia::BlendMode::Overlay);
                let color_shader2 = skia::shaders::color(sec_color);
                let composed2 = skia::shaders::blend(
                    skia::BlendMode::SrcIn,
                    color_shader2,
                    noise_shader,
                );
                if let Some(s) = composed2 {
                    paint2.set_shader(s);
                }

                vec![paint1, paint2]
            }

            NoiseType::Multitone => {
                let density_alpha = (self.density.clamp(0.0, 1.0) * 255.0) as u8;

                let mut paint1 = Paint::default();
                paint1.set_anti_alias(true);
                paint1.set_blend_mode(skia::BlendMode::Overlay);
                let color_shader1 = skia::shaders::color(self.color);
                let composed1 = skia::shaders::blend(
                    skia::BlendMode::SrcIn,
                    color_shader1,
                    noise_shader.clone(),
                );
                if let Some(s) = composed1 {
                    paint1.set_shader(s);
                }

                let mid_color = Color::from_argb(
                    density_alpha,
                    self.secondary_color.r(),
                    self.secondary_color.g(),
                    self.secondary_color.b(),
                );
                let mut paint2 = Paint::default();
                paint2.set_anti_alias(true);
                paint2.set_blend_mode(skia::BlendMode::Multiply);
                let color_shader2 = skia::shaders::color(mid_color);
                let composed2 = skia::shaders::blend(
                    skia::BlendMode::SrcIn,
                    color_shader2,
                    noise_shader,
                );
                if let Some(s) = composed2 {
                    paint2.set_shader(s);
                }

                vec![paint1, paint2]
            }
        }
    }
}

/// Render the noise effect onto `canvas`, clipped to `bounds`.
pub fn render_noise(canvas: &skia::Canvas, noise: &NoiseEffect, bounds: &Rect) {
    if noise.hidden {
        return;
    }
    let paints = noise.build_paints();
    for paint in &paints {
        canvas.save();
        canvas.clip_rect(bounds, skia::ClipOp::Intersect, true);
        canvas.draw_rect(bounds, paint);
        canvas.restore();
    }
}
