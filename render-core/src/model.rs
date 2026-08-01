//! Backend-neutral scene model — the handoff representation a non-Skia backend (e.g. Vello)
//! renders from.
//!
//! Approach B (see docs/vello-backend-plan.md): render-wasm keeps Skia internally and
//! *converts* its shapes into this model at the handoff boundary, rather than swapping Skia
//! types throughout the engine. This module therefore stays free of Skia (and of render-wasm's
//! own types) so it also compiles for a Vello/wasm-bindgen module.
//!
//! Per D12 the geometry and paint atoms come from kurbo and peniko rather than being written
//! here: `kurbo::Rect`/`Affine`/`BezPath` for geometry, `peniko::Brush` for paint. That is why
//! this file is short — what remains is only the part that is genuinely Penpot's, namely node
//! identity, the geometry family, and the draw list.

use kurbo::{Affine, BezPath, Rect, RoundedRectRadii};
use peniko::Brush;

use crate::abi::RawSegmentData;

/// A stroke: how to expand the outline, and what to paint it with.
///
/// `kurbo::Stroke` already carries width, join, caps, miter limit, dash pattern and dash
/// offset, so there is nothing to hand-write here (D12). What it does *not* carry is
/// Penpot's `StrokeKind` (inner/outer/center) — that is an offsetting decision, not a
/// stroke-style one, and is applied to the path before it reaches this model.
#[derive(Clone, Debug)]
pub struct Stroke {
    pub style: kurbo::Stroke,
    pub brush: Brush,
}

/// Penpot's stroke styles, as `RawStrokeStyle` puts them on the wire (0..3).
///
/// Neutral rather than per-backend because the *pattern each implies* has to be identical on
/// both sides or a dashed stroke diverges silently — see [`apply_stroke_style`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StrokeStyle {
    Solid,
    Dotted,
    Dashed,
    Mixed,
}

impl StrokeStyle {
    /// Decode the wire byte. Anything unknown is solid, which draws something plausible rather
    /// than nothing — the alternative is an invisible stroke that reads as a missing shape.
    pub fn from_wire(value: u8) -> Self {
        match value {
            1 => Self::Dotted,
            2 => Self::Dashed,
            3 => Self::Mixed,
            _ => Self::Solid,
        }
    }
}

/// Dash length standing in for a dot. See [`apply_stroke_style`]'s `Dotted` arm.
const DOT_LENGTH: f64 = 0.01;

/// Give `stroke` the dash pattern its style implies.
///
/// The numbers come from render-wasm's `Stroke::to_paint`, and they are arbitrary in the way
/// only shared constants can be — `width + 10`, `width + 5`, `width + 1`. Deriving them
/// separately on each side is how two backends end up drawing visibly different dashes from the
/// same document, so they live here once.
///
/// **Dotted is the interesting one.** Skia stamps circles along the path with a `path_1d`
/// effect, which kurbo has no equivalent for. A zero-length dash with round caps draws a dot of
/// diameter equal to the stroke width — and Skia's centre-stroke dot is a circle of radius
/// `width / 2`, so the two agree. That equivalence only holds for centre strokes, which are the
/// only kind this model carries (inner/outer are dropped until path offsetting exists).
pub fn apply_stroke_style(
    stroke: &mut kurbo::Stroke,
    style: StrokeStyle,
    width: f32,
    custom_dashes: &[f32],
) {
    let w = f64::from(width);
    match style {
        StrokeStyle::Solid => {}
        StrokeStyle::Dotted => {
            // A round-capped dash of (almost) no length draws a dot of diameter equal to the
            // stroke width, which is what Skia's stamped circles come to for a centre stroke.
            //
            // The length has to be *nearly* zero rather than zero: an exactly-zero dash is
            // dropped rather than drawn — verified in the browser, where the dotted stroke
            // simply did not appear — so the caps never get their chance. `DOT_LENGTH` is small
            // enough to read as round at any zoom and large enough to survive.
            stroke.dash_pattern = [DOT_LENGTH, w + 5.0 - DOT_LENGTH].into_iter().collect();
            stroke.start_cap = kurbo::Cap::Round;
            stroke.end_cap = kurbo::Cap::Round;
        }
        StrokeStyle::Dashed => {
            stroke.dash_pattern = if custom_dashes.is_empty() {
                [w + 10.0, w + 10.0].into_iter().collect()
            } else {
                custom_dashes.iter().map(|d| f64::from(*d)).collect()
            };
        }
        StrokeStyle::Mixed => {
            stroke.dash_pattern = [w + 5.0, w + 5.0, w + 1.0, w + 5.0].into_iter().collect();
        }
    }
}

/// The geometry family of a node. `Text` and the rest follow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum ShapeKind {
    Rect,
    Circle,
    /// A vector path; the geometry lives in [`Node::path`].
    Path,
    /// A container with its own geometry — it paints fills and strokes, and can clip.
    Frame,
    /// A container with no geometry of its own. Never clips; exists to group and to carry
    /// opacity, blend and masking over its children.
    Group,
}

impl ShapeKind {
    /// Whether the node holds children rather than drawing itself.
    #[inline]
    pub fn is_container(self) -> bool {
        matches!(self, Self::Frame | Self::Group)
    }
}

/// A single renderable node in neutral form.
#[derive(Clone, Debug)]
pub struct Node {
    /// Stable id (render-wasm packs its UUID as a u128).
    pub id: u128,
    pub kind: ShapeKind,
    /// Local geometry rectangle (render-wasm's `selrect`); for a path it is the bbox.
    pub bounds: Rect,
    /// Vector geometry in the node's local space, present when `kind == ShapeKind::Path`.
    pub path: Option<BezPath>,
    /// Corner radii for a `Rect`, `None` when the corners are square.
    ///
    /// Penpot's `set_shape_corners(r1, r2, r3, r4)` is top-left, top-right, bottom-right,
    /// bottom-left — the same order as [`RoundedRectRadii`]'s fields and as Skia's `RRect`
    /// radii array, so no reordering happens anywhere along the path.
    pub corners: Option<RoundedRectRadii>,
    /// The shape's own transform, exactly as it arrives on the wire.
    ///
    /// **This is not a world matrix, and it is not composed with the parent's.** Penpot stores
    /// absolute `selrect`s, so a child is already positioned in page space; a container
    /// contributes clipping and layers to its children, never geometry. render-wasm's traversal
    /// applies `scale · viewport · shape_matrix` from scratch per shape and never accumulates a
    /// parent CTM, so multiplying one in here would double-transform every nested shape.
    ///
    /// It is also *centred*: the effective matrix is
    /// `translate(c) · transform · translate(-c)` for `c = bounds.center()`, which is what makes
    /// a rotation spin about the shape rather than about the page origin. Use
    /// [`Node::effective_transform`] rather than this field directly.
    pub transform: Affine,
    /// Children, in paint order — back to front. This is the authority on ordering; [`parent`]
    /// is carried for completeness and is not used to derive it.
    ///
    /// [`parent`]: Node::parent
    pub children: Vec<u128>,
    /// Set by `set_parent`. render-wasm uses it to invalidate a container's cached bounds; a
    /// renderer does not need it, because it walks down from the root through `children`.
    pub parent: Option<u128>,
    /// Whether this node clips its children to its own geometry (Penpot's `clip_content`).
    pub clip: bool,
    /// Paints, back to front. `peniko::Brush` already covers solid, gradient and image, so
    /// gradients need no new type here — only a converter in `model_export`.
    pub fills: Vec<Brush>,
    /// Strokes, back to front, painted over the fills.
    pub strokes: Vec<Stroke>,
    pub opacity: f32,
    pub hidden: bool,
}

impl Node {
    /// An empty node: no geometry, no paint, fully opaque, visible.
    ///
    /// The wire protocol is a stream of setters against a shape that already exists, so both
    /// backends need a blank to apply them to.
    pub fn new(id: u128, kind: ShapeKind) -> Self {
        Self {
            id,
            kind,
            bounds: Rect::ZERO,
            path: None,
            corners: None,
            transform: Affine::IDENTITY,
            children: Vec::new(),
            parent: None,
            clip: false,
            fills: Vec::new(),
            strokes: Vec::new(),
            opacity: 1.0,
            hidden: false,
        }
    }

    /// The matrix to draw with: the stored transform conjugated by the shape's centre.
    ///
    /// render-wasm computes exactly this before every draw (`matrix.post_translate(center);
    /// matrix.pre_translate(-center)`). Applying [`Node::transform`] raw instead spins a
    /// rotation about the page origin, which looks like the shape flying off rather than like a
    /// wrong matrix — so it is easy to misdiagnose.
    pub fn effective_transform(&self) -> Affine {
        let c = self.bounds.center();
        Affine::translate((c.x, c.y)) * self.transform * Affine::translate((-c.x, -c.y))
    }
}

/// The id of the implicit root. Penpot's root shape is the nil UUID, and the host addresses it
/// like any other node — `use_shape(0,0,0,0)` then `set_children(…)`.
///
/// The root itself is never painted and never clips (render-wasm short-circuits on
/// `id.is_nil()`); only its children are.
pub const ROOT_ID: u128 = 0;

/// A scene as a tree: every node by id, walked from [`ROOT_ID`] through [`Node::children`].
///
/// Keyed rather than flat because the wire format addresses nodes by id and delivers them in no
/// particular order — a child can arrive before the parent that lists it.
#[derive(Clone, Debug, Default)]
pub struct Scene {
    nodes: std::collections::HashMap<u128, Node>,
}

impl Scene {
    #[inline]
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert or replace a node.
    #[inline]
    pub fn insert(&mut self, node: Node) {
        self.nodes.insert(node.id, node);
    }

    #[inline]
    pub fn get(&self, id: u128) -> Option<&Node> {
        self.nodes.get(&id)
    }

    #[inline]
    pub fn get_mut(&mut self, id: u128) -> Option<&mut Node> {
        self.nodes.get_mut(&id)
    }

    /// Pre-size the map. The host announces its shape count up front
    /// (`init_shapes_pool`), and a scene built one `use_shape` at a time would otherwise
    /// rehash its way up to that size.
    #[inline]
    pub fn reserve(&mut self, additional: usize) {
        self.nodes.reserve(additional);
    }

    #[inline]
    pub fn clear(&mut self) {
        self.nodes.clear();
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// The top-level nodes, in paint order. Empty when the host has not sent a root yet.
    pub fn roots(&self) -> &[u128] {
        self.get(ROOT_ID).map_or(&[], |root| &root.children)
    }

    /// A stable fingerprint of everything that would be drawn.
    ///
    /// This is the differential harness's primitive. Both backends build a
    /// [`Scene`] from the *same* recorded byte stream — render-vello directly in its ABI,
    /// render-wasm by projecting its Skia shapes through `model_export` — so equal digests mean
    /// the two agree on what the document *is*, independently of how either paints it. That
    /// separates "the wire format is being read differently" from "the rasterisers differ",
    /// which a pixel diff alone cannot do.
    ///
    /// Three properties it needs, and how they are obtained:
    ///
    /// - **Insensitive to storage order.** It walks the tree from [`ROOT_ID`] rather than
    ///   iterating the map, whose order is not stable between runs, let alone between backends.
    /// - **Sensitive to paint order.** Sibling order is hashed as encountered; swapping two
    ///   children changes the result, because it changes the picture.
    /// - **Covers only what paints.** Nodes unreachable from the root are skipped, as are
    ///   hidden subtrees — a backend that has garbage-collected an orphan and one that has not
    ///   still agree.
    ///
    /// Floats are hashed by bit pattern, so this is exact rather than tolerant. That is the
    /// right default for a format check; comparing rasterised output is a separate question.
    pub fn digest(&self) -> u64 {
        let mut hash = FNV_OFFSET;
        // Depth cap for the same reason the renderer has one: the tree comes off the wire and a
        // cycle would otherwise spin forever.
        for id in self.roots() {
            self.digest_node(*id, &mut hash, 0);
        }
        hash
    }

    /// How many nodes reachable from the root would actually put paint on the canvas.
    ///
    /// The companion to [`Scene::digest`], and the question a digest cannot answer: when a
    /// document renders blank, this separates "the host never delivered the shapes" (zero
    /// nodes) from "they arrived carrying nothing to draw" (nodes, but nothing paintable).
    /// Same reachability rules as the digest, so the two always describe the same subtree.
    pub fn paintable_count(&self) -> u32 {
        let mut count = 0;
        for id in self.roots() {
            self.count_paintable(*id, &mut count, 0);
        }
        count
    }

    fn count_paintable(&self, id: u128, count: &mut u32, depth: u32) {
        if depth >= MAX_DIGEST_DEPTH {
            return;
        }
        let Some(node) = self.get(id) else {
            return;
        };
        if node.hidden {
            return;
        }
        // Matches `scene::paint_self`: a group carries a layer, never geometry, and anything
        // with neither fill nor stroke is skipped before a path is even built.
        if node.kind != ShapeKind::Group && !(node.fills.is_empty() && node.strokes.is_empty()) {
            *count += 1;
        }
        for child in &node.children {
            self.count_paintable(*child, count, depth + 1);
        }
    }

    fn digest_node(&self, id: u128, hash: &mut u64, depth: u32) {
        if depth >= MAX_DIGEST_DEPTH {
            return;
        }
        let Some(node) = self.get(id) else {
            // A child listed but not yet delivered. Hash the id anyway: "referenced but absent"
            // is a real difference between two scenes, not something to paper over.
            fnv_u128(hash, id);
            fnv_u64(hash, MISSING_NODE_TAG);
            return;
        };
        if node.hidden {
            return;
        }

        fnv_u128(hash, node.id);
        fnv_u64(hash, node.kind as u64);
        for v in [
            node.bounds.x0,
            node.bounds.y0,
            node.bounds.x1,
            node.bounds.y1,
        ] {
            fnv_f64(hash, v);
        }
        for v in node.effective_transform().as_coeffs() {
            fnv_f64(hash, v);
        }
        fnv_f64(hash, f64::from(node.opacity));
        fnv_u64(hash, u64::from(node.clip));

        match node.corners {
            Some(r) => {
                fnv_u64(hash, 1);
                for v in [r.top_left, r.top_right, r.bottom_right, r.bottom_left] {
                    fnv_f64(hash, v);
                }
            }
            None => fnv_u64(hash, 0),
        }

        if let Some(path) = &node.path {
            for el in path.elements() {
                digest_path_el(hash, *el);
            }
        }

        fnv_u64(hash, node.fills.len() as u64);
        for brush in &node.fills {
            digest_brush(hash, brush);
        }
        fnv_u64(hash, node.strokes.len() as u64);
        for stroke in &node.strokes {
            digest_stroke_style(hash, &stroke.style);
            digest_brush(hash, &stroke.brush);
        }

        for child in &node.children {
            self.digest_node(*child, hash, depth + 1);
        }
    }
}

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x1000_0000_01b3;
const MISSING_NODE_TAG: u64 = 0xdead_beef;
const MAX_DIGEST_DEPTH: u32 = 128;

#[inline]
fn fnv_u64(hash: &mut u64, value: u64) {
    for byte in value.to_le_bytes() {
        *hash ^= u64::from(byte);
        *hash = hash.wrapping_mul(FNV_PRIME);
    }
}

#[inline]
fn fnv_u128(hash: &mut u64, value: u128) {
    fnv_u64(hash, value as u64);
    fnv_u64(hash, (value >> 64) as u64);
}

/// By bit pattern, so the check is exact. `-0.0` and `0.0` hash differently, which is a
/// difference the two sides genuinely could have and worth surfacing.
#[inline]
fn fnv_f64(hash: &mut u64, value: f64) {
    fnv_u64(hash, value.to_bits());
}

fn digest_path_el(hash: &mut u64, el: kurbo::PathEl) {
    use kurbo::PathEl as E;
    let (tag, points): (u64, &[kurbo::Point]) = match &el {
        E::MoveTo(p) => (1, std::slice::from_ref(p)),
        E::LineTo(p) => (2, std::slice::from_ref(p)),
        E::QuadTo(a, b) => (3, &[*a, *b]),
        E::CurveTo(a, b, c) => (4, &[*a, *b, *c]),
        E::ClosePath => (5, &[]),
    };
    fnv_u64(hash, tag);
    for p in points {
        fnv_f64(hash, p.x);
        fnv_f64(hash, p.y);
    }
}

/// Every field of the stroke style, because every one of them is visible. Hashing only the
/// width — as this did before strokes landed — would let a dash pattern or a join change slip
/// through a comparison unnoticed, which is the one thing the harness exists to prevent.
fn digest_stroke_style(hash: &mut u64, style: &kurbo::Stroke) {
    fnv_f64(hash, style.width);
    fnv_u64(hash, style.join as u64);
    fnv_u64(hash, style.start_cap as u64);
    fnv_u64(hash, style.end_cap as u64);
    fnv_f64(hash, style.miter_limit);
    fnv_f64(hash, style.dash_offset);
    fnv_u64(hash, style.dash_pattern.len() as u64);
    for d in style.dash_pattern.iter() {
        fnv_f64(hash, *d);
    }
}

fn digest_brush(hash: &mut u64, brush: &Brush) {
    match brush {
        Brush::Solid(c) => {
            fnv_u64(hash, 1);
            for component in c.components {
                fnv_f64(hash, f64::from(component));
            }
        }
        Brush::Gradient(g) => {
            fnv_u64(hash, 2);
            fnv_u64(hash, g.stops.len() as u64);
            for stop in g.stops.iter() {
                fnv_f64(hash, f64::from(stop.offset));
                for component in stop.color.components {
                    fnv_f64(hash, f64::from(component));
                }
            }
        }
        Brush::Image(_) => fnv_u64(hash, 3),
    }
}

/// Build a [`BezPath`] from decoded wire segments.
///
/// This lives here rather than in [`crate::abi`] because it produces a model type; the abi
/// module stays plain layouts so the wire can be read and diffed without the model.
///
/// Two leniencies, both matching what Skia does with the same segment stream, so the Vello
/// backend does not diverge on malformed input:
///
/// - A `line-to` or `curve-to` before any `move-to` gets an implicit `move-to` at the origin.
///   kurbo would otherwise trip a debug assertion.
/// - A `close` on an empty path is dropped.
///
/// Widening f32 to f64 is exact, so nothing is lost here (D16).
pub fn bez_path_from_raw(segments: &[RawSegmentData]) -> BezPath {
    let mut path = BezPath::new();
    let mut started = false;

    let ensure_started = |path: &mut BezPath, started: &mut bool| {
        if !*started {
            path.move_to((0.0, 0.0));
            *started = true;
        }
    };

    for segment in segments {
        match segment {
            RawSegmentData::MoveTo(c) => {
                path.move_to((c.x as f64, c.y as f64));
                started = true;
            }
            RawSegmentData::LineTo(c) => {
                ensure_started(&mut path, &mut started);
                path.line_to((c.x as f64, c.y as f64));
            }
            RawSegmentData::CurveTo(c) => {
                ensure_started(&mut path, &mut started);
                path.curve_to(
                    (c.c1_x as f64, c.c1_y as f64),
                    (c.c2_x as f64, c.c2_y as f64),
                    (c.x as f64, c.y as f64),
                );
            }
            RawSegmentData::Close => {
                if started {
                    path.close_path();
                }
            }
        }
    }

    path
}

/// Turn Penpot's four corner radii into [`RoundedRectRadii`], or `None` when every corner is
/// square. Mirrors render-wasm's `make_corners`, including its all-zero shortcut.
pub fn corners_from_raw(r1: f32, r2: f32, r3: f32, r4: f32) -> Option<RoundedRectRadii> {
    let square = [r1, r2, r3, r4].iter().all(|r| r.abs() <= f32::EPSILON);

    (!square).then(|| RoundedRectRadii::new(r1 as f64, r2 as f64, r3 as f64, r4 as f64))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi::{RawCurveCommand, RawLineCommand, RawMoveCommand};
    use kurbo::{PathEl, Point};
    use peniko::Color;

    fn node(id: u128, kind: ShapeKind) -> Node {
        Node::new(id, kind)
    }

    #[test]
    fn builds_a_minimal_scene() {
        let mut scene = Scene::new();
        let mut n = node(42, ShapeKind::Rect);
        n.bounds = Rect::new(0.0, 0.0, 100.0, 50.0);
        n.fills = vec![Brush::Solid(Color::from_rgba8(255, 0, 0, 255))];
        scene.insert(n);

        assert_eq!(scene.len(), 1);
        let got = scene.get(42).unwrap();
        assert_eq!(
            got.fills[0],
            Brush::Solid(Color::from_rgba8(255, 0, 0, 255))
        );
        assert_eq!(got.bounds.width(), 100.0);
    }

    #[test]
    fn builds_a_path_node() {
        let mut path = BezPath::new();
        path.move_to((0.0, 0.0));
        path.line_to((10.0, 0.0));
        path.curve_to((11.0, 1.0), (12.0, 2.0), (10.0, 10.0));
        path.close_path();

        let mut n = node(7, ShapeKind::Path);
        n.bounds = Rect::new(0.0, 0.0, 12.0, 10.0);
        n.path = Some(path);
        assert_eq!(n.kind, ShapeKind::Path);

        let els = n.path.as_ref().unwrap().elements();
        assert_eq!(els.len(), 4);
        assert_eq!(els[0], PathEl::MoveTo(Point::new(0.0, 0.0)));
        assert_eq!(els[3], PathEl::ClosePath);
    }

    /// A child can arrive before the parent that lists it, which is why the scene is keyed
    /// rather than ordered. `roots()` must not care.
    #[test]
    fn roots_come_from_the_root_node_regardless_of_insertion_order() {
        let mut scene = Scene::new();
        assert!(scene.roots().is_empty());

        scene.insert(node(20, ShapeKind::Rect));

        let mut root = node(ROOT_ID, ShapeKind::Group);
        root.children = vec![10, 20];
        scene.insert(root);
        scene.insert(node(10, ShapeKind::Rect));

        assert_eq!(scene.roots(), &[10, 20]);
        assert_eq!(scene.len(), 3);
        assert!(scene.get(999).is_none());
    }

    /// The centring is what makes a rotation spin about the shape instead of the page origin.
    #[test]
    fn effective_transform_is_centred_on_the_bounds() {
        let mut n = node(1, ShapeKind::Rect);
        n.bounds = Rect::new(10.0, 20.0, 30.0, 40.0); // centre (20, 30)
        n.transform = Affine::rotate(std::f64::consts::FRAC_PI_2);

        // A quarter turn about the centre leaves the centre fixed.
        let centre = Point::new(20.0, 30.0);
        let moved = n.effective_transform() * centre;
        assert!((moved - centre).hypot() < 1e-9);

        // Applying the raw transform instead would swing it right across the page.
        let naive = n.transform * centre;
        assert!((naive - centre).hypot() > 1.0);
    }

    #[test]
    fn identity_transform_is_unaffected_by_centring() {
        let mut n = node(1, ShapeKind::Rect);
        n.bounds = Rect::new(5.0, 5.0, 15.0, 25.0);
        assert_eq!(n.effective_transform(), Affine::IDENTITY);
    }

    /// Builds the same little tree twice, inserting in different orders.
    fn tree(order: &[usize]) -> Scene {
        let mut root = node(ROOT_ID, ShapeKind::Group);
        root.children = vec![1, 2];

        let mut a = node(1, ShapeKind::Rect);
        a.bounds = Rect::new(0.0, 0.0, 10.0, 10.0);
        a.fills = vec![Brush::Solid(Color::from_rgba8(1, 2, 3, 255))];

        let mut b = node(2, ShapeKind::Circle);
        b.bounds = Rect::new(20.0, 20.0, 40.0, 40.0);

        let parts = [root, a, b];
        let mut scene = Scene::new();
        for i in order {
            scene.insert(parts[*i].clone());
        }
        scene
    }

    /// The property the whole harness rests on: two backends storing the same scene in
    /// different orders must agree. A digest that iterated the map would fail this at random.
    #[test]
    fn digest_ignores_insertion_order() {
        assert_eq!(tree(&[0, 1, 2]).digest(), tree(&[2, 1, 0]).digest());
        assert_eq!(tree(&[1, 0, 2]).digest(), tree(&[0, 2, 1]).digest());
    }

    /// …and it must still notice paint order, because that changes the picture.
    #[test]
    fn digest_notices_sibling_order() {
        let mut swapped = tree(&[0, 1, 2]);
        swapped.get_mut(ROOT_ID).unwrap().children = vec![2, 1];
        assert_ne!(tree(&[0, 1, 2]).digest(), swapped.digest());
    }

    #[test]
    fn digest_notices_every_drawable_property() {
        let base = tree(&[0, 1, 2]).digest();

        let mutate = |f: &dyn Fn(&mut Node)| {
            let mut s = tree(&[0, 1, 2]);
            f(s.get_mut(1).unwrap());
            s.digest()
        };

        assert_ne!(
            base,
            mutate(&|n| n.bounds = Rect::new(0.0, 0.0, 10.0, 11.0))
        );
        assert_ne!(base, mutate(&|n| n.opacity = 0.5));
        assert_ne!(base, mutate(&|n| n.clip = true));
        assert_ne!(base, mutate(&|n| n.transform = Affine::rotate(0.1)));
        assert_ne!(base, mutate(&|n| n.kind = ShapeKind::Path));
        assert_ne!(
            base,
            mutate(&|n| n.corners = Some(RoundedRectRadii::new(1.0, 1.0, 1.0, 1.0)))
        );
        assert_ne!(
            base,
            mutate(&|n| n.fills = vec![Brush::Solid(Color::from_rgba8(9, 9, 9, 255))])
        );
        assert_ne!(base, mutate(&|n| n.fills.clear()));
    }

    /// Unreachable nodes are memory, not picture. One backend garbage-collecting an orphan and
    /// another keeping it around is not a divergence worth failing a diff over.
    #[test]
    fn digest_skips_orphans_and_hidden_subtrees() {
        let mut with_orphan = tree(&[0, 1, 2]);
        with_orphan.insert(node(99, ShapeKind::Rect));
        assert_eq!(tree(&[0, 1, 2]).digest(), with_orphan.digest());

        let mut hidden = tree(&[0, 1, 2]);
        hidden.get_mut(1).unwrap().hidden = true;
        assert_ne!(tree(&[0, 1, 2]).digest(), hidden.digest());
    }

    /// A child listed but not delivered is a real difference, not something to smooth over —
    /// it is exactly the mid-sync state where the two backends could disagree.
    #[test]
    fn digest_notices_a_missing_child() {
        let mut incomplete = tree(&[0, 1, 2]);
        incomplete.get_mut(ROOT_ID).unwrap().children = vec![1, 2, 3];
        assert_ne!(tree(&[0, 1, 2]).digest(), incomplete.digest());
    }

    #[test]
    fn digest_of_an_empty_scene_is_stable() {
        assert_eq!(Scene::new().digest(), Scene::new().digest());
        assert_ne!(Scene::new().digest(), tree(&[0, 1, 2]).digest());
    }

    /// The diagnostic this exists for: a blank canvas with a healthy node count. In `tree`, only
    /// node 1 carries a fill — node 2 has bounds and nothing to draw with, so it is delivered but
    /// not paintable, and the count says so.
    #[test]
    fn paintable_count_counts_only_what_would_draw() {
        assert_eq!(tree(&[0, 1, 2]).paintable_count(), 1);
        assert_eq!(Scene::new().paintable_count(), 0);

        // A scene the host filled in but never parented: every node present, nothing drawn.
        let mut unrooted = tree(&[0, 1, 2]);
        unrooted.get_mut(ROOT_ID).unwrap().children.clear();
        assert_eq!(unrooted.paintable_count(), 0);

        let mut hidden = tree(&[0, 1, 2]);
        hidden.get_mut(1).unwrap().hidden = true;
        assert_eq!(hidden.paintable_count(), 0);

        // A group is a layer, never geometry — a fill on one paints nothing, matching
        // `scene::paint_self`.
        let mut group = tree(&[0, 1, 2]);
        group.get_mut(1).unwrap().kind = ShapeKind::Group;
        assert_eq!(group.paintable_count(), 0);

        // A stroke alone is enough to put paint down.
        let mut stroked = tree(&[0, 1, 2]);
        let n = stroked.get_mut(2).unwrap();
        n.strokes = vec![Stroke {
            style: kurbo::Stroke::new(2.0),
            brush: Brush::Solid(Color::from_rgba8(0, 0, 0, 255)),
        }];
        assert_eq!(stroked.paintable_count(), 2);
    }

    #[test]
    fn containers_are_distinguishable() {
        assert!(ShapeKind::Frame.is_container());
        assert!(ShapeKind::Group.is_container());
        assert!(!ShapeKind::Rect.is_container());
        assert!(!ShapeKind::Path.is_container());
    }

    #[test]
    fn builds_a_bez_path_from_wire_segments() {
        let segments = [
            RawSegmentData::MoveTo(RawMoveCommand::new((0.0, 0.0))),
            RawSegmentData::LineTo(RawLineCommand::new((10.0, 0.0))),
            RawSegmentData::CurveTo(RawCurveCommand::new((11.0, 1.0), (12.0, 2.0), (10.0, 10.0))),
            RawSegmentData::Close,
        ];

        let els = bez_path_from_raw(&segments).elements().to_vec();
        assert_eq!(els.len(), 4);
        assert_eq!(els[0], PathEl::MoveTo(Point::new(0.0, 0.0)));
        assert_eq!(els[1], PathEl::LineTo(Point::new(10.0, 0.0)));
        assert_eq!(
            els[2],
            PathEl::CurveTo(
                Point::new(11.0, 1.0),
                Point::new(12.0, 2.0),
                Point::new(10.0, 10.0)
            )
        );
        assert_eq!(els[3], PathEl::ClosePath);
    }

    /// Malformed streams must behave like Skia's, not panic — kurbo asserts on a `line_to`
    /// with no current point, and a lone `close` has nothing to close.
    #[test]
    fn tolerates_segments_without_a_leading_move() {
        let els = bez_path_from_raw(&[RawSegmentData::LineTo(RawLineCommand::new((5.0, 5.0)))])
            .elements()
            .to_vec();
        assert_eq!(els[0], PathEl::MoveTo(Point::new(0.0, 0.0)));
        assert_eq!(els[1], PathEl::LineTo(Point::new(5.0, 5.0)));

        assert!(bez_path_from_raw(&[RawSegmentData::Close]).is_empty());
        assert!(bez_path_from_raw(&[]).is_empty());
    }

    #[test]
    fn corners_map_in_penpot_order_and_collapse_when_square() {
        assert_eq!(corners_from_raw(0.0, 0.0, 0.0, 0.0), None);

        let r = corners_from_raw(1.0, 2.0, 3.0, 4.0).unwrap();
        assert_eq!(r.top_left, 1.0);
        assert_eq!(r.top_right, 2.0);
        assert_eq!(r.bottom_right, 3.0);
        assert_eq!(r.bottom_left, 4.0);
    }

    /// kurbo is f64 where render-wasm's Skia geometry is f32, so widening is exact and the
    /// neutral model can represent everything the Skia side holds.
    #[test]
    fn f32_geometry_widens_exactly() {
        let x: f32 = 0.1;
        let r = Rect::new(x as f64, 0.0, 1.0, 1.0);
        assert_eq!(r.x0 as f32, x);
    }
}
