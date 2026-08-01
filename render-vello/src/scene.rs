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
//!
//! # Two things about the traversal that are easy to get wrong
//!
//! **Parent transforms are not accumulated.** Penpot stores absolute `selrect`s, so a child is
//! already positioned in page space. render-wasm applies `scale · viewport · shape_matrix` from
//! scratch for every shape and never carries a parent CTM down, so composing one here would
//! double-transform everything nested. Containers contribute layers — clip, opacity — and
//! nothing else.
//!
//! **Each shape's matrix is centred on its own bounds**, which is what
//! [`render_core::model::Node::effective_transform`] returns. Using the raw transform makes a
//! rotation orbit the page origin instead of spinning in place, which reads as a shape flying
//! off-screen rather than as a wrong matrix.

use render_core::kurbo::{Affine, BezPath, Ellipse, Rect, RoundedRect, Shape as _};
use render_core::model as m;
use render_core::peniko::{Brush, Color};
use vello_example_scenes::{ExampleScene, RenderingContext};

/// Depth cap for the walk. The tree comes off the wire, and a cycle would otherwise recurse
/// until the wasm stack gives out — a hang rather than a diagnosable failure. Real documents
/// nest an order of magnitude below this.
const MAX_DEPTH: u32 = 128;

/// Flattening tolerance for curves generated here (ellipses, rounded rects), in device pixels.
const TOLERANCE: f64 = 0.1;

/// A focus scene that draws a neutral model via the backend-agnostic `RenderingContext`.
///
/// The model comes from the ABI — whatever the host has sent through `use_shape` and friends.
/// The hand-built [`demo_model`] stands in only while the ABI is empty, so the dev harness has
/// something to show with no host attached.
#[derive(Debug)]
pub struct NeutralModelScene {
    fallback: m::Scene,
}

impl NeutralModelScene {
    pub fn new() -> Self {
        Self {
            fallback: demo_model(),
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
        // The page background, if the host set one. Drawn in canvas space, under everything.
        let background = crate::abi::background();
        if background.components[3] > 0.0 {
            ctx.set_transform(Affine::IDENTITY);
            ctx.set_paint(background);
            ctx.fill_rect(&Rect::new(
                0.0,
                0.0,
                f64::from(ctx.width()),
                f64::from(ctx.height()),
            ));
        }

        crate::abi::with_scene(|live, viewport, modifiers| {
            // `root` is the harness's own pan/zoom; `viewport` is what the host set through
            // `set_view`. They compose — the harness stays at identity when a host is driving.
            let (model, view) = if live.is_empty() {
                (&self.fallback, root)
            } else {
                (live, root * viewport)
            };
            for id in model.roots() {
                draw_node(ctx, model, *id, view, modifiers, 0);
            }
        });
    }

    fn status(&self) -> Option<String> {
        let live = crate::abi::with_scene(|scene, _, _| scene.len());
        let (source, count) = if live == 0 {
            ("demo", self.fallback.len())
        } else {
            ("host", live)
        };
        Some(format!("neutral model → vello · {source} · {count} nodes"))
    }
}

/// Draw one node and its subtree.
///
/// `root` is the viewport matrix and is passed down unchanged — see the module docs on why it is
/// not composed with each node's transform.
fn draw_node<T: RenderingContext>(
    ctx: &mut T,
    scene: &m::Scene,
    id: u128,
    root: Affine,
    modifiers: &crate::abi::Modifiers,
    depth: u32,
) {
    if depth >= MAX_DEPTH {
        return;
    }
    let Some(node) = scene.get(id) else {
        // A container can list a child the host has not sent yet; that is normal mid-sync.
        return;
    };
    if node.hidden {
        return;
    }

    // The gesture transform sits between the viewport and the shape's own matrix: it is
    // expressed in page space, so it must be applied to the shape's page-space geometry and
    // then viewed, not folded into the shape's centred transform.
    //
    // It is *not* inherited down the tree. The host propagates a container's gesture to each
    // descendant explicitly (`propagate_modifiers`), exactly as it does for the committed
    // transforms, which are absolute per shape — inheriting here would apply a group's drag
    // twice to everything inside it.
    let modifier = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
    let matrix = root * modifier * node.effective_transform();

    // Clip and opacity cannot share one layer, because they cover different things.
    //
    // Opacity wraps this node's own paint *and* its children — a half-transparent group must
    // composite as one image, not per child. Clipping covers only the children: render-wasm
    // builds the clip in `get_children_clip_bounds`, and a frame is not clipped by itself
    // (which matters once strokes land, since a stroke straddles the boundary).
    let alpha = (node.opacity < 1.0).then_some(node.opacity);
    if alpha.is_some() {
        ctx.set_transform(matrix);
        ctx.push_layer(None, None, alpha, None, None);
    }

    paint_self(ctx, node, matrix);

    let clip = (node.clip && !node.children.is_empty()).then(|| outline(node));
    if clip.is_some() {
        // The clip path is captured in the transform current at push time, which is this
        // node's — matching render-wasm, where each clip entry carries its own matrix.
        ctx.set_transform(matrix);
        ctx.push_layer(clip.as_ref(), None, None, None, None);
    }

    for child in &node.children {
        draw_node(ctx, scene, *child, root, modifiers, depth + 1);
    }

    if clip.is_some() {
        ctx.pop_layer();
    }
    if alpha.is_some() {
        ctx.pop_layer();
    }
}

/// Paint a node's own geometry, ignoring its children.
fn paint_self<T: RenderingContext>(ctx: &mut T, node: &m::Node, matrix: Affine) {
    // A group has no geometry of its own; it exists to carry the layer.
    if node.kind == m::ShapeKind::Group {
        return;
    }
    if node.fills.is_empty() && node.strokes.is_empty() {
        return;
    }

    ctx.set_transform(matrix);

    // First solid fill wins. `Brush` also carries gradients and images; those are drawn in a
    // later increment, and need no new model type (D12).
    if let Some(color) = node.fills.iter().find_map(|f| match f {
        Brush::Solid(c) => Some(*c),
        _ => None,
    }) {
        ctx.set_paint(color);
        match node.kind {
            // The one case worth a fast path: a square-cornered rect needs no path at all.
            m::ShapeKind::Rect | m::ShapeKind::Frame if node.corners.is_none() => {
                ctx.fill_rect(&node.bounds)
            }
            m::ShapeKind::Path => {
                if let Some(path) = &node.path {
                    ctx.fill_path(path);
                }
            }
            _ => ctx.fill_path(&outline(node)),
        }
    }

    // Strokes go over the fills, back to front. They are drawn on this node's own outline —
    // a frame's stroke straddles its edge and is *not* clipped by the frame's own clip, which
    // is why clip and opacity take separate layers in `draw_node`.
    if node.strokes.is_empty() {
        return;
    }
    let path = outline(node);
    for stroke in &node.strokes {
        let Brush::Solid(color) = &stroke.brush else {
            continue;
        };
        ctx.set_paint(*color);
        ctx.set_stroke(stroke.style.clone());
        ctx.stroke_path(&path);
    }
}

/// The node's geometry as a path — what it fills, and what it clips its children to.
///
/// Mirrors render-wasm's clip construction: a rounded rect when corners are set, an oval for a
/// circle, the vector path for a path, and the bounds rectangle for anything else (including a
/// path whose geometry has not arrived).
fn outline(node: &m::Node) -> BezPath {
    match node.kind {
        m::ShapeKind::Circle => ellipse_path(node.bounds),
        m::ShapeKind::Path => node
            .path
            .clone()
            .unwrap_or_else(|| node.bounds.to_path(TOLERANCE)),
        _ => match node.corners {
            Some(radii) => RoundedRect::from_rect(node.bounds, radii).to_path(TOLERANCE),
            None => node.bounds.to_path(TOLERANCE),
        },
    }
}

fn ellipse_path(r: Rect) -> BezPath {
    Ellipse::new(r.center(), (r.width() * 0.5, r.height() * 0.5), 0.0).to_path(TOLERANCE)
}

/// A hand-built neutral scene using the SAME types render-wasm's converter emits, now as a tree:
/// a clipping frame whose children overflow it, and a half-transparent group over a path.
///
/// Every element here is a traversal assertion you can check by looking:
/// - the frame's radii are **asymmetric**, so a reordering shows as the wrong corner rounding;
/// - both its children **overflow** it, so a lost clip shows as spill;
/// - the white rect is **rotated**, so a missing centre-conjugation throws it out of the frame
///   entirely rather than tilting it in place;
/// - the group is **half-transparent**, so an alpha applied per-node instead of per-subtree
///   shows as a fully saturated path.
fn demo_model() -> m::Scene {
    let mut s = m::Scene::new();

    let mut root = m::Node::new(m::ROOT_ID, m::ShapeKind::Group);
    root.children = vec![1, 5];
    s.insert(root);

    let mut frame = m::Node::new(1, m::ShapeKind::Frame);
    frame.bounds = Rect::new(120.0, 180.0, 720.0, 600.0);
    frame.corners = Some(render_core::kurbo::RoundedRectRadii::new(
        72.0, 12.0, 72.0, 12.0,
    ));
    frame.fills = vec![Brush::Solid(Color::from_rgba8(56, 152, 236, 255))];
    // A dashed stroke, straddling the frame's edge. It must *not* be clipped by the frame's own
    // clip — that is why clip and opacity take separate layers — so half of it sits outside.
    let mut frame_stroke = render_core::kurbo::Stroke::new(12.0);
    render_core::model::apply_stroke_style(
        &mut frame_stroke,
        render_core::model::StrokeStyle::Dashed,
        12.0,
        &[],
    );
    frame.strokes = vec![m::Stroke {
        style: frame_stroke,
        brush: Brush::Solid(Color::from_rgba8(255, 255, 255, 255)),
    }];
    frame.clip = true;
    frame.children = vec![2, 3];
    s.insert(frame);

    let mut circle = m::Node::new(2, m::ShapeKind::Circle);
    circle.bounds = Rect::new(540.0, 420.0, 870.0, 750.0);
    circle.fills = vec![Brush::Solid(Color::from_rgba8(240, 90, 40, 255))];
    s.insert(circle);

    let mut rect = m::Node::new(3, m::ShapeKind::Rect);
    rect.bounds = Rect::new(180.0, 240.0, 420.0, 360.0);
    rect.transform = Affine::rotate(0.3);
    rect.fills = vec![Brush::Solid(Color::from_rgba8(250, 250, 250, 255))];
    // A dotted stroke: kurbo has no `path_1d` equivalent, so it is a zero-length dash with
    // round caps, which draws dots of diameter equal to the width — the same as Skia's circles.
    let mut dots = render_core::kurbo::Stroke::new(6.0);
    render_core::model::apply_stroke_style(
        &mut dots,
        render_core::model::StrokeStyle::Dotted,
        6.0,
        &[],
    );
    rect.strokes = vec![m::Stroke {
        style: dots,
        brush: Brush::Solid(Color::from_rgba8(20, 20, 20, 255)),
    }];
    s.insert(rect);

    let mut group = m::Node::new(5, m::ShapeKind::Group);
    group.opacity = 0.5;
    group.children = vec![6];
    s.insert(group);

    let mut path = BezPath::new();
    path.move_to((0.0, 0.0));
    path.line_to((360.0, 90.0));
    path.curve_to((270.0, 270.0), (180.0, 360.0), (90.0, 450.0));
    path.line_to((0.0, 180.0));
    path.close_path();

    let mut path_node = m::Node::new(6, m::ShapeKind::Path);
    path_node.bounds = Rect::new(0.0, 0.0, 360.0, 450.0);
    path_node.path = Some(path);
    path_node.transform = Affine::translate((860.0, 160.0));
    path_node.fills = vec![Brush::Solid(Color::from_rgba8(70, 190, 120, 255))];
    s.insert(path_node);

    s
}
