use crate::math::is_close_to;
use crate::shapes::fills::{Fill, SolidColor};
use skia_safe::{self as skia, Rect};

use super::Corners;
use super::StrokeLineCap;
use super::StrokeLineJoin;
use super::SvgAttrs;

#[derive(Debug, Clone, PartialEq, Copy)]
pub enum StrokeStyle {
    Solid,
    Dotted,
    Dashed,
    Mixed,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum StrokeCap {
    LineArrow,
    TriangleArrow,
    SquareMarker,
    CircleMarker,
    DiamondMarker,
    Round,
    Square,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum StrokeKind {
    Inner,
    Outer,
    Center,
}

/// "Dynamic" stroke — procedurally perturbs the path into a hand-drawn / wavy
/// line before stroking. All fields are 0..1.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DynamicStroke {
    /// Wiggle wavelength: higher = shorter waves / more wiggles.
    pub frequency: f32,
    /// Perpendicular displacement amplitude.
    pub wiggle: f32,
    /// Corner rounding of the result.
    pub smoothen: f32,
}

/// Width envelope along a PowerStroke's length (arc-fraction 0..1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WidthProfile {
    Uniform,
    TaperBoth,
    TaperStart,
    TaperEnd,
    Bulge,
    /// Hand-authored points — read from `Stroke::width_points` instead of a
    /// preset formula. Falls back to `Uniform` when there are no points.
    Custom,
}

/// Brush = the stroke's rendering engine. `None` on the stroke means the default
/// basic vector outline; each variant here is a non-basic engine.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Brush {
    /// Variable-width ("PowerStroke") — build a filled ribbon whose half-width
    /// follows `profile` (and an optional calligraphic `nib` angle).
    Power {
        profile: WidthProfile,
        /// Calligraphic nib angle in degrees; `<= 0` = round (no nib).
        nib: f32,
    },
    /// Textured ("stretch") brush — a uniform-width ribbon broken up by
    /// procedural grain so it reads as a dry / grungy ink stroke.
    Texture {
        /// Grain feature size in world units (bigger = coarser grain).
        scale: f32,
        /// Solidity 0..1 — low = very broken, high = mostly solid.
        density: f32,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Stroke {
    pub fill: Fill,
    pub width: f32,
    pub style: StrokeStyle,
    pub cap_end: Option<StrokeCap>,
    pub cap_start: Option<StrokeCap>,
    pub kind: StrokeKind,
    /// Custom dash pattern `[dash, gap, …]` in user units. Empty = derive the
    /// pattern from `style` (legacy behaviour).
    pub dashes: Vec<f32>,
    /// Cap applied to dash/line ends (butt/round/square). `None` falls back to
    /// the shape's SVG attrs / Skia default.
    pub dash_cap: Option<StrokeLineCap>,
    /// Join override (miter/round/bevel). `None` falls back to SVG attrs.
    pub line_join: Option<StrokeLineJoin>,
    /// Miter limit ratio. `None` = Skia default (4).
    pub miter_limit: Option<f32>,
    /// Procedural "Dynamic" perturbation applied before stroking. `None` = off.
    pub dynamic: Option<DynamicStroke>,
    /// Brush engine. `None` = the default basic vector outline.
    pub brush: Option<Brush>,
    /// Hand-authored width points for `WidthProfile::Custom`, flattened as
    /// `[t, left, right, mode, …]`: `t` = arc-fraction 0..1 along the stroke,
    /// `left` / `right` = half-width multipliers of the stroke width on each
    /// side, `mode` = how the segment *leaving* this point interpolates
    /// (`0` smooth / Catmull-Rom, `1` corner / linear, `2` stepped / hold-left).
    /// Stored here (not in `Brush`) so `Brush` stays `Copy`, mirroring `dashes`.
    pub width_points: Vec<f32>,
}

impl Stroke {
    // Strokes for open shapes should be rendered as if they were centered.
    pub fn render_kind(&self, is_open: bool) -> StrokeKind {
        if is_open {
            StrokeKind::Center
        } else {
            self.kind
        }
    }

    pub fn bounds_width(&self, is_open: bool) -> f32 {
        // Ribbon brushes (variable-width Basic, Power, Texture) draw a filled ribbon
        // CENTERED on the spine whose half-width can far exceed the base stroke
        // width — a dragged-out width point pushes the outline well past the path's
        // box. The render/tile bounds must use that real extent, or the overflow is
        // clipped at a tile edge.
        let is_ribbon = matches!(self.brush, Some(Brush::Power { .. }) | Some(Brush::Texture { .. }))
            || (self.brush.is_none() && self.width_points.len() >= 4);
        if is_ribbon {
            return self.ribbon_half_extent();
        }
        match self.render_kind(is_open) {
            StrokeKind::Inner => 0.,
            StrokeKind::Center => self.width / 2.,
            StrokeKind::Outer => self.width,
        }
    }

    /// Largest half-width the rendered ribbon reaches: `base_half × max width-point
    /// multiplier`. Mirrors `render::brush::power_ribbon` so the bounds match what
    /// is actually drawn.
    fn ribbon_half_extent(&self) -> f32 {
        // Floor mirrors render::brush::MIN_WIDTH so thin strokes match the render.
        const MIN_WIDTH: f32 = 4.0;
        let base_half = self.width.max(MIN_WIDTH) * 0.5;
        let mut max_mult = 1.0_f32;
        let mut i = 0;
        while i + 3 < self.width_points.len() {
            max_mult = max_mult.max(self.width_points[i + 1]).max(self.width_points[i + 2]);
            i += 4;
        }
        base_half * max_mult
    }

    pub fn max_bounds_width<'a>(strokes: impl Iterator<Item = &'a Stroke>, is_open: bool) -> f32 {
        strokes
            .map(|stroke| stroke.bounds_width(is_open))
            .fold(0.0, f32::max)
    }

    pub fn new_center_stroke(
        width: f32,
        style: StrokeStyle,
        cap_start: Option<StrokeCap>,
        cap_end: Option<StrokeCap>,
    ) -> Self {
        Stroke {
            fill: Fill::Solid(SolidColor(skia::Color::TRANSPARENT)),
            width,
            style,
            cap_end,
            cap_start,
            kind: StrokeKind::Center,
            dashes: Vec::new(),
            dash_cap: None,
            line_join: None,
            miter_limit: None,
            dynamic: None,
            brush: None,
            width_points: Vec::new(),
        }
    }

    pub fn new_inner_stroke(
        width: f32,
        style: StrokeStyle,
        cap_start: Option<StrokeCap>,
        cap_end: Option<StrokeCap>,
    ) -> Self {
        Stroke {
            fill: Fill::Solid(SolidColor(skia::Color::TRANSPARENT)),
            width,
            style,
            cap_end,
            cap_start,
            kind: StrokeKind::Inner,
            dashes: Vec::new(),
            dash_cap: None,
            line_join: None,
            miter_limit: None,
            dynamic: None,
            brush: None,
            width_points: Vec::new(),
        }
    }

    pub fn new_outer_stroke(
        width: f32,
        style: StrokeStyle,
        cap_start: Option<StrokeCap>,
        cap_end: Option<StrokeCap>,
    ) -> Self {
        Stroke {
            fill: Fill::Solid(SolidColor(skia::Color::TRANSPARENT)),
            width,
            style,
            cap_end,
            cap_start,
            kind: StrokeKind::Outer,
            dashes: Vec::new(),
            dash_cap: None,
            line_join: None,
            miter_limit: None,
            dynamic: None,
            brush: None,
            width_points: Vec::new(),
        }
    }

    /// Set a custom dash pattern. A non-empty pattern forces `Dashed` style so
    /// the dash-aware geometry (corner offsets, clipping) stays consistent.
    pub fn set_dashes(&mut self, dashes: Vec<f32>) {
        if !dashes.is_empty() {
            self.style = StrokeStyle::Dashed;
        }
        self.dashes = dashes;
    }

    /// Override join / dash-cap / miter limit. A `None` argument leaves the
    /// corresponding value untouched.
    pub fn set_props(
        &mut self,
        join: Option<StrokeLineJoin>,
        cap: Option<StrokeLineCap>,
        miter: Option<f32>,
    ) {
        if join.is_some() {
            self.line_join = join;
        }
        if cap.is_some() {
            self.dash_cap = cap;
        }
        if miter.is_some() {
            self.miter_limit = miter;
        }
    }

    pub fn set_dynamic(&mut self, dynamic: DynamicStroke) {
        self.dynamic = Some(dynamic);
    }

    pub fn set_brush(&mut self, brush: Brush) {
        self.brush = Some(brush);
    }

    /// Set hand-authored width points (`[t, left, right, mode, …]`). A trailing
    /// partial quad is dropped so the buffer is always well-formed.
    pub fn set_width_points(&mut self, mut points: Vec<f32>) {
        let usable = points.len() - (points.len() % 4);
        points.truncate(usable);
        self.width_points = points;
    }

    pub fn scale_content(&mut self, value: f32) {
        self.width *= value;
    }

    /// Returns the clip operation for dotted inner/outer strokes.
    /// Returns `None` when no clipping is needed (center or non-dotted).
    pub fn clip_op(&self) -> Option<skia::ClipOp> {
        if self.style != StrokeStyle::Dotted || self.kind == StrokeKind::Center {
            return None;
        }
        match self.kind {
            StrokeKind::Inner => Some(skia::ClipOp::Intersect),
            StrokeKind::Outer => Some(skia::ClipOp::Difference),
            StrokeKind::Center => None,
        }
    }

    pub fn delta(&self) -> f32 {
        match self.kind {
            StrokeKind::Inner => 0.,
            StrokeKind::Center => self.width,
            StrokeKind::Outer => self.width * 2.,
        }
    }

    pub fn outer_rect(&self, rect: &Rect) -> Rect {
        match (self.kind, self.style) {
            (StrokeKind::Inner, StrokeStyle::Dotted) | (StrokeKind::Outer, StrokeStyle::Dotted) => {
                // Boundary so circles center on it and semicircles match after clipping
                *rect
            }
            _ => match self.kind {
                StrokeKind::Inner => Rect::from_xywh(
                    rect.left + (self.width / 2.),
                    rect.top + (self.width / 2.),
                    rect.width() - self.width,
                    rect.height() - self.width,
                ),
                StrokeKind::Center => {
                    Rect::from_xywh(rect.left, rect.top, rect.width(), rect.height())
                }
                StrokeKind::Outer => Rect::from_xywh(
                    rect.left - (self.width / 2.),
                    rect.top - (self.width / 2.),
                    rect.width() + self.width,
                    rect.height() + self.width,
                ),
            },
        }
    }

    pub fn aligned_rect(&self, rect: &Rect, scale: f32) -> Rect {
        let stroke_rect = self.outer_rect(rect);
        if self.kind != StrokeKind::Center {
            return stroke_rect;
        }

        align_rect_to_half_pixel(&stroke_rect, self.width, scale)
    }

    pub fn outer_corners(&self, corners: &Corners) -> Corners {
        if matches!(self.style, StrokeStyle::Dotted | StrokeStyle::Dashed) {
            // Path at boundary so no corner offset
            return *corners;
        }

        let offset = match self.kind {
            StrokeKind::Center => 0.0,
            StrokeKind::Inner => -self.width / 2.0,
            StrokeKind::Outer => self.width / 2.0,
        };

        let mut outer = *corners;
        for corner in outer.iter_mut() {
            corner.offset((offset, offset))
        }
        outer
    }

    pub fn to_paint(
        &self,
        rect: &Rect,
        svg_attrs: Option<&SvgAttrs>,
        antialias: bool,
    ) -> skia::Paint {
        let mut paint = self.fill.to_paint(rect, antialias);
        paint.set_style(skia::PaintStyle::Stroke);

        let width = match self.kind {
            StrokeKind::Inner => self.width,
            StrokeKind::Center => self.width,
            StrokeKind::Outer => self.width,
        };

        paint.set_stroke_width(width);
        paint.set_anti_alias(antialias);

        // Stroke-level overrides take precedence; otherwise fall back to the
        // shape's SVG attrs. `Butt`/`Miter` map to the Skia defaults.
        let effective_cap = self.dash_cap.or_else(|| svg_attrs.map(|a| a.stroke_linecap));
        match effective_cap {
            Some(StrokeLineCap::Round) => {
                paint.set_stroke_cap(skia::paint::Cap::Round);
            }
            Some(StrokeLineCap::Square) => {
                paint.set_stroke_cap(skia::paint::Cap::Square);
            }
            _ => {} // Butt / None → Skia default
        }

        let effective_join = self.line_join.or_else(|| svg_attrs.map(|a| a.stroke_linejoin));
        match effective_join {
            Some(StrokeLineJoin::Round) => {
                paint.set_stroke_join(skia::paint::Join::Round);
            }
            Some(StrokeLineJoin::Bevel) => {
                paint.set_stroke_join(skia::paint::Join::Bevel);
            }
            _ => {} // Miter / None → Skia default
        }

        if let Some(miter) = self.miter_limit {
            paint.set_stroke_miter(miter);
        }

        if self.style != StrokeStyle::Solid {
            let path_effect = match self.style {
                StrokeStyle::Dotted => {
                    let width = match self.kind {
                        StrokeKind::Inner => self.width,
                        StrokeKind::Center => self.width / 2.0,
                        StrokeKind::Outer => self.width,
                    };
                    let circle_path = {
                        let mut pb = skia::PathBuilder::new();
                        pb.add_circle((0.0, 0.0), width, None);
                        pb.detach()
                    };
                    let advance = self.width + 5.0;
                    skia::PathEffect::path_1d(
                        &circle_path,
                        advance,
                        0.0,
                        skia::path_1d_path_effect::Style::Translate,
                    )
                }
                StrokeStyle::Dashed => {
                    if self.dashes.is_empty() {
                        skia::PathEffect::dash(&[self.width + 10., self.width + 10.], 0.)
                    } else {
                        skia::PathEffect::dash(&self.dashes, 0.)
                    }
                }
                StrokeStyle::Mixed => skia::PathEffect::dash(
                    &[
                        self.width + 5.,
                        self.width + 5.,
                        self.width + 1.,
                        self.width + 5.,
                    ],
                    0.,
                ),
                _ => None,
            };
            paint.set_path_effect(path_effect);
        }

        paint
    }

    pub fn to_stroked_paint(
        &self,
        is_open: bool,
        rect: &Rect,
        svg_attrs: Option<&SvgAttrs>,
        antialias: bool,
    ) -> skia::Paint {
        let mut paint = self.to_paint(rect, svg_attrs, antialias);
        match self.render_kind(is_open) {
            StrokeKind::Inner => {
                paint.set_stroke_width(2. * paint.stroke_width());
            }
            StrokeKind::Center => {}
            StrokeKind::Outer => {
                paint.set_stroke_width(2. * paint.stroke_width());
            }
        }

        paint
    }

    // Render text paths (unused)
    #[allow(dead_code)]
    pub fn to_text_stroked_paint(
        &self,
        is_open: bool,
        rect: &Rect,
        svg_attrs: Option<&SvgAttrs>,
        antialias: bool,
    ) -> skia::Paint {
        let mut paint = self.to_paint(rect, svg_attrs, antialias);
        match self.render_kind(is_open) {
            StrokeKind::Inner => {
                paint.set_stroke_width(2. * paint.stroke_width());
            }
            StrokeKind::Center => {}
            StrokeKind::Outer => {
                paint.set_stroke_width(2. * paint.stroke_width());
            }
        }

        paint
    }

    pub fn is_transparent(&self) -> bool {
        match &self.fill {
            Fill::Solid(SolidColor(color)) => color.a() == 0,
            _ => false,
        }
    }

    pub fn cap_bounds_margin(&self) -> f32 {
        cap_margin_for_cap(self.cap_start, self.width)
            .max(cap_margin_for_cap(self.cap_end, self.width))
    }
}

fn align_rect_to_half_pixel(rect: &Rect, stroke_width: f32, scale: f32) -> Rect {
    if scale <= 0.0 {
        return *rect;
    }

    let stroke_pixels = stroke_width * scale;
    let stroke_pixels_rounded = stroke_pixels.round();
    if !is_close_to(stroke_pixels, stroke_pixels_rounded) {
        return *rect;
    }

    if (stroke_pixels_rounded as i32) % 2 == 0 {
        return *rect;
    }

    let left_px = rect.left * scale;
    let top_px = rect.top * scale;
    let target_frac = 0.5;
    let dx_px = target_frac - (left_px - left_px.floor());
    let dy_px = target_frac - (top_px - top_px.floor());

    if is_close_to(dx_px, 0.0) && is_close_to(dy_px, 0.0) {
        return *rect;
    }

    Rect::from_xywh(
        rect.left + (dx_px / scale),
        rect.top + (dy_px / scale),
        rect.width(),
        rect.height(),
    )
}
fn cap_margin_for_cap(cap: Option<StrokeCap>, width: f32) -> f32 {
    match cap {
        Some(StrokeCap::LineArrow)
        | Some(StrokeCap::TriangleArrow)
        | Some(StrokeCap::SquareMarker)
        | Some(StrokeCap::DiamondMarker) => width * 4.0,
        Some(StrokeCap::CircleMarker) => width * 2.0,
        Some(StrokeCap::Square) => width,
        Some(StrokeCap::Round) => width * 0.5,
        _ => 0.0,
    }
}
