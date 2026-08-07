//! R1 viability spike: `RenderingContext` for classic `vello::Scene`.
//!
//! `scene.rs` (the neutral model → GPU-scene translation) is written against the
//! [`RenderingContext`] trait, not a concrete `Scene`. vello_hybrid and vello_cpu implement it; this
//! proves classic `vello` can too — which is the make-or-break for reusing the whole draw path on a
//! third, compute-based backend (see `render-vello/docs/classic-vello-backend-plan.md`).
//!
//! The trait is *stateful* (`set_transform`, `set_paint`, then `fill_path`); classic `vello::Scene`
//! is *immediate* (`fill(rule, transform, brush, …)`). So this is a wrapper, [`ClassicCtx`], that
//! accumulates the pen state and flushes it on each draw. The core paint path (fills, strokes, paths,
//! rects, layers) maps cleanly; the pieces that are a later slice on classic — text (needs a glifo
//! backend bridging to `draw_glyphs`), blurred-rect drop shadows, filter layers (effects route
//! through our own `run_graph` instead), and external-texture images — are stubbed here and called
//! out as the Phase-2 work items. The spike's job is to show the *shape* holds and compiles.

use glifo::{Glyph, GlyphRun, GlyphRunBackend, GlyphRunBuilder};
use std::ops::RangeInclusive;
use vello_common::filter_effects::Filter;
use vello_common::kurbo::Affine;
use vello_example_scenes::{
    BezPath, BlendMode, Fill, FontData, ImageQuality, Mask, PaintType, Rect, RenderingContext,
    SampleRect, Stroke, TextureId,
};

/// Stateful adapter: a classic `vello::Scene` plus the pen state the immediate-mode API needs
/// supplied per call. One of these is built per surface the sink rasterizes.
pub struct ClassicCtx {
    scene: vello::Scene,
    width: u16,
    height: u16,
    transform: Affine,
    paint_transform: Affine,
    fill_rule: Fill,
    /// Solid paint only, for the spike. A gradient/image paint records `None` and draws nothing —
    /// the full `PaintType` → `peniko` brush mapping is Phase-2 work.
    solid: Option<vello_common::peniko::Color>,
    stroke: Stroke,
}

impl ClassicCtx {
    /// A fresh context over a new `width × height` scene.
    #[must_use]
    pub fn new(width: u16, height: u16) -> Self {
        Self {
            scene: vello::Scene::new(),
            width,
            height,
            transform: Affine::IDENTITY,
            paint_transform: Affine::IDENTITY,
            fill_rule: Fill::NonZero,
            solid: None,
            stroke: Stroke::default(),
        }
    }

    /// The built scene, to hand to `vello::Renderer::render_to_texture`.
    #[must_use]
    pub fn scene(&self) -> &vello::Scene {
        &self.scene
    }

    /// The current solid brush, defaulting to opaque black so a missing/unsupported paint still draws
    /// something visible in the spike rather than nothing.
    fn brush(&self) -> vello_common::peniko::Color {
        self.solid.unwrap_or(vello_common::color::palette::css::BLACK)
    }
}

/// Glyph backend stub. Classic vello draws text through its own skrifa `draw_glyphs`, not a glifo
/// backend, so bridging glifo → classic is its own slice; the spike only needs the type to line up.
pub struct ClassicGlyphBackend<'a> {
    _scene: &'a mut vello::Scene,
}

impl<'a> GlyphRunBackend<'a> for ClassicGlyphBackend<'a> {
    fn atlas_cache(self, _enabled: bool) -> Self {
        self
    }
    fn fill_glyphs<G>(self, _run: GlyphRun<'a>, _glyphs: G)
    where
        G: Iterator<Item = Glyph> + Clone,
    {
        todo!("classic-vello text: bridge glifo glyph runs to vello::Scene::draw_glyphs (Phase 2)")
    }
    fn stroke_glyphs<G>(self, _run: GlyphRun<'a>, _glyphs: G)
    where
        G: Iterator<Item = Glyph> + Clone,
    {
        todo!("classic-vello text (Phase 2)")
    }
    fn render_decoration<G>(
        self,
        _run: GlyphRun<'a>,
        _glyphs: G,
        _x_range: RangeInclusive<f32>,
        _baseline_y: f32,
        _offset: f32,
        _size: f32,
        _buffer: f32,
    ) where
        G: Iterator<Item = Glyph> + Clone,
    {
        todo!("classic-vello text decorations (Phase 2)")
    }
}

impl RenderingContext for ClassicCtx {
    type Resources = ();
    type GlyphRunBackend<'a> = ClassicGlyphBackend<'a>;

    fn width(&self) -> u16 {
        self.width
    }
    fn height(&self) -> u16 {
        self.height
    }

    fn set_transform(&mut self, transform: Affine) {
        self.transform = transform;
    }
    fn set_paint_transform(&mut self, transform: Affine) {
        self.paint_transform = transform;
    }
    fn set_fill_rule(&mut self, fill_rule: Fill) {
        self.fill_rule = fill_rule;
    }
    fn set_paint(&mut self, paint: impl Into<PaintType>) {
        // PaintType is `peniko::Brush<Image, Gradient>`; the spike keeps only the solid case.
        self.solid = match paint.into() {
            vello_common::peniko::Brush::Solid(color) => Some(color),
            _ => None,
        };
    }
    fn set_stroke(&mut self, stroke: Stroke) {
        self.stroke = stroke;
    }

    // Effects do not go through the Scene on classic — the sink runs blur/glass/shadow/custom through
    // our own `run_graph` — so the filter hooks are inert here.
    fn set_filter_effect(&mut self, _filter: Filter) {}
    fn reset_filter_effect(&mut self) {}
    fn push_filter_layer(&mut self, _filter: Filter) {}

    fn fill_path(&mut self, path: &BezPath) {
        let brush = self.brush();
        let pt = (self.paint_transform != Affine::IDENTITY).then_some(self.paint_transform);
        self.scene.fill(self.fill_rule, self.transform, brush, pt, path);
    }
    fn stroke_path(&mut self, path: &BezPath) {
        let brush = self.brush();
        let pt = (self.paint_transform != Affine::IDENTITY).then_some(self.paint_transform);
        self.scene.stroke(&self.stroke, self.transform, brush, pt, path);
    }
    fn fill_rect(&mut self, rect: &Rect) {
        let brush = self.brush();
        self.scene.fill(self.fill_rule, self.transform, brush, None, rect);
    }

    fn fill_blurred_rounded_rect(&mut self, _rect: &Rect, _radius: f32, _std_dev: f32) {
        // Sparse-strips convenience for drop shadows; on classic these route through our own blur in
        // `run_graph`. Phase 2 either emulates it or drops the call at the sink.
        todo!("classic-vello blurred rounded rect (drop-shadow) — route via run_graph (Phase 2)")
    }

    fn glyph_run<'a>(
        &'a mut self,
        _resources: &'a mut Self::Resources,
        font: &FontData,
    ) -> GlyphRunBuilder<'a, Self::GlyphRunBackend<'a>> {
        let (t, pt) = (self.transform, self.paint_transform);
        GlyphRunBuilder::new(font.clone(), t, pt, ClassicGlyphBackend { _scene: &mut self.scene })
    }

    fn push_clip_layer(&mut self, path: &BezPath) {
        self.scene.push_layer(Fill::NonZero, BlendMode::default(), 1.0, self.transform, path);
    }
    fn push_clip_path(&mut self, path: &BezPath) {
        // No standalone clip-path stack on classic; model it as a clip layer.
        self.scene.push_layer(Fill::NonZero, BlendMode::default(), 1.0, self.transform, path);
    }
    fn push_layer(
        &mut self,
        clip: Option<&BezPath>,
        blend_mode: Option<BlendMode>,
        alpha: Option<f32>,
        _mask: Option<Mask>,
        _filter: Option<Filter>,
    ) {
        let blend = blend_mode.unwrap_or_default();
        let alpha = alpha.unwrap_or(1.0);
        match clip {
            Some(path) => self.scene.push_layer(Fill::NonZero, blend, alpha, self.transform, path),
            None => {
                // An unclipped layer: clip to a rect large enough to cover any surface, at identity.
                let full = Rect::new(-1.0e6, -1.0e6, 1.0e6, 1.0e6);
                self.scene.push_layer(Fill::NonZero, blend, alpha, Affine::IDENTITY, &full);
            }
        }
    }
    fn pop_layer(&mut self) {
        self.scene.pop_layer();
    }
    fn pop_clip_path(&mut self) {
        self.scene.pop_layer();
    }

    fn draw_texture_rects(
        &mut self,
        _texture_id: TextureId,
        _quality: ImageQuality,
        _rects: impl IntoIterator<Item = SampleRect>,
    ) {
        // Externally-bound textures are a hybrid capability (the trait leaks its TextureId/SampleRect
        // here). Classic uploads images through vello's own image path — a later slice; unadvertised.
        unimplemented!("classic-vello external textures are not supported")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The whole point of the spike: the impl exists and a scene can be driven through the trait
    // exactly as `scene.rs` would, with no GPU. If this compiles and runs, R1's core is proven.
    #[test]
    fn a_scene_can_be_driven_through_the_rendering_context_trait() {
        fn draw<C: RenderingContext>(ctx: &mut C) {
            // A solid rect...
            ctx.set_fill_rule(Fill::NonZero);
            ctx.set_transform(Affine::translate((10.0, 10.0)));
            ctx.set_paint(vello_common::peniko::Brush::Solid(
                vello_common::color::palette::css::REBECCA_PURPLE,
            ));
            ctx.fill_rect(&Rect::new(0.0, 0.0, 40.0, 40.0));
            // ...inside an isolating layer (a group), the PushLayer/PopLayer the schedule emits.
            ctx.push_layer(None, Some(BlendMode::default()), Some(0.5), None, None);
            let mut path = BezPath::new();
            path.move_to((0.0, 0.0));
            path.line_to((30.0, 0.0));
            path.line_to((30.0, 30.0));
            path.close_path();
            ctx.fill_path(&path);
            ctx.pop_layer();
        }

        let mut ctx = ClassicCtx::new(256, 256);
        draw(&mut ctx);
        // A non-empty scene came out the other side.
        assert_eq!(ctx.width(), 256);
        assert!(ctx.scene().encoding().n_paths > 0, "expected encoded paths in the classic scene");
    }
}
