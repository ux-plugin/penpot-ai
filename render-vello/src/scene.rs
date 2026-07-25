//! Renders a backend-neutral [`render_core::model::Scene`] with Vello.
//!
//! This is the second half of the approach-B pipeline. render-wasm's converter
//! (`model_export::node_from_shape`, verified by its own tests) projects Skia `Shape`s into
//! exactly these `render_core::model` types; here we consume the same types and draw them with
//! Vello — no Skia involved. Together the two halves are the end-to-end path
//! `Penpot shape → neutral model → Vello pixels`.
//!
//! Since D12 the model carries kurbo and peniko types directly, so this file has no conversion
//! helpers left: `Affine`, `Rect` and `BezPath` arrive ready to draw. render-core and
//! vello_common resolve to the same kurbo/peniko, so the types unify with no bridging.

use render_core::kurbo::{Affine, BezPath, Ellipse, Rect, Shape as _};
use render_core::model as m;
use render_core::peniko::{Brush, Color};
use vello_example_scenes::{ExampleScene, RenderingContext};

/// A focus scene that draws a neutral model via the backend-agnostic `RenderingContext`.
#[derive(Debug)]
pub struct NeutralModelScene {
    model: m::Scene,
}

impl NeutralModelScene {
    /// Create the scene with a hand-built demo model (using the converter's output types).
    pub fn new() -> Self {
        Self {
            model: demo_model(),
        }
    }
}

impl Default for NeutralModelScene {
    fn default() -> Self {
        Self::new()
    }
}

impl ExampleScene for NeutralModelScene {
    fn render<T: RenderingContext>(
        &mut self,
        ctx: &mut T,
        _resources: &mut T::Resources,
        root: Affine,
    ) {
        for node in &self.model.nodes {
            if node.hidden {
                continue;
            }
            // First solid fill wins. `Brush` also carries gradients and images; those are drawn
            // in a later increment, and need no new model type (D12).
            let Some(color) = node.fills.iter().find_map(|f| match f {
                Brush::Solid(c) => Some(*c),
                _ => None,
            }) else {
                continue;
            };

            ctx.set_transform(root * node.transform);
            ctx.set_paint(color);

            match node.kind {
                m::ShapeKind::Rect => ctx.fill_rect(&node.bounds),
                m::ShapeKind::Circle => ctx.fill_path(&ellipse_path(node.bounds)),
                m::ShapeKind::Path => {
                    if let Some(path) = &node.path {
                        ctx.fill_path(path);
                    }
                }
                _ => {}
            }
        }
    }

    fn status(&self) -> Option<String> {
        Some(format!(
            "neutral model → vello · {} nodes",
            self.model.nodes.len()
        ))
    }
}

fn ellipse_path(r: Rect) -> BezPath {
    Ellipse::new(r.center(), (r.width() * 0.5, r.height() * 0.5), 0.0).to_path(0.1)
}

/// A hand-built neutral scene using the SAME types render-wasm's converter emits: a rect,
/// a circle, and a vector path, each with a solid fill and its own transform.
fn demo_model() -> m::Scene {
    let mut s = m::Scene::new();

    s.push(m::Node {
        id: 1,
        kind: m::ShapeKind::Rect,
        bounds: Rect::new(0.0, 0.0, 160.0, 100.0),
        path: None,
        transform: Affine::translate((40.0, 60.0)),
        fills: vec![Brush::Solid(Color::from_rgba8(56, 152, 236, 255))],
        opacity: 1.0,
        hidden: false,
    });

    s.push(m::Node {
        id: 2,
        kind: m::ShapeKind::Circle,
        bounds: Rect::new(0.0, 0.0, 110.0, 110.0),
        path: None,
        transform: Affine::translate((250.0, 55.0)),
        fills: vec![Brush::Solid(Color::from_rgba8(240, 90, 40, 255))],
        opacity: 1.0,
        hidden: false,
    });

    let mut path = BezPath::new();
    path.move_to((0.0, 0.0));
    path.line_to((120.0, 30.0));
    path.curve_to((90.0, 90.0), (60.0, 120.0), (30.0, 150.0));
    path.line_to((0.0, 60.0));
    path.close_path();

    s.push(m::Node {
        id: 3,
        kind: m::ShapeKind::Path,
        bounds: Rect::new(0.0, 0.0, 120.0, 150.0),
        path: Some(path),
        transform: Affine::translate((430.0, 40.0)),
        fills: vec![Brush::Solid(Color::from_rgba8(70, 190, 120, 255))],
        opacity: 1.0,
        hidden: false,
    });

    s
}
