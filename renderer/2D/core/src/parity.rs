//! The **parity scene** fixture: one document that exercises every feature the neutral model can
//! express, laid out as a labelled grid so the whole Skia→vello parity surface is visible at once.
//!
//! It lives in render-core (model-only, no GPU) so every render path shares one source of truth: the
//! native tree-walk example (`vello-gpu-renderer/examples/parity_scene.rs`), the wasm ABI's
//! `load_parity_scene` (rendered through the full scheduler sink, where **gather** effects — glass,
//! background blur, and the *scoped* variants below — actually execute), and, later, a Skia-side
//! build of the same feature list for a true pixel-diff.
//!
//! Some gaps (inner/outer stroke alignment, boolean geometry) live at the ABI→model *projection*, not
//! in the neutral model, so they cannot appear here — they need an ABI-level harness.

use kurbo::{BezPath, Rect, RoundedRectRadii, Vec2};

use crate::model::{
    Brush, FilterGraph, FilterNode, Glass, ImageFill, Node, Paint, Scene, Shadow, ShapeKind, Stroke, StrokeAlign,
    TileMode, ROOT_ID,
};

/// Grid columns.
pub const COLS: usize = 6;
/// Cell pitch, page units.
pub const CELL: f64 = 190.0;
/// Outer margin.
pub const MARGIN: f64 = 26.0;
/// Inner padding inside each cell.
pub const PAD: f64 = 22.0;

fn col(r: u8, g: u8, b: u8) -> peniko::Color {
    peniko::Color::from_rgba8(r, g, b, 255)
}
fn cola(r: u8, g: u8, b: u8, a: u8) -> peniko::Color {
    peniko::Color::from_rgba8(r, g, b, a)
}

fn linear() -> Brush {
    let stops = [
        peniko::ColorStop { offset: 0.0, color: col(232, 66, 66).into() },
        peniko::ColorStop { offset: 1.0, color: col(54, 102, 214).into() },
    ];
    Brush::Gradient(peniko::Gradient::new_linear((0.0, 0.0), (1.0, 0.0)).with_stops(&stops[..]))
}
fn radial() -> Brush {
    let stops = [
        peniko::ColorStop { offset: 0.0, color: col(250, 210, 80).into() },
        peniko::ColorStop { offset: 1.0, color: col(186, 60, 30).into() },
    ];
    Brush::Gradient(peniko::Gradient::new_radial((0.5, 0.5), 0.5).with_stops(&stops[..]))
}
fn angular() -> Brush {
    let stops = [
        peniko::ColorStop { offset: 0.0, color: col(29, 158, 117).into() },
        peniko::ColorStop { offset: 0.5, color: col(84, 74, 183).into() },
        peniko::ColorStop { offset: 1.0, color: col(29, 158, 117).into() },
    ];
    Brush::Gradient(peniko::Gradient::new_sweep((0.5, 0.5), 0.0, std::f32::consts::TAU).with_stops(&stops[..]))
}

/// A tuned frosted-glass lens, for the glass cells.
fn glass_lens(tile_mode: TileMode) -> Glass {
    Glass {
        surface_type: 1,
        bezel_width: 12.0,
        thickness: 1.2,
        refractive_index: 1.5,
        specular_angle: 0.7,
        specular_opacity: 0.5,
        specular_saturation: 1.0,
        chromatic_aberration: 0.3,
        splay: 0.0,
        tilt_angle: 0.0,
        edge_boost: 0.2,
        // Neutral zoom = 1.0 (the frontend's "100% = no zoom", `zoom/100`). 0.0 is NOT neutral: the
        // field's `1/max(zoom,0.1) - 1` turns it into a 9× magnification that shoves interior samples
        // ~1000px away — invisible over a uniform backdrop, but it drags a scoped lens's content
        // (e.g. B1 over B's teal) off and bleeds the surrounding gradient in.
        zoom: 1.0,
        blur: 2.0,
        frost: 0.2,
        acceptable_downscale: 1.0,
        tile_mode,
    }
}

/// A thin dashed cyan outline, used to mark where a lens sits in the no-lens scope view.
fn outline_stroke() -> Stroke {
    Stroke {
        style: kurbo::Stroke::new(2.0).with_dashes(0.0, [10.0, 8.0]),
        paint: Paint::plain(Brush::Solid(col(60, 220, 235))),
        align: StrokeAlign::Center,
    }
}

/// A thin solid border for a scope-test frame, so the container stays visible even with its fill
/// removed (the no-backdrop view).
fn frame_border(color: peniko::Color) -> Stroke {
    Stroke { style: kurbo::Stroke::new(3.0), paint: Paint::plain(Brush::Solid(color)), align: StrokeAlign::Center }
}

/// Attach the chosen scope-test effect to a lens node, with the given past-scope tile mode.
fn apply_scope_lens(node: &mut Node, lens: ScopeLens, tile_mode: TileMode) {
    match lens {
        ScopeLens::Glass => node.glass = Some(glass_lens(tile_mode)),
        ScopeLens::Blur => node.background_blur = Some(24.0),
        ScopeLens::Outline => node.strokes = vec![outline_stroke()],
    }
}

/// Incrementally builds the scene, assigning ids and tracking top-level z-order + a cell legend.
struct Build {
    scene: Scene,
    next: u128,
    roots: Vec<u128>,
    cell: usize,
    legend: Vec<(usize, &'static str)>,
}

impl Build {
    fn new() -> Self {
        Self { scene: Scene::new(), next: 1, roots: Vec::new(), cell: 0, legend: Vec::new() }
    }
    fn id(&mut self) -> u128 {
        let i = self.next;
        self.next += 1;
        i
    }
    /// The inner rect of the current cell.
    fn rect(&self) -> Rect {
        let (row, c) = (self.cell / COLS, self.cell % COLS);
        let x0 = MARGIN + c as f64 * CELL + PAD;
        let y0 = MARGIN + row as f64 * CELL + PAD;
        Rect::new(x0, y0, x0 + CELL - 2.0 * PAD, y0 + CELL - 2.0 * PAD)
    }
    fn advance(&mut self, label: &'static str) {
        self.legend.push((self.cell, label));
        self.cell += 1;
    }
    fn root(&mut self, node: Node) -> u128 {
        let id = node.id;
        self.scene.insert(node);
        self.roots.push(id);
        id
    }
    fn child(&mut self, node: Node) {
        self.scene.insert(node);
    }
    fn finish(mut self) -> (Scene, Vec<(usize, &'static str)>) {
        let mut root = Node::new(ROOT_ID, ShapeKind::Group);
        root.children = std::mem::take(&mut self.roots);
        self.scene.insert(root);
        (self.scene, self.legend)
    }

    fn fill_cell(&mut self, brush: Brush, label: &'static str) {
        let r = self.rect();
        let id = self.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = r;
        n.fills = vec![Paint::plain(brush)];
        self.root(n);
        self.advance(label);
    }
}

/// The parity scene and its cell legend (`cell index → feature name`).
#[must_use]
pub fn build_parity_scene() -> (Scene, Vec<(usize, &'static str)>) {
    let mut b = Build::new();

    // ── Fills ──────────────────────────────────────────────────────────────────
    b.fill_cell(Brush::Solid(col(54, 102, 214)), "solid fill");
    b.fill_cell(linear(), "linear gradient");
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Circle);
        n.bounds = r;
        n.fills = vec![Paint::plain(radial())];
        b.root(n);
        b.advance("radial gradient");
    }
    b.fill_cell(angular(), "angular gradient");
    {
        // Three stacked fills: an opaque yellow base with two translucent layers over it. `fills[0]`
        // is on top (render-wasm order), so the blue tints the red tints the yellow — visibly warm.
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = r;
        n.fills = vec![
            Paint::plain(Brush::Solid(cola(54, 102, 214, 130))),
            Paint::plain(Brush::Solid(cola(232, 66, 66, 150))),
            Paint::plain(Brush::Solid(col(240, 200, 40))),
        ];
        b.root(n);
        b.advance("multi-fill (3 layers)");
    }
    {
        // GAP (classic native): image resolves to None → blank.
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = r;
        n.fills = vec![Paint::plain(Brush::Image(ImageFill {
            id: 0xB0_0B,
            width: 64,
            height: 64,
            opacity: 255,
            keep_aspect: true,
            dest: None,
        }))];
        b.root(n);
        b.advance("image fill [GAP]");
    }

    // ── Shapes & corners ───────────────────────────────────────────────────────
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = r;
        n.corners = Some(RoundedRectRadii::from_single_radius(22.0));
        n.fills = vec![Paint::plain(Brush::Solid(col(84, 74, 183)))];
        b.root(n);
        b.advance("rounded (uniform)");
    }
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = r;
        n.corners = Some(RoundedRectRadii::new(4.0, 30.0, 4.0, 30.0));
        n.fills = vec![Paint::plain(Brush::Solid(col(29, 158, 117)))];
        b.root(n);
        b.advance("per-corner radii");
    }
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Circle);
        n.bounds = r;
        n.fills = vec![Paint::plain(Brush::Solid(col(216, 90, 48)))];
        b.root(n);
        b.advance("circle");
    }
    {
        let r = b.rect();
        let mut p = BezPath::new();
        p.move_to((r.x0, r.y1));
        p.line_to((r.center().x, r.y0));
        p.line_to((r.x1, r.y1));
        p.curve_to((r.center().x + 20.0, r.center().y), (r.center().x - 20.0, r.center().y), (r.x0, r.y1));
        p.close_path();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Path);
        n.bounds = r;
        n.path = Some(p);
        n.fills = vec![Paint::plain(Brush::Solid(col(84, 74, 183)))];
        b.root(n);
        b.advance("bezier path");
    }

    // ── Strokes (centre strokes only in the neutral model) ───────────────────────
    let stroked = |b: &mut Build, style: kurbo::Stroke, label: &'static str, fill: Option<peniko::Color>| {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = r;
        if let Some(f) = fill {
            n.fills = vec![Paint::plain(Brush::Solid(f))];
        }
        n.strokes = vec![Stroke { style, paint: Paint::plain(Brush::Solid(col(30, 30, 40))), align: StrokeAlign::Center }];
        b.root(n);
        b.advance(label);
    };
    stroked(&mut b, kurbo::Stroke::new(6.0), "stroke solid", Some(col(220, 224, 232)));
    {
        let mut s = kurbo::Stroke::new(6.0);
        s.dash_pattern = [16.0, 10.0].into_iter().collect();
        stroked(&mut b, s, "stroke dashed", Some(col(220, 224, 232)));
    }
    {
        let mut s = kurbo::Stroke::new(6.0);
        s.dash_pattern = [0.01, 11.0].into_iter().collect();
        s.start_cap = kurbo::Cap::Round;
        s.end_cap = kurbo::Cap::Round;
        stroked(&mut b, s, "stroke dotted", Some(col(220, 224, 232)));
    }
    {
        let mut s = kurbo::Stroke::new(14.0);
        s.join = kurbo::Join::Round;
        s.start_cap = kurbo::Cap::Round;
        s.end_cap = kurbo::Cap::Round;
        stroked(&mut b, s, "thick round join", None);
    }
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = r;
        n.strokes = vec![Stroke { style: kurbo::Stroke::new(10.0), paint: Paint::plain(linear()), align: StrokeAlign::Center }];
        b.root(n);
        b.advance("gradient stroke");
    }
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = r;
        n.strokes = vec![
            Stroke { style: kurbo::Stroke::new(12.0), paint: Paint::plain(Brush::Solid(col(40, 44, 60))), align: StrokeAlign::Center },
            Stroke { style: kurbo::Stroke::new(4.0), paint: Paint::plain(Brush::Solid(col(240, 200, 40))), align: StrokeAlign::Center },
        ];
        b.root(n);
        b.advance("multiple strokes");
    }

    // Inner/outer alignment: a fat stroke on a filled rect makes the alignment obvious — an inner
    // stroke sits entirely inside the box edge (fill still visible as a border), an outer stroke
    // sits entirely outside it (box grows by the stroke width). Centre would straddle the edge.
    let aligned = |b: &mut Build, align: StrokeAlign, label: &'static str| {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        // Inset the box so an outer stroke has room to paint without clipping against the cell edge.
        n.bounds = Rect::new(r.x0 + 12.0, r.y0 + 12.0, r.x1 - 12.0, r.y1 - 12.0);
        n.fills = vec![Paint::plain(Brush::Solid(col(232, 200, 96)))];
        // Miter join + butt caps to match the wire's Skia defaults (`add_shape_*_stroke`), so the
        // aligned corners read as sharp rather than kurbo's default round.
        let style = kurbo::Stroke::new(16.0)
            .with_join(kurbo::Join::Miter)
            .with_caps(kurbo::Cap::Butt);
        n.strokes = vec![Stroke { style, paint: Paint::plain(Brush::Solid(col(40, 44, 60))), align }];
        b.root(n);
        b.advance(label);
    };
    aligned(&mut b, StrokeAlign::Inner, "inner stroke");
    aligned(&mut b, StrokeAlign::Outer, "outer stroke");

    // ── Effects (spread — render in the tree walk) ───────────────────────────────
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = Rect::new(r.x0 + 10.0, r.y0 + 10.0, r.x1 - 10.0, r.y1 - 10.0);
        n.corners = Some(RoundedRectRadii::from_single_radius(10.0));
        n.fills = vec![Paint::plain(Brush::Solid(col(240, 244, 250)))];
        n.shadows = vec![Shadow { color: cola(0, 0, 0, 150), blur: 10.0, spread: 0.0, offset: Vec2::new(4.0, 6.0), inset: false }];
        b.root(n);
        b.advance("drop shadow");
    }
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = r;
        n.corners = Some(RoundedRectRadii::from_single_radius(10.0));
        n.fills = vec![Paint::plain(Brush::Solid(col(210, 216, 226)))];
        n.shadows = vec![Shadow { color: cola(0, 0, 0, 170), blur: 8.0, spread: 0.0, offset: Vec2::new(3.0, 4.0), inset: true }];
        b.root(n);
        b.advance("inner shadow");
    }
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = r;
        n.fills = vec![Paint::plain(linear())];
        n.blur = Some(6.0);
        b.root(n);
        b.advance("layer blur");
    }
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = r;
        n.fills = vec![Paint::plain(Brush::Solid(col(216, 90, 48)))];
        n.filter_graph = Some(FilterGraph { nodes: vec![FilterNode::Blur { sigma: 3.0 }, FilterNode::Offset { dx: 6.0, dy: 6.0 }] });
        b.root(n);
        b.advance("filter graph");
    }

    // ── Backdrop effects (GATHER — need the sink; blank in the tree walk) ─────────
    b.backdrop_cell(false, "backdrop blur [sink]");
    b.backdrop_cell(true, "glass [sink]");

    // ── Compositing (classic leaf-blend/opacity gaps show here) ──────────────────
    {
        let r = b.rect();
        let bid = b.id();
        let mut backdrop = Node::new(bid, ShapeKind::Rect);
        backdrop.bounds = r;
        backdrop.fills = vec![Paint::plain(Brush::Solid(col(240, 200, 40)))];
        b.root(backdrop);
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = Rect::new(r.x0 + 14.0, r.y0 + 14.0, r.x1, r.y1);
        n.fills = vec![Paint::plain(Brush::Solid(col(54, 102, 214)))];
        n.blend = peniko::BlendMode::new(peniko::Mix::Multiply, peniko::Compose::SrcOver);
        b.root(n);
        b.advance("blend multiply");
    }
    {
        let r = b.rect();
        let bid = b.id();
        let mut backdrop = Node::new(bid, ShapeKind::Rect);
        backdrop.bounds = r;
        backdrop.fills = vec![Paint::plain(Brush::Solid(col(29, 158, 117)))];
        b.root(backdrop);
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = Rect::new(r.x0 + 14.0, r.y0 + 14.0, r.x1, r.y1);
        n.fills = vec![Paint::plain(Brush::Solid(col(216, 48, 90)))];
        n.opacity = 0.5;
        b.root(n);
        b.advance("leaf opacity");
    }
    {
        let r = b.rect();
        let fid = b.id();
        let cid = b.id();
        let mut frame = Node::new(fid, ShapeKind::Frame);
        frame.bounds = r;
        frame.clip = true;
        frame.corners = Some(RoundedRectRadii::from_single_radius(14.0));
        frame.fills = vec![Paint::plain(Brush::Solid(col(235, 238, 244)))];
        frame.children = vec![cid];
        b.root(frame);
        let mut kid = Node::new(cid, ShapeKind::Rect);
        kid.bounds = Rect::new(r.x0 - 30.0, r.y0 - 30.0, r.center().x + 20.0, r.center().y + 20.0);
        kid.fills = vec![Paint::plain(Brush::Solid(col(216, 90, 48)))];
        b.child(kid);
        b.advance("clip frame");
    }
    {
        let r = b.rect();
        let gid = b.id();
        let mask_id = b.id();
        let content_id = b.id();
        let mut group = Node::new(gid, ShapeKind::Group);
        group.masked = true;
        group.children = vec![mask_id, content_id];
        b.root(group);
        let mut mask = Node::new(mask_id, ShapeKind::Circle);
        mask.bounds = r;
        mask.fills = vec![Paint::plain(Brush::Solid(col(0, 0, 0)))];
        b.child(mask);
        let mut content = Node::new(content_id, ShapeKind::Rect);
        content.bounds = r;
        content.fills = vec![Paint::plain(angular())];
        b.child(content);
        b.advance("masked (opaque circle)");
    }
    {
        // Soft mask: the mask rect's fill is a horizontal alpha ramp (opaque → transparent), so the
        // solid content fades left→right — a true `DstIn` alpha mask, which a hard silhouette clip
        // cannot express.
        let r = b.rect();
        let gid = b.id();
        let mask_id = b.id();
        let content_id = b.id();
        let mut group = Node::new(gid, ShapeKind::Group);
        group.masked = true;
        group.children = vec![mask_id, content_id];
        b.root(group);
        let ramp = [
            peniko::ColorStop { offset: 0.0, color: cola(255, 255, 255, 255).into() },
            peniko::ColorStop { offset: 1.0, color: cola(255, 255, 255, 0).into() },
        ];
        let mut mask = Node::new(mask_id, ShapeKind::Rect);
        mask.bounds = r;
        mask.fills = vec![Paint::plain(Brush::Gradient(
            peniko::Gradient::new_linear((0.0, 0.0), (1.0, 0.0)).with_stops(&ramp[..]),
        ))];
        b.child(mask);
        let mut content = Node::new(content_id, ShapeKind::Rect);
        content.bounds = r;
        content.fills = vec![Paint::plain(Brush::Solid(col(216, 90, 48)))];
        b.child(content);
        b.advance("soft mask (alpha ramp)");
    }
    {
        // Boolean shapes are a *precomputed path* by the time they reach a renderer (render-wasm's
        // `math::bools` unions/subtracts the children into one `Path`, stored on the shape; the vello
        // side receives that path). So a boolean renders exactly like a `Path` — here the union of two
        // overlapping rects, whose outline is an authored L-shape (an exact union result), proving the
        // boolean *result* draws. The projection `Type::Bool → Path(bool.path)` (model_export) is the
        // matching render-wasm→neutral bridge.
        let r = b.rect();
        let (a, c) = (0.30, 0.70); // overlap split
        let ax = r.x0 + (r.x1 - r.x0) * a;
        let cy = r.y0 + (r.y1 - r.y0) * c;
        let mut p = BezPath::new();
        p.move_to((r.x0, r.y0));
        p.line_to((ax, r.y0));
        p.line_to((ax, cy));
        p.line_to((r.x1, cy));
        p.line_to((r.x1, r.y1));
        p.line_to((r.x0, r.y1));
        p.close_path();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Path);
        n.bounds = r;
        n.path = Some(p);
        n.fills = vec![Paint::plain(Brush::Solid(col(200, 60, 60)))];
        b.root(n);
        b.advance("boolean (union path)");
    }
    {
        // Raw SVG: a few primitives (circle, stroked rounded rect, translucent triangle) parsed by
        // usvg and drawn through the shared RenderingContext, scaled into the cell bounds.
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Svg);
        n.bounds = r;
        n.svg = Some(
            r##"<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                 <circle cx="38" cy="40" r="30" fill="#3b82f6"/>
                 <rect x="44" y="44" width="44" height="44" rx="8" fill="#ef4444" stroke="#1f2937" stroke-width="5"/>
                 <path d="M12 88 L46 24 L80 88 Z" fill="#22c55e" fill-opacity="0.7"/>
               </svg>"##
                .to_string(),
        );
        b.root(n);
        b.advance("svg-raw");
    }

    // ── Scoped backdrop effects: a gather inside a clipping Frame reads only the FRAME's content,
    //    not the whole page — the scheduler's ScopeOf surface. These exercise the scoped-gather path
    //    (distinct from the page-scoped gathers above). Each frame holds a colourful backdrop child
    //    plus a lens child that reads it.
    b.scoped_backdrop_cell(false, "scoped backdrop-blur [sink]");
    b.scoped_backdrop_cell(true, "scoped glass [sink]");

    b.finish()
}

/// Canvas size for [`build_showcase_scene`], page units.
pub const SHOWCASE_W: f64 = 1200.0;
/// Canvas size for [`build_showcase_scene`], page units.
pub const SHOWCASE_H: f64 = 800.0;

/// A single **composed** showcase document: overlapping shapes at depth, with every effect family in
/// one picture rather than a labelled grid. This is the standard scene for classic-vs-hybrid backend
/// comparison — a real composition (gathers reading a live backdrop, stacked translucency, a clipped
/// scope, a masked group) exercises the ways the two backends can disagree far better than isolated
/// cells do. Rendered through the scheduler sink, so the gather effects (glass, background blur)
/// actually execute. Back-to-front paint order = the order roots are added.
#[must_use]
pub fn build_showcase_scene() -> Scene {
    let mut b = Build::new();
    let rect = Rect::new;
    let round = |r: f64| Some(RoundedRectRadii::from_single_radius(r));

    // 1. Backdrop: full-canvas linear gradient.
    {
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = rect(0.0, 0.0, SHOWCASE_W, SHOWCASE_H);
        n.fills = vec![Paint::plain(linear())];
        b.root(n);
    }
    // 2. Hero panel: angular gradient, rounded.
    {
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = rect(60.0, 60.0, 560.0, 400.0);
        n.corners = round(28.0);
        n.fills = vec![Paint::plain(angular())];
        b.root(n);
    }
    // 3. Radial-gradient circle, overlapping the hero.
    {
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Circle);
        n.bounds = rect(360.0, 150.0, 680.0, 470.0);
        n.fills = vec![Paint::plain(radial())];
        b.root(n);
    }
    // 4. Orange rect with a LAYER BLUR.
    {
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = rect(620.0, 80.0, 900.0, 340.0);
        n.corners = round(10.0);
        n.fills = vec![Paint::plain(Brush::Solid(col(245, 158, 11)))];
        n.blur = Some(8.0);
        b.root(n);
    }
    // 5. Translucent blue rect, MULTIPLY blend + 60% opacity, over the warm shapes below it.
    {
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = rect(640.0, 280.0, 1000.0, 560.0);
        n.fills = vec![Paint::plain(Brush::Solid(col(59, 130, 246)))];
        n.opacity = 0.6;
        n.blend = crate::blend::blend_from_raw(24); // Multiply
        b.root(n);
    }
    // 6. Multi-fill card (three stacked translucent fills) with a DROP SHADOW.
    {
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = rect(120.0, 440.0, 500.0, 720.0);
        n.corners = round(18.0);
        n.fills = vec![
            Paint::plain(Brush::Solid(cola(54, 102, 214, 140))),
            Paint::plain(Brush::Solid(cola(232, 66, 66, 150))),
            Paint::plain(Brush::Solid(col(240, 200, 40))),
        ];
        n.shadows = vec![Shadow { color: cola(0, 0, 0, 150), blur: 16.0, spread: 0.0, offset: Vec2::new(8.0, 12.0), inset: false }];
        b.root(n);
    }
    // 7. Rounded rect with an INNER SHADOW + a centred stroke.
    {
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = rect(540.0, 540.0, 780.0, 760.0);
        n.corners = round(16.0);
        n.fills = vec![Paint::plain(Brush::Solid(col(230, 232, 238)))];
        n.strokes = vec![Stroke { style: kurbo::Stroke::new(3.0), paint: Paint::plain(Brush::Solid(col(120, 130, 150))), align: StrokeAlign::Center }];
        n.shadows = vec![Shadow { color: cola(0, 0, 0, 170), blur: 12.0, spread: 0.0, offset: Vec2::new(4.0, 6.0), inset: true }];
        b.root(n);
    }
    // 8. Boolean-style L path with an OUTER stroke.
    {
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Path);
        let mut p = BezPath::new();
        p.move_to((940.0, 90.0));
        p.line_to((1140.0, 90.0));
        p.line_to((1140.0, 200.0));
        p.line_to((1050.0, 200.0));
        p.line_to((1050.0, 340.0));
        p.line_to((940.0, 340.0));
        p.close_path();
        n.path = Some(p);
        n.bounds = rect(940.0, 90.0, 1140.0, 340.0);
        n.fills = vec![Paint::plain(Brush::Solid(col(84, 74, 183)))];
        n.strokes = vec![Stroke { style: kurbo::Stroke::new(6.0), paint: Paint::plain(Brush::Solid(col(20, 20, 30))), align: StrokeAlign::Outer }];
        b.root(n);
    }
    // 9. MASKED GROUP: an angular-gradient rect clipped to a circle silhouette.
    {
        let mask_id = b.id();
        let mut mask = Node::new(mask_id, ShapeKind::Circle);
        mask.bounds = rect(830.0, 540.0, 1070.0, 780.0);
        mask.fills = vec![Paint::plain(Brush::Solid(col(255, 255, 255)))];
        b.child(mask);
        let content_id = b.id();
        let mut content = Node::new(content_id, ShapeKind::Rect);
        content.bounds = rect(820.0, 530.0, 1090.0, 790.0);
        content.fills = vec![Paint::plain(angular())];
        b.child(content);
        let gid = b.id();
        let mut g = Node::new(gid, ShapeKind::Group);
        g.masked = true;
        g.children = vec![mask_id, content_id];
        b.root(g);
    }
    // 10. CLIP FRAME (scope): an oversized radial circle clipped to the frame's rounded rect.
    {
        let child_id = b.id();
        let mut child = Node::new(child_id, ShapeKind::Circle);
        child.bounds = rect(20.0, 560.0, 380.0, 920.0);
        child.fills = vec![Paint::plain(radial())];
        b.child(child);
        let fid = b.id();
        let mut frame = Node::new(fid, ShapeKind::Frame);
        frame.bounds = rect(60.0, 600.0, 300.0, 780.0);
        frame.corners = round(14.0);
        frame.clip = true;
        frame.fills = vec![Paint::plain(Brush::Solid(col(235, 238, 244)))];
        frame.strokes = vec![frame_border(col(40, 40, 50))];
        frame.children = vec![child_id];
        b.root(frame);
    }
    // 11. Dashed outline rect (no fill).
    {
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = rect(330.0, 620.0, 560.0, 780.0);
        n.corners = round(12.0);
        n.strokes = vec![outline_stroke()];
        b.root(n);
    }
    // 12. GLASS panel over the backdrop (a gather — refracts everything behind it).
    {
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = rect(260.0, 180.0, 580.0, 420.0);
        n.corners = round(24.0);
        n.glass = Some(glass_lens(TileMode::Decal));
        b.root(n);
    }
    // 13. BACKGROUND-BLUR panel over the backdrop (a gather — frosts everything behind it).
    {
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = rect(700.0, 420.0, 1000.0, 680.0);
        n.corners = round(24.0);
        n.fills = vec![Paint::plain(Brush::Solid(cola(255, 255, 255, 26)))];
        n.background_blur = Some(18.0);
        b.root(n);
    }

    b.finish().0
}

impl Build {
    /// A page-scoped backdrop-effect cell: a full-cell backdrop plus a lens that reads the page behind
    /// it. `glass` picks glass vs background-blur.
    fn backdrop_cell(&mut self, glass: bool, label: &'static str) {
        let r = self.rect();
        let bid = self.id();
        let mut backdrop = Node::new(bid, ShapeKind::Rect);
        backdrop.bounds = r;
        backdrop.fills = vec![Paint::plain(if glass { linear() } else { angular() })];
        self.root(backdrop);
        let id = self.id();
        let mut lens = Node::new(id, ShapeKind::Rect);
        lens.bounds = Rect::new(r.x0 + 8.0, r.y0 + 8.0, r.x1 - 8.0, r.y1 - 8.0);
        lens.corners = Some(RoundedRectRadii::from_single_radius(if glass { 16.0 } else { 12.0 }));
        if glass {
            lens.glass = Some(glass_lens(TileMode::Decal));
        } else {
            lens.background_blur = Some(12.0);
        }
        self.root(lens);
        self.advance(label);
    }

    /// A **scoped** backdrop-effect cell: a clipping Frame containing the backdrop + lens, so the
    /// gather is scoped to the frame's content (the scheduler's ScopeOf surface), not the whole page.
    fn scoped_backdrop_cell(&mut self, glass: bool, label: &'static str) {
        let r = self.rect();
        let fid = self.id();
        let back_id = self.id();
        let lens_id = self.id();

        let mut frame = Node::new(fid, ShapeKind::Frame);
        frame.bounds = r;
        frame.clip = true;
        frame.corners = Some(RoundedRectRadii::from_single_radius(14.0));
        frame.children = vec![back_id, lens_id];
        self.root(frame);

        let mut backdrop = Node::new(back_id, ShapeKind::Rect);
        // Oversized so, without the frame's clip scope, it would bleed past the cell — the clip proves
        // the gather is scoped to the frame.
        backdrop.bounds = Rect::new(r.x0 - 20.0, r.y0 - 20.0, r.x1 + 20.0, r.y1 + 20.0);
        backdrop.fills = vec![Paint::plain(if glass { angular() } else { linear() })];
        self.child(backdrop);

        let mut lens = Node::new(lens_id, ShapeKind::Rect);
        lens.bounds = Rect::new(r.x0 + 12.0, r.y0 + 12.0, r.x1 - 12.0, r.y1 - 12.0);
        lens.corners = Some(RoundedRectRadii::from_single_radius(14.0));
        if glass {
            lens.glass = Some(glass_lens(TileMode::Decal));
        } else {
            lens.background_blur = Some(12.0);
        }
        self.child(lens);
        self.advance(label);
    }
}

/// A **nested scope test** for gathers (canvas 1000×700). The hierarchy the design calls for:
///
/// ```text
/// G  (group, opacity 0.99 → ISOLATES, establishes ScopeOf(G), NO clip)
/// ├─ G-bg   full-canvas BLUE→PURPLE gradient  (G's scope content)
/// ├─ A  (group, opacity 0.98 → ISOLATES, ScopeOf(A), NO clip)
/// │  ├─ A-bg   solid ORANGE rect               (A's scope content)
/// │  ├─ A1    GLASS lens, oversized — crosses A's right border into G's area → scoped to A
/// │  └─ A2    small white marker
/// └─ B  (group, opacity 1.0 → TRIVIAL, establishes NO scope, NO clip)
///    ├─ B1    GLASS lens, oversized — falls through trivial B to ScopeOf(G) → scoped to grandparent
///    └─ B2    small white marker
/// ```
///
/// Scope is set by *isolation* (non-trivial opacity), not clip — so both lenses paint past their
/// parent's border. By colour you can read which content each gather samples: A1 should refract A's
/// **orange**, B1 should refract G's **blue gradient**. Where A1 crosses outside A (past the orange)
/// its scope is empty — that boundary is the case to watch.
/// Which effect the two scope-test lenses (A1, B1) carry.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ScopeLens {
    /// Frosted-glass gather (the real subject of the test).
    Glass,
    /// Background-blur gather — a simpler gather that reads the same scoped backdrop, used to tell a
    /// glass-specific bug apart from a backdrop-compose/scope bug.
    Blur,
    /// No gather — a dashed outline of the footprint, revealing the backdrop behind the lens.
    Outline,
}

#[must_use]
pub fn build_scope_test_scene() -> (Scene, Vec<(usize, &'static str)>) {
    build_scope_test_scene_impl(ScopeLens::Glass, true, TileMode::Decal)
}

/// Same 7-shape hierarchy but with the three frame **backdrop fills removed** (frames keep only their
/// borders). The gathers then read an empty scope — with the alpha fix they must come out transparent
/// (the page shows through), not black. The with/without pair is the side-by-side backdrop proof.
#[must_use]
pub fn build_scope_test_scene_nobg() -> (Scene, Vec<(usize, &'static str)>) {
    build_scope_test_scene_impl(ScopeLens::Glass, false, TileMode::Decal)
}

/// The 7-shape hierarchy with the two glass lenses (A1, B1) REPLACED by dashed outlines of their
/// footprint. Shows exactly what backdrop sits behind each lens.
#[must_use]
pub fn build_scope_test_scene_nolens() -> (Scene, Vec<(usize, &'static str)>) {
    build_scope_test_scene_impl(ScopeLens::Outline, true, TileMode::Decal)
}

/// The 7-shape hierarchy with **background-blur** lenses instead of glass — a diagnostic to isolate
/// whether a black-lens artifact is glass-specific or lives in the scoped backdrop compose.
#[must_use]
pub fn build_scope_test_scene_blur() -> (Scene, Vec<(usize, &'static str)>) {
    build_scope_test_scene_impl(ScopeLens::Blur, true, TileMode::Decal)
}

/// The glass scope test with the lenses' past-scope [`TileMode`] set to **Black** — the lens fills a
/// black block past its scope instead of going transparent. Demonstrates the configurable edge mode.
#[must_use]
pub fn build_scope_test_scene_black() -> (Scene, Vec<(usize, &'static str)>) {
    build_scope_test_scene_impl(ScopeLens::Glass, true, TileMode::Black)
}

/// The glass scope test with the lenses' past-scope [`TileMode`] set to **Clamp** — the lens extends
/// its scope's edge pixels outward past the border.
#[must_use]
pub fn build_scope_test_scene_clamp() -> (Scene, Vec<(usize, &'static str)>) {
    build_scope_test_scene_impl(ScopeLens::Glass, true, TileMode::Clamp)
}

/// The nested-scope test as the user specified it: **one grandparent shape with two children, each
/// child with two children** = 7 shapes. All three containers are `Frame`s (so they are visible
/// shapes with their own fill + border), none clip:
///
/// - **G** (grandparent) — isolates (opacity 0.99); fill = blue→purple gradient. Children: A, B.
/// - **A** (parent 1) — isolates (opacity 0.98); fill = orange. Children: A1, A2.
/// - **B** (parent 2) — TRIVIAL (opacity 1.0, establishes no scope); fill = teal. Children: B1, B2.
/// - **A1** — glass gather, scoped to **A** (reads orange); oversized so it crosses A's right border.
/// - **A2** — plain white marker inside A.
/// - **B1** — glass gather, no isolating parent → scoped to **G** (reads the gradient); crosses B's border.
/// - **B2** — plain white marker inside B.
///
/// `show_backdrop` toggles the three frame fills: `true` gives the gathers real content to refract,
/// `false` empties every scope so the gathers must render transparent (the fix), not black.
/// `tile_mode` picks what a glass lens shows past its scope's content (see [`TileMode`]).
fn build_scope_test_scene_impl(
    lens: ScopeLens,
    show_backdrop: bool,
    tile_mode: TileMode,
) -> (Scene, Vec<(usize, &'static str)>) {
    let mut s = Scene::new();
    let (g, a, a1, a2, b, b1, b2) = (1u128, 2, 3, 4, 5, 6, 7);

    let mut root = Node::new(ROOT_ID, ShapeKind::Group);
    root.children = vec![g];
    s.insert(root);

    // Grandparent G — a non-clipping Frame that isolates (opacity 0.99). Its fill (a full-canvas
    // blue→purple gradient) is the backdrop a G-scoped gather reads.
    let g_stops = [
        peniko::ColorStop { offset: 0.0, color: col(54, 102, 214).into() },
        peniko::ColorStop { offset: 1.0, color: col(120, 74, 183).into() },
    ];
    let mut ng = Node::new(g, ShapeKind::Frame);
    ng.opacity = 0.99;
    ng.bounds = Rect::new(0.0, 0.0, 1000.0, 700.0);
    if show_backdrop {
        ng.fills = vec![Paint::plain(Brush::Gradient(
            peniko::Gradient::new_linear((0.0, 0.0), (1.0, 0.0)).with_stops(&g_stops[..]),
        ))];
    }
    ng.strokes = vec![frame_border(col(150, 170, 235))];
    ng.children = vec![a, b];
    s.insert(ng);

    // Parent A — a non-clipping Frame that isolates (opacity 0.98). Its fill (orange) is the backdrop
    // an A-scoped gather reads.
    let mut na = Node::new(a, ShapeKind::Frame);
    na.opacity = 0.98;
    na.bounds = Rect::new(80.0, 120.0, 460.0, 600.0);
    if show_backdrop {
        na.fills = vec![Paint::plain(Brush::Solid(col(216, 90, 48)))];
    }
    na.strokes = vec![frame_border(col(245, 160, 120))];
    na.children = vec![a1, a2];
    s.insert(na);

    // A1: glass lens scoped to A. Sits inside A (x=280) and extends to x=620 — crossing A's right
    // border (460) into G-only territory. A doesn't clip, so it paints there; past A's fill its scope
    // is empty, so with the alpha fix it goes transparent and G's gradient shows through (not black).
    let mut n_a1 = Node::new(a1, ShapeKind::Rect);
    n_a1.bounds = Rect::new(280.0, 260.0, 620.0, 540.0);
    n_a1.corners = Some(RoundedRectRadii::from_single_radius(16.0));
    apply_scope_lens(&mut n_a1, lens, tile_mode);
    s.insert(n_a1);

    let mut n_a2 = Node::new(a2, ShapeKind::Rect);
    n_a2.bounds = Rect::new(110.0, 150.0, 190.0, 230.0);
    n_a2.fills = vec![Paint::plain(Brush::Solid(col(240, 244, 250)))];
    s.insert(n_a2);

    // Parent B — a non-clipping Frame, TRIVIAL (opacity 1.0), so it establishes NO scope and its
    // subtree (fill + children) lands in G's scope. Its fill (teal) therefore joins G's backdrop.
    let mut nb = Node::new(b, ShapeKind::Frame);
    nb.bounds = Rect::new(600.0, 100.0, 900.0, 560.0);
    if show_backdrop {
        nb.fills = vec![Paint::plain(Brush::Solid(col(38, 166, 154)))];
    }
    nb.strokes = vec![frame_border(col(150, 225, 215))];
    nb.children = vec![b1, b2];
    s.insert(nb);

    // B1: glass lens with no isolating parent → reads ScopeOf(G) (gradient + B's teal). Sits inside B
    // (x=660) and extends to x=1000 — crossing B's right border (900) into gradient-only territory.
    let mut n_b1 = Node::new(b1, ShapeKind::Rect);
    n_b1.bounds = Rect::new(660.0, 180.0, 1000.0, 480.0);
    n_b1.corners = Some(RoundedRectRadii::from_single_radius(16.0));
    apply_scope_lens(&mut n_b1, lens, tile_mode);
    s.insert(n_b1);

    let mut n_b2 = Node::new(b2, ShapeKind::Rect);
    n_b2.bounds = Rect::new(810.0, 470.0, 890.0, 550.0);
    n_b2.fills = vec![Paint::plain(Brush::Solid(col(240, 244, 250)))];
    s.insert(n_b2);

    let _ = show_backdrop;
    let legend = vec![
        (0, "G (grandparent Frame, opacity .99, isolates): gradient fill = G-scope backdrop"),
        (1, "A (parent Frame, opacity .98, isolates): orange fill = A-scope backdrop"),
        (2, "B (parent Frame, opacity 1.0, TRIVIAL, no scope): teal fill folds into G-scope"),
        (3, "A1: A-scoped lens, crosses A's right border"),
        (4, "A2: plain white marker (child of A)"),
        (5, "B1: G-scoped lens, crosses B's right border"),
        (6, "B2: plain white marker (child of B)"),
    ];
    (s, legend)
}

// ── Image fills (needs staged pixels, so it is driven from the ABI, not the neutral model alone) ──

/// The content id the [`build_image_test_scene`] cells reference. The ABI stages
/// [`image_test_pixels`] under this id before installing the scene, so the fills resolve to real
/// pixels on either backend — the one thing the pure neutral model cannot carry.
pub const IMAGE_TEST_ID: u128 = 0x1_A6E_C0FF_EE;

/// A synthetic 4-quadrant test image, top-left origin, straight (unpremultiplied) RGBA — the exact
/// layout `store_image_rgba` expects. The quadrants are deliberately asymmetric (so a flip or
/// transpose is obvious) and the last is **semi-transparent** (so alpha compositing is testable):
/// TL opaque red, TR opaque green, BL opaque blue, BR half-alpha yellow.
#[must_use]
pub fn image_test_pixels() -> (u32, u32, Vec<u8>) {
    const W: u32 = 120;
    const H: u32 = 120;
    let mut rgba = Vec::with_capacity((W * H * 4) as usize);
    for y in 0..H {
        for x in 0..W {
            let (r, g, b, a) = match (x < W / 2, y < H / 2) {
                (true, true) => (220, 60, 60, 255),   // TL red
                (false, true) => (60, 200, 90, 255),  // TR green
                (true, false) => (60, 110, 220, 255), // BL blue
                (false, false) => (230, 210, 60, 140), // BR half-alpha yellow
            };
            rgba.extend_from_slice(&[r, g, b, a]);
        }
    }
    (W, H, rgba)
}

/// A grid of image-fill cells, all referencing [`IMAGE_TEST_ID`]: the placements Penpot's image
/// fill can take, so the classic backend's image path is exercised end-to-end. Cells: stretch (box
/// aspect = image), cover into a **wide** box (crops to the vertical middle band, centred), an
/// image-filled **circle** (clip to non-rect geometry), a **rounded** rect (corner clip), and a
/// **half-opacity** fill (per-fill alpha over the four quadrants).
#[must_use]
pub fn build_image_test_scene() -> (Scene, Vec<(usize, &'static str)>) {
    let mut b = Build::new();
    let img = |opacity: u8, keep_aspect: bool| {
        Paint::plain(Brush::Image(ImageFill {
            id: IMAGE_TEST_ID,
            width: 120,
            height: 120,
            opacity,
            keep_aspect,
            dest: None,
        }))
    };

    // Stretch: square box, image aspect matches, so the four quadrants fill the cell undistorted.
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = r;
        n.fills = vec![img(255, false)];
        b.root(n);
        b.advance("image stretch");
    }
    // Cover into a wide, short box: keep_aspect scales the square image to the box width and centres
    // it vertically, so the overflow is clipped and only the middle band shows (red|blue on the left,
    // green|yellow on the right).
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = Rect::new(r.x0, r.center().y - 34.0, r.x1, r.center().y + 34.0);
        n.fills = vec![img(255, true)];
        b.root(n);
        b.advance("image cover (wide)");
    }
    // Image-filled circle: the fill clips to the ellipse, proving image paint follows non-rect geometry.
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Circle);
        n.bounds = r;
        n.fills = vec![img(255, false)];
        b.root(n);
        b.advance("image on circle");
    }
    // Rounded rect: corner clip.
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = r;
        n.corners = Some(RoundedRectRadii::from_single_radius(28.0));
        n.fills = vec![img(255, false)];
        b.root(n);
        b.advance("image rounded");
    }
    // Half opacity: the per-fill 0..255 opacity rides the sampler alpha, dimming all four quadrants
    // over the black page (and the yellow quadrant, already half-alpha, dims further).
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = r;
        n.fills = vec![img(128, false)];
        b.root(n);
        b.advance("image opacity 50%");
    }
    b.finish()
}

// ── Path drop shadow (needs the SINK's run_graph blur, so verified via a sink harness) ───────────

/// A bezier arrow shape used by the path-shadow test — a non-box silhouette whose shadow must follow
/// the real outline (a blurred rounded-rect would be visibly wrong).
fn arrow_path(r: Rect) -> BezPath {
    let mut p = BezPath::new();
    p.move_to((r.x0, r.y1));
    p.line_to((r.center().x, r.y0));
    p.line_to((r.x1, r.y1));
    p.curve_to((r.center().x + 24.0, r.center().y), (r.center().x - 24.0, r.center().y), (r.x0, r.y1));
    p.close_path();
    p
}

/// Two cells over a light page: a bezier path WITH a soft drop shadow, and the same path WITHOUT one
/// (reference). The shadow must trace the arrow's true silhouette, offset and blurred — proving the
/// sink's silhouette-blur path, since classic vello has no inline arbitrary-shape blur.
#[must_use]
pub fn build_path_shadow_scene() -> (Scene, Vec<(usize, &'static str)>) {
    let mut b = Build::new();
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Path);
        n.bounds = r;
        n.path = Some(arrow_path(r));
        n.fills = vec![Paint::plain(Brush::Solid(col(84, 74, 183)))];
        n.shadows = vec![Shadow { color: cola(0, 0, 0, 180), blur: 12.0, spread: 0.0, offset: Vec2::new(16.0, 20.0), inset: false }];
        b.root(n);
        b.advance("path drop shadow");
    }
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Path);
        n.bounds = r;
        n.path = Some(arrow_path(r));
        n.fills = vec![Paint::plain(Brush::Solid(col(84, 74, 183)))];
        b.root(n);
        b.advance("path (no shadow)");
    }
    b.finish()
}

// ── Layer blur (needs the SINK's run_graph blur on classic, so verified via the sink harness) ────

/// Two cells over a light page: a shape WITH a layer blur (`node.blur`) and the same shape WITHOUT.
/// Layer blur softens the whole body — a sharp rect edge becomes a gradient — proving the sink's
/// `layer_blur_over_body` path (classic vello has no inline layer-blur primitive).
#[must_use]
pub fn build_layer_blur_scene() -> (Scene, Vec<(usize, &'static str)>) {
    let mut b = Build::new();
    let shape = |b: &mut Build, blur: Option<f32>, label: &'static str| {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        // Inset so the blur has room to fade inside the cell rather than clipping at the edge.
        n.bounds = Rect::new(r.x0 + 18.0, r.y0 + 18.0, r.x1 - 18.0, r.y1 - 18.0);
        n.corners = Some(RoundedRectRadii::from_single_radius(8.0));
        n.fills = vec![Paint::plain(Brush::Solid(col(216, 90, 48)))];
        n.strokes = vec![Stroke { style: kurbo::Stroke::new(6.0), paint: Paint::plain(Brush::Solid(col(40, 44, 60))), align: StrokeAlign::Center }];
        n.blur = blur;
        b.root(n);
        b.advance(label);
    };
    shape(&mut b, Some(9.0), "layer blur");
    shape(&mut b, None, "no blur (reference)");
    b.finish()
}

/// Total canvas size (device px) for the current cell count.
#[must_use]
pub fn canvas_size(cells: usize) -> (u32, u32) {
    let rows = (cells as f64 / COLS as f64).ceil();
    let w = (MARGIN * 2.0 + COLS as f64 * CELL).ceil() as u32;
    let h = (MARGIN * 2.0 + rows * CELL).ceil() as u32;
    (w, h)
}
