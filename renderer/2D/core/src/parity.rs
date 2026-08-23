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
    Brush, CustomShader, EffectSlot, FilterGraph, FilterNode, Glass, ImageFill, Node, Paint, Scene, Shadow, ShapeEffect,
    ShapeKind, Stroke, StrokeAlign, TileMode, ROOT_ID,
};

/// Grid columns.
pub const COLS: usize = 6;
/// Cell pitch, page units.
pub const CELL: f64 = 190.0;
/// Outer margin.
pub const MARGIN: f64 = 26.0;
/// Inner padding inside each cell.
pub const PAD: f64 = 22.0;

/// Font identity the parity **text** cell references. No host uploads a face in a bare harness
/// (bench.html), so [`crate::vello::abi::stage_parity_font`] stages an embedded Roboto under exactly
/// this id/weight/style when the parity scene loads, and the text span resolves to it by alias.
pub const PARITY_FONT_ID: u128 = 0x0000_0000_0000_0000_0000_0000_5041_5254;

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

    let aligned = |b: &mut Build, align: StrokeAlign, label: &'static str| {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = Rect::new(r.x0 + 12.0, r.y0 + 12.0, r.x1 - 12.0, r.y1 - 12.0);
        n.fills = vec![Paint::plain(Brush::Solid(col(232, 200, 96)))];
        let style = kurbo::Stroke::new(16.0)
            .with_join(kurbo::Join::Miter)
            .with_caps(kurbo::Cap::Butt);
        n.strokes = vec![Stroke { style, paint: Paint::plain(Brush::Solid(col(40, 44, 60))), align }];
        b.root(n);
        b.advance(label);
    };
    aligned(&mut b, StrokeAlign::Inner, "inner stroke");
    aligned(&mut b, StrokeAlign::Outer, "outer stroke");

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

    b.backdrop_cell(false, "backdrop blur [sink]");
    b.backdrop_cell(true, "glass [sink]");

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
        let r = b.rect();
        let (a, c) = (0.30, 0.70);
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

    b.scoped_backdrop_cell(false, "scoped backdrop-blur [sink]");
    b.scoped_backdrop_cell(true, "scoped glass [sink]");

    b.path_gather_cell(true, "glass on path [sink]");
    b.path_gather_cell(false, "bg-blur on path [sink]");

    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Text);
        n.bounds = r;
        let span = crate::text::TextSpan {
            text: "Aa Bb 012".to_string(),
            font: crate::text::FontRef { id: PARITY_FONT_ID, weight: 400, italic: false },
            size: 42.0,
            line_height: 1.2,
            letter_spacing: 0.0,
            fills: vec![Paint::plain(Brush::Solid(col(24, 24, 28)))],
            decoration: crate::text::TextDecoration::None,
            transform: crate::text::TextTransform::None,
        };
        let para = crate::text::TextParagraph {
            align: crate::text::TextAlign::Center,
            direction: crate::text::TextDirection::Ltr,
            line_height: 1.2,
            letter_spacing: 0.0,
            spans: vec![span],
        };
        n.text = Some(crate::text::TextBlock {
            paragraphs: vec![para],
            grow: crate::text::TextGrow::Fixed,
            vertical_align: crate::text::VerticalAlign::Center,
        });
        n.shadows = vec![Shadow { color: cola(0, 0, 0, 150), blur: 7.0, spread: 0.0, offset: Vec2::new(4.0, 6.0), inset: false }];
        b.root(n);
        let lid = b.id();
        let mut lens = Node::new(lid, ShapeKind::Rect);
        lens.bounds = Rect::new(r.x0, r.center().y, r.x1, r.y1);
        lens.background_blur = Some(6.0);
        b.root(lens);
        b.advance("text + bg-blur [sink]");
    }

    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Path);
        n.bounds = r;
        n.path = Some(blob_path(Rect::new(r.x0 + 10.0, r.y0 + 6.0, r.x1 - 10.0, r.y1 - 16.0)));
        n.fills = vec![Paint::plain(angular())];
        n.shadows = vec![Shadow { color: cola(0, 0, 0, 150), blur: 12.0, spread: 0.0, offset: Vec2::new(7.0, 9.0), inset: false }];
        b.root(n);
        b.advance("vector shape + drop shadow");
    }

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

    {
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = rect(0.0, 0.0, SHOWCASE_W, SHOWCASE_H);
        n.fills = vec![Paint::plain(linear())];
        b.root(n);
    }
    {
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = rect(60.0, 60.0, 560.0, 400.0);
        n.corners = round(28.0);
        n.fills = vec![Paint::plain(angular())];
        b.root(n);
    }
    {
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Circle);
        n.bounds = rect(360.0, 150.0, 680.0, 470.0);
        n.fills = vec![Paint::plain(radial())];
        b.root(n);
    }
    {
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = rect(620.0, 80.0, 900.0, 340.0);
        n.corners = round(10.0);
        n.fills = vec![Paint::plain(Brush::Solid(col(245, 158, 11)))];
        n.blur = Some(8.0);
        b.root(n);
    }
    {
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = rect(640.0, 280.0, 1000.0, 560.0);
        n.fills = vec![Paint::plain(Brush::Solid(col(59, 130, 246)))];
        n.opacity = 0.6;
        n.blend = crate::blend::blend_from_raw(24);
        b.root(n);
    }
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
    {
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = rect(330.0, 620.0, 560.0, 780.0);
        n.corners = round(12.0);
        n.strokes = vec![outline_stroke()];
        b.root(n);
    }
    {
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = rect(260.0, 180.0, 580.0, 420.0);
        n.corners = round(24.0);
        n.glass = Some(glass_lens(TileMode::Decal));
        b.root(n);
    }
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

    /// A **random path shape carrying a gather effect**: an arrow-silhouette lens (glass or
    /// background-blur) over a gradient backdrop. Unlike [`Self::backdrop_cell`]'s rounded-rect lens,
    /// the gather coverage here is an arbitrary `Path`, exercising the whole-viewport gather path on
    /// non-box geometry.
    fn path_gather_cell(&mut self, glass: bool, label: &'static str) {
        let r = self.rect();
        let bid = self.id();
        let mut backdrop = Node::new(bid, ShapeKind::Rect);
        backdrop.bounds = r;
        backdrop.fills = vec![Paint::plain(if glass { linear() } else { angular() })];
        self.root(backdrop);
        let id = self.id();
        let mut lens = Node::new(id, ShapeKind::Path);
        lens.bounds = r;
        lens.path = Some(arrow_path(Rect::new(r.x0 + 6.0, r.y0 + 6.0, r.x1 - 6.0, r.y1 - 6.0)));
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

    let mut na = Node::new(a, ShapeKind::Frame);
    na.opacity = 0.98;
    na.bounds = Rect::new(80.0, 120.0, 460.0, 600.0);
    if show_backdrop {
        na.fills = vec![Paint::plain(Brush::Solid(col(216, 90, 48)))];
    }
    na.strokes = vec![frame_border(col(245, 160, 120))];
    na.children = vec![a1, a2];
    s.insert(na);

    let mut n_a1 = Node::new(a1, ShapeKind::Rect);
    n_a1.bounds = Rect::new(280.0, 260.0, 620.0, 540.0);
    n_a1.corners = Some(RoundedRectRadii::from_single_radius(16.0));
    apply_scope_lens(&mut n_a1, lens, tile_mode);
    s.insert(n_a1);

    let mut n_a2 = Node::new(a2, ShapeKind::Rect);
    n_a2.bounds = Rect::new(110.0, 150.0, 190.0, 230.0);
    n_a2.fills = vec![Paint::plain(Brush::Solid(col(240, 244, 250)))];
    s.insert(n_a2);

    let mut nb = Node::new(b, ShapeKind::Frame);
    nb.bounds = Rect::new(600.0, 100.0, 900.0, 560.0);
    if show_backdrop {
        nb.fills = vec![Paint::plain(Brush::Solid(col(38, 166, 154)))];
    }
    nb.strokes = vec![frame_border(col(150, 225, 215))];
    nb.children = vec![b1, b2];
    s.insert(nb);

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
                (true, true) => (220, 60, 60, 255),
                (false, true) => (60, 200, 90, 255),
                (true, false) => (60, 110, 220, 255),
                (false, false) => (230, 210, 60, 140),
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

    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = r;
        n.fills = vec![img(255, false)];
        b.root(n);
        b.advance("image stretch");
    }
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Rect);
        n.bounds = Rect::new(r.x0, r.center().y - 34.0, r.x1, r.center().y + 34.0);
        n.fills = vec![img(255, true)];
        b.root(n);
        b.advance("image cover (wide)");
    }
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Circle);
        n.bounds = r;
        n.fills = vec![img(255, false)];
        b.root(n);
        b.advance("image on circle");
    }
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

/// An organic, many-node closed vector shape — a stand-in for an arbitrary authored **vector
/// network** face (several cubic segments, no symmetry), so effects run over irregular geometry, not
/// the tidy arrow. Control points are fixed fractions of `r` (deterministic — the fixture must be
/// reproducible), tuned to read as a lopsided blob.
fn blob_path(r: Rect) -> BezPath {
    let (w, h) = (r.width(), r.height());
    let px = |fx: f64| r.x0 + fx * w;
    let py = |fy: f64| r.y0 + fy * h;
    let mut p = BezPath::new();
    p.move_to((px(0.50), py(0.04)));
    p.curve_to((px(0.80), py(0.00)), (px(1.00), py(0.30)), (px(0.88), py(0.52)));
    p.curve_to((px(0.80), py(0.70)), (px(1.00), py(0.86)), (px(0.70), py(0.95)));
    p.curve_to((px(0.54), py(1.00)), (px(0.42), py(0.80)), (px(0.24), py(0.93)));
    p.curve_to((px(0.05), py(1.00)), (px(0.00), py(0.68)), (px(0.12), py(0.48)));
    p.curve_to((px(0.19), py(0.33)), (px(0.02), py(0.16)), (px(0.30), py(0.09)));
    p.curve_to((px(0.37), py(0.07)), (px(0.44), py(0.06)), (px(0.50), py(0.04)));
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
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Text);
        n.bounds = r;
        let span = crate::text::TextSpan {
            text: "Ag Ky 3".to_string(),
            font: crate::text::FontRef { id: PARITY_FONT_ID, weight: 400, italic: false },
            size: 48.0,
            line_height: 1.2,
            letter_spacing: 0.0,
            fills: vec![Paint::plain(Brush::Solid(col(84, 74, 183)))],
            decoration: crate::text::TextDecoration::None,
            transform: crate::text::TextTransform::None,
        };
        let para = crate::text::TextParagraph {
            align: crate::text::TextAlign::Center,
            direction: crate::text::TextDirection::Ltr,
            line_height: 1.2,
            letter_spacing: 0.0,
            spans: vec![span],
        };
        n.text = Some(crate::text::TextBlock {
            paragraphs: vec![para],
            grow: crate::text::TextGrow::Fixed,
            vertical_align: crate::text::VerticalAlign::Center,
        });
        n.shadows = vec![Shadow { color: cola(0, 0, 0, 180), blur: 10.0, spread: 0.0, offset: Vec2::new(6.0, 8.0), inset: false }];
        b.root(n);
        b.advance("text + drop shadow");
    }
    b.finish()
}

/// Cells over a light page exercising non-box INNER shadows: a filled path and a text block, each with
/// an inset shadow (a dark band hugging the inside edge on the offset side), beside the same path with
/// no shadow. Classic has no inline non-box inner shadow, so this is driven through the sink
/// (`paint_inner_shadow` / `wv_paint_inner_shadow`), not the tree walk. Needs the staged parity font.
#[must_use]
pub fn build_inner_shadow_scene() -> (Scene, Vec<(usize, &'static str)>) {
    let mut b = Build::new();
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Path);
        n.bounds = r;
        n.path = Some(blob_path(Rect::new(r.x0 + 10.0, r.y0 + 6.0, r.x1 - 10.0, r.y1 - 16.0)));
        n.fills = vec![Paint::plain(Brush::Solid(col(206, 212, 222)))];
        n.shadows = vec![Shadow { color: cola(0, 0, 0, 200), blur: 12.0, spread: 0.0, offset: Vec2::new(8.0, 10.0), inset: true }];
        b.root(n);
        b.advance("vector shape + inner shadow");
    }
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Text);
        n.bounds = r;
        let span = crate::text::TextSpan {
            text: "Ag Ky".to_string(),
            font: crate::text::FontRef { id: PARITY_FONT_ID, weight: 400, italic: false },
            size: 60.0,
            line_height: 1.2,
            letter_spacing: 0.0,
            fills: vec![Paint::plain(Brush::Solid(col(206, 212, 222)))],
            decoration: crate::text::TextDecoration::None,
            transform: crate::text::TextTransform::None,
        };
        n.text = Some(crate::text::TextBlock {
            paragraphs: vec![crate::text::TextParagraph {
                align: crate::text::TextAlign::Center,
                direction: crate::text::TextDirection::Ltr,
                line_height: 1.2,
                letter_spacing: 0.0,
                spans: vec![span],
            }],
            grow: crate::text::TextGrow::Fixed,
            vertical_align: crate::text::VerticalAlign::Center,
        });
        n.shadows = vec![Shadow { color: cola(0, 0, 0, 210), blur: 6.0, spread: 0.0, offset: Vec2::new(4.0, 5.0), inset: true }];
        b.root(n);
        b.advance("text + inner shadow");
    }
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Path);
        n.bounds = r;
        n.path = Some(blob_path(Rect::new(r.x0 + 10.0, r.y0 + 6.0, r.x1 - 10.0, r.y1 - 16.0)));
        n.fills = vec![Paint::plain(Brush::Solid(col(206, 212, 222)))];
        b.root(n);
        b.advance("vector shape (no shadow)");
    }
    b.finish()
}

/// An L-shaped path — the exact outline of the union of two overlapping rects filling `r`.
fn bool_union_path(r: Rect) -> BezPath {
    let (a, c) = (0.30, 0.70);
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
    p
}

/// A rectangular ring — the outline of (outer rect − inner rect), the two contours wound opposite so a
/// non-zero fill leaves the middle empty. This is how a boolean *difference* result arrives: one path
/// with sub-contours, not a special primitive.
fn bool_difference_path(r: Rect) -> BezPath {
    let o = r;
    let i = Rect::new(
        r.x0 + r.width() * 0.28,
        r.y0 + r.height() * 0.28,
        r.x1 - r.width() * 0.28,
        r.y1 - r.height() * 0.28,
    );
    let mut p = BezPath::new();
    p.move_to((o.x0, o.y0));
    p.line_to((o.x1, o.y0));
    p.line_to((o.x1, o.y1));
    p.line_to((o.x0, o.y1));
    p.close_path();
    p.move_to((i.x0, i.y0));
    p.line_to((i.x0, i.y1));
    p.line_to((i.x1, i.y1));
    p.line_to((i.x1, i.y0));
    p.close_path();
    p
}

/// Boolean-result cells over a light page: a union (L outline), a difference (ring with a real hole),
/// and a union carrying a native drop shadow — proving a boolean result composes with the effect path.
#[must_use]
pub fn build_boolean_scene() -> (Scene, Vec<(usize, &'static str)>) {
    let mut b = Build::new();
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Path);
        n.bounds = r;
        n.path = Some(bool_union_path(Rect::new(r.x0 + 12.0, r.y0 + 12.0, r.x1 - 12.0, r.y1 - 12.0)));
        n.fills = vec![Paint::plain(Brush::Solid(col(84, 74, 183)))];
        b.root(n);
        b.advance("boolean union");
    }
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Path);
        n.bounds = r;
        n.path = Some(bool_difference_path(Rect::new(r.x0 + 14.0, r.y0 + 14.0, r.x1 - 14.0, r.y1 - 14.0)));
        n.fills = vec![Paint::plain(Brush::Solid(col(48, 150, 120)))];
        b.root(n);
        b.advance("boolean difference (hole)");
    }
    {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Path);
        n.bounds = r;
        n.path = Some(bool_union_path(Rect::new(r.x0 + 12.0, r.y0 + 12.0, r.x1 - 12.0, r.y1 - 12.0)));
        n.fills = vec![Paint::plain(Brush::Solid(col(216, 90, 48)))];
        n.shadows = vec![Shadow { color: cola(0, 0, 0, 170), blur: 10.0, spread: 0.0, offset: Vec2::new(7.0, 9.0), inset: false }];
        b.root(n);
        b.advance("boolean union + drop shadow");
    }
    b.finish()
}

/// A minimal body-only (spread) custom shader: tint the shape's own body toward `[r,g,b]` by `amount`.
/// `reads_backdrop: false` marks it a spread (runs over the body, no backdrop) so the sink chains it in
/// `custom_over_body` / `wv_composite_body`. `u[0].xy` is the resolution, then the params pack in.
fn tint_shader(r: f32, g: f32, b: f32, amount: f32) -> CustomShader {
    let wgsl = r"
struct P { u: array<vec4<f32>, 2> };
@group(0) @binding(0) var<uniform> params: P;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
    var out: VsOut;
    let x = f32(vi & 1u);
    let y = f32(vi >> 1u);
    out.uv = vec2<f32>(x, y);
    out.pos = vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
    return out;
}
@fragment
fn fs(inp: VsOut) -> @location(0) vec4<f32> {
    let src = textureSample(tex, samp, inp.uv);
    let tint = vec3<f32>(params.u[0].z, params.u[0].w, params.u[1].x);
    let amount = params.u[1].y;
    // Premultiplied: tint the colour toward `tint * a` by `amount`, keep the coverage alpha.
    let rgb = mix(src.rgb, tint * src.a, amount);
    return vec4<f32>(rgb, src.a);
}
".to_string();
    CustomShader { wgsl, reach: 0.0, param_vec4s: 2, params: vec![r, g, b, amount], reads_backdrop: false, acceptable_downscale: 1.0 }
}

/// Cells over a light page, each stacking several effects on ONE shape: drop + inner shadow together; a
/// drop shadow under a layer blur; and a custom tint (effects list) under a drop shadow. Verify-only —
/// the point is that WV composes the whole stack, in the lists' authored order, the way tiled does.
#[must_use]
pub fn build_combined_scene() -> (Scene, Vec<(usize, &'static str)>) {
    let mut b = Build::new();
    let blob = |b: &mut Build| {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Path);
        n.bounds = r;
        n.path = Some(blob_path(Rect::new(r.x0 + 12.0, r.y0 + 8.0, r.x1 - 12.0, r.y1 - 18.0)));
        (id, r, n)
    };
    {
        let (_id, _r, mut n) = blob(&mut b);
        n.fills = vec![Paint::plain(Brush::Solid(col(216, 90, 48)))];
        n.shadows = vec![
            Shadow { color: cola(0, 0, 0, 170), blur: 11.0, spread: 0.0, offset: Vec2::new(8.0, 10.0), inset: false },
            Shadow { color: cola(0, 0, 0, 190), blur: 7.0, spread: 0.0, offset: Vec2::new(-5.0, -6.0), inset: true },
        ];
        b.root(n);
        b.advance("drop + inner shadow");
    }
    {
        let (_id, _r, mut n) = blob(&mut b);
        n.fills = vec![Paint::plain(Brush::Solid(col(84, 74, 183)))];
        n.shadows = vec![Shadow { color: cola(0, 0, 0, 170), blur: 10.0, spread: 0.0, offset: Vec2::new(7.0, 9.0), inset: false }];
        n.blur = Some(4.0);
        b.root(n);
        b.advance("drop shadow + layer blur");
    }
    {
        let (_id, _r, mut n) = blob(&mut b);
        n.fills = vec![Paint::plain(Brush::Solid(col(48, 150, 120)))];
        n.effects = vec![ShapeEffect { slot: EffectSlot::Custom, shader: tint_shader(1.0, 0.8, 0.1, 0.7) }];
        n.shadows = vec![Shadow { color: cola(0, 0, 0, 160), blur: 10.0, spread: 0.0, offset: Vec2::new(6.0, 8.0), inset: false }];
        b.root(n);
        b.advance("tint shader + drop shadow");
    }
    b.finish()
}

/// A stress scene for pass-count / frame-time comparison: a grid of `n` shapes, EACH carrying a heavy
/// effect stack — two drop shadows, an inner shadow, a layer blur, and a tint spread shader. Every one
/// of those is one or more effect pass-graphs, and in the whole-viewport path each runs at FULL viewport
/// resolution (extent-crop is a later opt), so this is the worst case: `n × (many full-screen passes)`.
/// The tiled path crops each effect to its extent, so the same scene should cost it far less — which is
/// exactly the gap this scene is meant to surface.
#[must_use]
pub fn build_stress_scene() -> (Scene, Vec<(usize, &'static str)>) {
    build_stress_scene_n(12)
}

/// [`build_stress_scene`] with an explicit shape count — used by the phased sweep to grow the number of
/// effect boundaries (= segments), which is what the front-end-once path re-scans the whole PTCL for.
#[must_use]
pub fn build_stress_scene_n(n: usize) -> (Scene, Vec<(usize, &'static str)>) {
    build_stress_scene_mask(n, FX_ALL)
}

/// Every effect combination the whole-viewport path can hit, one per cell — the broad net the five
/// narrow fixtures do not cast.
///
/// The narrow fixtures each exercise one effect well, which is exactly why they missed a body cell
/// going absent for shapes with no `Source::Body` effect: every node in the stress scene carries a
/// blur and a shader. This walks the axes instead — how many shadows, drop versus inner versus both,
/// spread, sharp versus blurred, body effects present or absent, gathers alone and combined — so a
/// gap in one combination shows up as a cell that differs rather than as silence.
///
/// Cells are labelled, so an A/B run names the combination that broke.
#[must_use]
pub fn build_matrix_scene() -> (Scene, Vec<(usize, &'static str)>) {
    let mut b = Build::new();
    type Setup = (&'static str, fn(&mut Node));
    let cells: &[Setup] = &[
        ("plain", |_n| {}),
        ("drop x1", |n| n.shadows = vec![drop_shadow(10.0, 0.0)]),
        ("drop x2", |n| n.shadows = vec![drop_shadow(12.0, 0.0), drop_shadow(5.0, 0.0)]),
        ("drop sharp", |n| n.shadows = vec![drop_shadow(0.0, 0.0)]),
        ("drop spread", |n| n.shadows = vec![drop_shadow(8.0, 4.0)]),
        ("inner x1", |n| n.shadows = vec![inner_shadow(8.0, 0.0)]),
        ("inner x2", |n| n.shadows = vec![inner_shadow(9.0, 0.0), inner_shadow(4.0, 0.0)]),
        ("inner sharp", |n| n.shadows = vec![inner_shadow(0.0, 0.0)]),
        ("drop+inner", |n| n.shadows = vec![drop_shadow(10.0, 0.0), inner_shadow(7.0, 0.0)]),
        ("blur", |n| n.blur = Some(4.0)),
        ("shader", |n| n.effects = vec![ShapeEffect { slot: EffectSlot::Custom, shader: tint_shader(0.2, 0.9, 1.0, 0.5) }]),
        ("shader+blur", |n| {
            n.effects = vec![ShapeEffect { slot: EffectSlot::Custom, shader: tint_shader(1.0, 0.5, 0.2, 0.5) }];
            n.blur = Some(3.0);
        }),
        ("drop+blur", |n| {
            n.shadows = vec![drop_shadow(10.0, 0.0)];
            n.blur = Some(3.0);
        }),
        ("drop+shader", |n| {
            n.shadows = vec![drop_shadow(10.0, 0.0)];
            n.effects = vec![ShapeEffect { slot: EffectSlot::Custom, shader: tint_shader(0.3, 1.0, 0.4, 0.5) }];
        }),
        ("inner+blur", |n| {
            n.shadows = vec![inner_shadow(8.0, 0.0)];
            n.blur = Some(3.0);
        }),
        ("bg blur", |n| n.background_blur = Some(14.0)),
        ("bg blur+drop", |n| {
            n.background_blur = Some(14.0);
            n.shadows = vec![drop_shadow(10.0, 0.0)];
        }),
        ("glass", |n| n.glass = Some(glass_lens(TileMode::Decal))),
        ("glass+inner", |n| {
            n.glass = Some(glass_lens(TileMode::Decal));
            n.shadows = vec![inner_shadow(7.0, 0.0)];
        }),
        ("everything", |n| {
            n.shadows = vec![drop_shadow(11.0, 0.0), drop_shadow(5.0, 2.0), inner_shadow(7.0, 0.0)];
            n.background_blur = Some(10.0);
            n.blur = Some(3.0);
            n.effects = vec![ShapeEffect { slot: EffectSlot::Custom, shader: tint_shader(1.0, 0.8, 0.3, 0.5) }];
        }),
    ];
    for (label, setup) in cells {
        let r = b.rect();
        let mut under = Node::new(b.id(), ShapeKind::Rect);
        under.bounds = Rect::new(r.x0 + 6.0, r.y0 + 6.0, r.x1 - 6.0, r.y1 - 6.0);
        under.fills = vec![Paint::plain(Brush::Solid(col(210, 170, 90)))];
        b.root(under);

        let mut n = Node::new(b.id(), ShapeKind::Path);
        n.bounds = r;
        n.path = Some(blob_path(Rect::new(r.x0 + 14.0, r.y0 + 10.0, r.x1 - 14.0, r.y1 - 20.0)));
        n.fills = vec![Paint::plain(Brush::Solid(col(70, 110, 190)))];
        setup(&mut n);
        b.root(n);
        b.advance(label);
    }
    b.finish()
}

fn drop_shadow(blur: f32, spread: f32) -> Shadow {
    Shadow { color: cola(0, 0, 0, 150), blur, spread, offset: Vec2::new(7.0, 9.0), inset: false }
}

fn inner_shadow(blur: f32, spread: f32) -> Shadow {
    Shadow { color: cola(0, 0, 0, 170), blur, spread, offset: Vec2::new(-5.0, -6.0), inset: true }
}

/// A document at editing scale: thousands of shapes, mostly plain, a minority carrying effects, laid
/// out overlapping so z-order actually interleaves.
///
/// Every other stress fixture in this file is a dozen shapes on a grid, which measures effect cost
/// but says nothing about what a real document costs: the per-shape walk, the encoding rebuild, and
/// how those behave while the view is moving. `n` shapes, every `effect_every`-th one loaded with an
/// effect stack, all packed into a band so they overlap rather than tile neatly.
#[must_use]
pub fn build_scale_scene(n: usize, effect_every: usize) -> (Scene, Vec<(usize, &'static str)>) {
    build_scale_scene_sized(n, effect_every, 26.0, 1.9, 7)
}

/// [`build_scale_scene`] with explicit geometry knobs: `step` = grid pitch in px, `size` = shape edge
/// as a multiple of the pitch (`size > 1` overlaps neighbours; big values stack shapes deeply), and
/// `opacity_every` = every k-th shape is translucent (0 = none).
#[must_use]
pub fn build_scale_scene_sized(
    n: usize,
    effect_every: usize,
    step: f64,
    size: f64,
    opacity_every: usize,
) -> (Scene, Vec<(usize, &'static str)>) {
    let mut b = Build::new();
    let cols = (n as f64).sqrt().ceil() as usize;
    let r = b.rect();
    for i in 0..n {
        let (cx, cy) = ((i % cols) as f64, (i / cols) as f64);
        let x = r.x0 + cx * step;
        let y = r.y0 + cy * step;
        let box_ = Rect::new(x, y, x + step * size, y + step * size);
        let mut node = Node::new(b.id(), ShapeKind::Path);
        node.bounds = box_;
        node.path = Some(blob_path(box_));
        let hue = (i * 53 % 255) as u8;
        node.fills = vec![Paint::plain(Brush::Solid(col(60 + hue / 3, 90 + hue / 4, 200 - hue / 3)))];
        node.opacity = if opacity_every > 0 && i % opacity_every == 0 { 0.75 } else { 1.0 };
        if effect_every > 0 && i % effect_every == 0 {
            match (i / effect_every) % 4 {
                0 => node.shadows = vec![Shadow { color: cola(0, 0, 0, 140), blur: 9.0, spread: 0.0, offset: Vec2::new(5.0, 6.0), inset: false }],
                1 => node.blur = Some(3.0),
                2 => {
                    node.shadows = vec![Shadow { color: cola(0, 0, 0, 150), blur: 7.0, spread: 0.0, offset: Vec2::new(-4.0, -5.0), inset: true }];
                }
                _ => node.effects = vec![ShapeEffect { slot: EffectSlot::Custom, shader: tint_shader(1.0, 0.85, 0.3, 0.45) }],
            }
        }
        b.root(node);
    }
    b.advance("scale");
    b.finish()
}

/// A grid of `n` **glass lenses** over a patterned ground, spread across the whole canvas so their
/// blur reaches stay disjoint — which is what puts them all in ONE round ([`crate::vello::sink`]'s
/// round assignment separates lenses whose reaches overlap). That is the case the batched glass
/// stages exist for: N lenses cost one pass per stage instead of a private pass chain each. `frost`
/// picks the frosted variant (warp → blur → scatter tail) over the sharp one (a single fused unit
/// pass), the two shapes the stages implement. `downscale` is each lens's `acceptable_downscale`
/// (`1.0` = native); a value below `1.0` forces the lens to render at a reduced `k` and be upscaled,
/// which is the case the batch's scaled-stamp (`stage::SHARP`) path exists for.
#[must_use]
/// A grid of `n` **background-blur gathers** — the non-self-clipping counterpart of
/// [`build_glass_grid_scene`]. Each gather reads the backdrop, blurs it, and composites through its
/// own silhouette (no SDF self-clip), so it exercises the batched masked composite
/// (`MASKED`/`SHARP_MASKED`) against the per-shape `blit_masked` oracle. Same disjoint-cell layout so
/// no reach bridges neighbours.
pub fn build_blur_grid_scene(n: usize, radius: f32) -> (Scene, Vec<(usize, &'static str)>) {
    let mut b = Build::new();
    let cols = (n as f64).sqrt().ceil() as usize;
    let rows = n.div_ceil(cols);
    for _ in 0..(cols * rows) {
        b.advance("blur grid");
    }
    let (cw, ch) = canvas_size(cols * rows);
    let (pitch_x, pitch_y) = (f64::from(cw) / cols as f64, f64::from(ch) / rows as f64);
    let (lw, lh) = (pitch_x / 3.0, pitch_y / 3.0);
    for i in 0..(n * 4) {
        let (gx, gy) = ((i % (cols * 2)) as f64, (i / (cols * 2)) as f64);
        let mut node = Node::new(b.id(), ShapeKind::Rect);
        let (x, y) = (gx * pitch_x * 0.5, gy * pitch_y * 0.5);
        node.bounds = Rect::new(x, y, x + pitch_x * 0.5, y + pitch_y * 0.5);
        let hue = (i * 37 % 255) as u8;
        node.fills = vec![Paint::plain(Brush::Solid(col(40 + hue / 2, 200 - hue / 3, 120 + hue / 4)))];
        b.root(node);
    }
    for i in 0..n {
        let (gx, gy) = ((i % cols) as f64, (i / cols) as f64);
        let x = (gx + 0.5) * pitch_x - lw * 0.5;
        let y = (gy + 0.5) * pitch_y - lh * 0.5;
        let mut node = Node::new(b.id(), ShapeKind::Rect);
        node.bounds = Rect::new(x, y, x + lw, y + lh);
        node.corners = Some(RoundedRectRadii::from_single_radius(12.0));
        node.background_blur = Some(radius);
        b.root(node);
    }
    b.finish()
}

pub fn build_glass_grid_scene(n: usize, frost: bool, downscale: f32) -> (Scene, Vec<(usize, &'static str)>) {
    let mut b = Build::new();
    let cols = (n as f64).sqrt().ceil() as usize;
    let rows = n.div_ceil(cols);
    for _ in 0..(cols * rows) {
        b.advance("glass grid");
    }
    let (cw, ch) = canvas_size(cols * rows);
    let (pitch_x, pitch_y) = (f64::from(cw) / cols as f64, f64::from(ch) / rows as f64);
    // The lens occupies the middle third of its pitch, so neighbours stay a full lens-width apart
    // and no reach can bridge the gap.
    let (lw, lh) = (pitch_x / 3.0, pitch_y / 3.0);
    for i in 0..(n * 4) {
        let (gx, gy) = ((i % (cols * 2)) as f64, (i / (cols * 2)) as f64);
        let mut node = Node::new(b.id(), ShapeKind::Rect);
        let (x, y) = (gx * pitch_x * 0.5, gy * pitch_y * 0.5);
        node.bounds = Rect::new(x, y, x + pitch_x * 0.5, y + pitch_y * 0.5);
        let hue = (i * 37 % 255) as u8;
        node.fills = vec![Paint::plain(Brush::Solid(col(40 + hue / 2, 200 - hue / 3, 120 + hue / 4)))];
        b.root(node);
    }
    for i in 0..n {
        let (gx, gy) = ((i % cols) as f64, (i / cols) as f64);
        let x = (gx + 0.5) * pitch_x - lw * 0.5;
        let y = (gy + 0.5) * pitch_y - lh * 0.5;
        let mut node = Node::new(b.id(), ShapeKind::Rect);
        node.bounds = Rect::new(x, y, x + lw, y + lh);
        node.corners = Some(RoundedRectRadii::from_single_radius(12.0));
        let mut g = glass_lens(TileMode::Decal);
        if !frost {
            g.blur = 0.0;
            g.frost = 0.0;
        }
        g.acceptable_downscale = downscale;
        node.glass = Some(g);
        b.root(node);
    }
    b.finish()
}

/// Every shape the **texture** (noise displacement) effect can produce, plus the **noise** overlay
/// and the two chained. The fill is a sweep gradient on purpose: a displacement over a solid colour
/// only shows at the silhouette, so a solid fill would hide a regression across the entire interior.
///
/// `clip-off` is the one cell where the warp is allowed to bleed past the original coverage, which
/// is the difference the `clip_to_shape` flag exists to express.
#[must_use]
pub fn build_texture_scene() -> (Scene, Vec<(usize, &'static str)>) {
    use crate::model::EffectSlot;
    use crate::vello::effects::{noise_shader, texture_shader, NoiseSlot};

    let mut b = Build::new();
    let cell = |b: &mut Build, tex: Option<(f32, f32, bool)>, noise: bool, label: &'static str| {
        let r = b.rect();
        let mut node = Node::new(b.id(), ShapeKind::Rect);
        node.bounds = r;
        node.corners = Some(RoundedRectRadii::from_single_radius(10.0));
        node.fills = vec![Paint::plain(angular())];
        if let Some((grain, radius, clip)) = tex {
            if let Some(s) = texture_shader(grain, radius, clip, false) {
                node.upsert_effect(EffectSlot::Texture, s);
            }
        }
        if noise {
            let slots = vec![
                NoiseSlot { kind: 0, rgba: [0.05, 0.05, 0.08, 0.85] },
                NoiseSlot { kind: 1, rgba: [1.0, 0.98, 0.9, 0.6] },
            ];
            if let Some(s) = noise_shader(&slots, 14.0, 0.52, 0.28, true, false) {
                node.upsert_effect(EffectSlot::Noise, s);
            }
        }
        b.root(node);
        b.advance(label);
    };

    cell(&mut b, None, false, "no effect");
    cell(&mut b, Some((20.0, 6.0, true)), false, "texture r6");
    cell(&mut b, Some((20.0, 14.0, true)), false, "texture r14");
    cell(&mut b, Some((8.0, 14.0, true)), false, "texture fine grain");
    cell(&mut b, Some((20.0, 14.0, false)), false, "texture clip-off");
    cell(&mut b, None, true, "noise");
    cell(&mut b, Some((20.0, 10.0, true)), true, "texture + noise");
    b.finish()
}

/// Effect-ablation bits for [`build_stress_scene_mask`]: turn one effect kind off at a time and the
/// frame-time delta attributes that effect's GPU cost.
pub const FX_DROP: u32 = 1;
pub const FX_INNER: u32 = 2;
pub const FX_BLUR: u32 = 4;
pub const FX_SHADER: u32 = 8;
/// Make every shadow SHARP (blur radius 0). The shadow still rasterizes its silhouette and
/// composites, but skips the Gaussian pass-graph — so `blurred − sharp` splits a shadow's cost into
/// raster+composite vs blur.
pub const FX_SHARP: u32 = 16;
pub const FX_ALL: u32 = FX_DROP | FX_INNER | FX_BLUR | FX_SHADER;

/// [`build_stress_scene`] with an explicit shape count and an effect mask. `mask == 0` is the plain
/// baseline (bodies only, no effects) — the floor every effect variant is measured against.
#[must_use]
pub fn build_stress_scene_mask(n: usize, mask: u32) -> (Scene, Vec<(usize, &'static str)>) {
    let mut b = Build::new();
    for k in 0..n {
        let r = b.rect();
        let id = b.id();
        let mut n = Node::new(id, ShapeKind::Path);
        n.bounds = r;
        n.path = Some(blob_path(Rect::new(r.x0 + 12.0, r.y0 + 8.0, r.x1 - 12.0, r.y1 - 18.0)));
        let hue = (k * 37 % 255) as u8;
        n.fills = vec![Paint::plain(Brush::Solid(col(60 + hue / 2, 120, 200 - hue / 2)))];
        n.shadows = Vec::new();
        let sh_blur = |r: f32| if mask & FX_SHARP != 0 { 0.0 } else { r };
        if mask & FX_DROP != 0 {
            n.shadows.push(Shadow { color: cola(0, 0, 0, 150), blur: sh_blur(12.0), spread: 0.0, offset: Vec2::new(8.0, 10.0), inset: false });
            n.shadows.push(Shadow { color: cola(0, 0, 0, 120), blur: sh_blur(6.0), spread: 0.0, offset: Vec2::new(-4.0, -3.0), inset: false });
        }
        if mask & FX_INNER != 0 {
            n.shadows.push(Shadow { color: cola(0, 0, 0, 170), blur: sh_blur(7.0), spread: 0.0, offset: Vec2::new(-5.0, -6.0), inset: true });
        }
        n.blur = if mask & FX_BLUR != 0 { Some(3.0) } else { None };
        n.effects = if mask & FX_SHADER != 0 {
            vec![ShapeEffect { slot: EffectSlot::Custom, shader: tint_shader(1.0, 0.9, 0.2, 0.5) }]
        } else {
            Vec::new()
        };
        b.root(n);
        b.advance("stress");
    }
    b.finish()
}

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
