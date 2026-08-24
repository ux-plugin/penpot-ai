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

/// Paint colour or pattern, backend-neutral.
///
/// Solid and gradient are peniko's — they carry their own pixels and both backends draw them
/// straight. An **image** cannot be: render-wasm holds a Skia texture and render-vello a wgpu
/// one, and the shared model can hold neither. So [`Brush::Image`] is a *reference* — the image's
/// id and where it sits — that each backend resolves against its own image store at paint time.
/// This is exactly how render-wasm already works internally: a fill names an id, the `ImageStore`
/// owns the pixels.
///
/// It shadows `peniko::Brush` deliberately, with the same `Solid`/`Gradient` shapes, so every
/// existing construction site compiles unchanged; `Image` and `Diamond` are the additions.
///
/// **Diamond** is Penpot's fourth gradient — the same stops sampled along the L1 (Manhattan)
/// distance `|x| + |y|` instead of a radius or an angle. peniko has no such kind and Vello no
/// built-in for it; render-wasm draws it with a small SkSL shader. So like an image it is carried
/// here as data both backends can hash — its geometry and stops — even though painting it in
/// Vello needs the D10 custom-shader path (or a bake). Dropping it, as both sides used to, made a
/// diamond fill hash identically to *no fill at all*, so the harness was blind to it.
#[derive(Clone, Debug, PartialEq)]
pub enum Brush {
    Solid(peniko::Color),
    Gradient(peniko::Gradient),
    Image(ImageFill),
    Diamond(DiamondGradient),
}

/// A diamond (L1-distance) gradient, carried as its raw geometry and stops — see [`Brush::Diamond`].
///
/// The geometry is the same `start`/`end`/`width` triple every Penpot gradient uses; only the
/// distance metric at paint time differs. Held un-resolved because the resolution *is* the
/// shader, which the neutral model cannot express.
#[derive(Clone, Debug, PartialEq)]
pub struct DiamondGradient {
    pub geometry: crate::gradient::GradientGeometry,
    pub stops: peniko::ColorStops,
}

impl DiamondGradient {
    /// A stable id for the *baked* tile of this diamond, so a backend that draws it by baking to a
    /// texture (Vello) caches the bake and reuses it while the parameters are unchanged.
    ///
    /// It is a content hash of the geometry and stops, in the top nibble of an id space real
    /// image uuids do not occupy (Penpot's are v4, whose high bits are not this marker) — so a
    /// baked diamond and a fetched image never resolve to each other's atlas slot. The collision
    /// risk beyond that is a full 64-bit hash match, which is negligible.
    pub fn content_key(&self) -> u128 {
        let mut hash = FNV_OFFSET;
        let g = &self.geometry;
        for (x, y) in [g.start, g.end, g.width] {
            fnv_f64(&mut hash, f64::from(x));
            fnv_f64(&mut hash, f64::from(y));
        }
        fnv_u64(&mut hash, self.stops.len() as u64);
        for stop in self.stops.iter() {
            fnv_f64(&mut hash, f64::from(stop.offset));
            for component in stop.color.components {
                fnv_f64(&mut hash, f64::from(component));
            }
        }
        (DIAMOND_KEY_MARKER << 64) | u128::from(hash)
    }
}

/// Top 64 bits of a baked-diamond id — see [`DiamondGradient::content_key`].
const DIAMOND_KEY_MARKER: u128 = 0xD1A;

/// An image fill as a reference, not pixels — see [`Brush::Image`].
///
/// Mirrors render-wasm's `shapes::ImageFill` and the `RawImageFillData` wire record field for
/// field, so the projection from either side lands on identical values and the digest agrees.
#[derive(Clone, Debug, PartialEq)]
pub struct ImageFill {
    /// The image's stable id — render-wasm packs its UUID as a u128.
    pub id: u128,
    /// Native pixel dimensions, as the wire reports them.
    pub width: u32,
    pub height: u32,
    /// `0..=255`; Penpot stores fill opacity as a byte.
    pub opacity: u8,
    /// Whether the image is letterboxed to its aspect ratio rather than stretched to the box.
    pub keep_aspect: bool,
    /// Optional destination sub-rect in the shape's local (selrect) coords. When set, the image
    /// draws only there — used to composite a viewport-clipped 3D bake at its correct place.
    pub dest: Option<Rect>,
}

use crate::abi::RawSegmentData;

/// What to paint with, and where that paint sits.
///
/// The transform exists because peniko's `Gradient` has nowhere to put a matrix, and Penpot's
/// radial and angular gradients need one: a rotation and an ellipse ratio for radial, and for
/// angular a pair of axes that need not be perpendicular. `render_core::gradient` builds both
/// halves together, so neither backend has to re-derive the matrix from the raw fields.
///
/// It is expressed in the shape's **unit box** — the `0..1` space Penpot's gradient coordinates
/// live in — so a renderer applies `unit_box_to(bounds) · transform`. Solid paint leaves it at
/// the identity and costs nothing.
#[derive(Clone, Debug, PartialEq)]
pub struct Paint {
    pub brush: Brush,
    pub transform: Affine,
}

impl Paint {
    /// Paint with no placement of its own — every solid fill, and every linear gradient, whose
    /// endpoints already say everything about where it goes.
    pub fn plain(brush: Brush) -> Self {
        Self {
            brush,
            transform: Affine::IDENTITY,
        }
    }
}

/// Where a stroke sits relative to the shape's outline — Penpot's `StrokeKind`. `Center` straddles
/// the edge (the plain `kurbo::Stroke` behaviour); `Inner`/`Outer` keep the whole stroke on one side.
/// A backend renders inner/outer by stroking at double width and clipping to (inner) or erasing
/// (outer) the shape's own fill region — the classic image-filter trick, no path offsetting needed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum StrokeAlign {
    /// Centred on the outline — half inside, half outside.
    #[default]
    Center,
    /// Entirely inside the shape.
    Inner,
    /// Entirely outside the shape.
    Outer,
}

/// A stroke: how to expand the outline, and what to paint it with.
///
/// `kurbo::Stroke` already carries width, join, caps, miter limit, dash pattern and dash
/// offset. Penpot's `StrokeKind` (inner/outer/center) rides in [`Stroke::align`] — an offsetting
/// decision, not a stroke-style one, applied by the backend when it renders the stroke.
#[derive(Clone, Debug)]
pub struct Stroke {
    pub style: kurbo::Stroke,
    pub paint: Paint,
    pub align: StrokeAlign,
}

/// A drop shadow: a blurred, offset silhouette of the shape in [`Shadow::color`], drawn behind it.
///
/// Both drop and inner (inset) shadows reach this model, distinguished by [`Shadow::inset`]: a drop
/// shadow is drawn behind the shape, an inner shadow inside it (via the fork's `InnerShadow`
/// primitive). The blur is a **radius** (see [`crate::blur::radius_to_sigma`]); `spread` grows a
/// drop shadow's silhouette (inner shadows ignore it, matching render-wasm).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shadow {
    pub color: peniko::Color,
    pub blur: f32,
    pub spread: f32,
    pub offset: kurbo::Vec2,
    /// `true` for an inner (inset) shadow, `false` for a drop shadow.
    pub inset: bool,
}

/// One pass in a [`FilterGraph`]. render-vello lowers each to a vello-fork filter primitive and
/// nests them (the linear chain becomes nested filter layers). This is a Vello-only feature — the
/// backends no longer share a shader language, and there are no Skia users of effects — so the
/// neutral model carries only what render-vello needs and render-wasm projects `None`.
///
/// `Custom` is the raw-shader escape hatch: `effect` selects a WGSL branch in the fork's
/// `custom_effect` hook (effect 0 = tint, `params = [r, g, b, amount]`). The typed variants
/// (`Blur`, `Offset`) exist so the engine can reason about them (bounds expansion, algorithm,
/// caching) rather than treating them as opaque code. Branching/merge nodes come later — they need
/// the fork's multi-primitive graph, which linear nesting does not.
#[derive(Clone, Debug, PartialEq)]
pub enum FilterNode {
    /// Gaussian blur by `sigma` (already a sigma, not a radius).
    Blur { sigma: f32 },
    /// Translate the input by `(dx, dy)` in the shape's own space.
    Offset { dx: f32, dy: f32 },
    /// An inner (inset) shadow: a blurred, offset shadow drawn *inside* the shape.
    InnerShadow { dx: f32, dy: f32, sigma: f32, color: peniko::Color },
    /// A hand-written shader branch: `effect` indexes the host's shader table, `params` are its flat
    /// uniforms. Named to match [`crate::effect::Op::Shader`], the op it runs as.
    Shader { effect: u32, params: Vec<f32> },
}

/// A linear chain of filter passes wrapping a shape and its children. `nodes` is in **application
/// order** — `nodes[0]` runs first (innermost), the last runs last (outermost) — which render-vello
/// realises by pushing nested filter layers in reverse. Empty means no effect (kept as `None` on the
/// node instead).
#[derive(Clone, Debug, PartialEq)]
pub struct FilterGraph {
    pub nodes: Vec<FilterNode>,
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
    /// A shape whose kind neither backend draws yet — Text, Bool, SVGRaw. It exists so the two
    /// projection styles can agree: render-wasm's batch projection *drops* an unsupported shape
    /// (`node_from_shape` returns `None`, so the parent lists an absent child), while
    /// render-vello's streaming ABI has already created the node and instead *marks* it. The
    /// digest hashes this variant exactly like a missing node (see [`Scene::digest`]), so the
    /// drop and the mark reconcile to the same hash. Renderers and the paintable/diamond walks
    /// treat it as inert.
    ///
    /// **Keep new variants appended after this one.** The digest hashes `kind as u64`, so
    /// inserting a variant mid-enum shifts every discriminant and silently changes every digest —
    /// the same ordering trap as render-wasm's `RawShapeType`.
    Unsupported,
    /// A text shape. Unlike every other kind it carries no geometry of its own — the glyphs are
    /// shaped from [`Node::text`] by each backend (Skia one side, Parley the other), not stored
    /// resolved. Appended after `Unsupported` so the existing discriminants — and every digest
    /// built before text existed — stay put.
    Text,
    /// A raw-SVG shape. Its markup lives in [`Node::svg`]; each backend parses it (Skia's SVG DOM one
    /// side, usvg → the shared `RenderingContext` the other) and draws it scaled into the node's
    /// bounds. Appended after `Text` so existing discriminants and digests stay put.
    Svg,
}

impl ShapeKind {
    /// Whether the node holds children rather than drawing itself.
    #[inline]
    pub fn is_container(self) -> bool {
        matches!(self, Self::Frame | Self::Group)
    }
}

/// How a **scoped** gather fills the region past its scope's content — the analog of Skia's
/// `SkTileMode` for the scope backdrop. Only meaningful for a gather inside an isolated scope: past
/// the scope's painted content the backdrop has no pixels, and this picks what the effect reads there.
/// A top-level (page-scoped) gather is unaffected — its backdrop is the page.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum TileMode {
    /// Transparent outside the scope (Skia `Decal`): the lens is clear there and the real canvas
    /// behind it shows through. Physically correct for glass; the default.
    #[default]
    Decal,
    /// Extend the scope's edge pixels outward (Skia `Clamp`): the lens looks "full", no hard cutoff.
    Clamp,
    /// Opaque black outside the scope: the lens shows a black block there, occluding the canvas.
    Black,
}

/// A frosted-glass **gather** effect — a lens over the backdrop beneath the shape. Ported field for
/// field from render-wasm's `GlassEffect` so the same three-pass pipeline (refraction/displacement,
/// blur, frost/tint/specular composite) drives both backends. The glass outline is the shape's
/// rounded box; `surface_type` is the *bezel* profile, not the outline. Like `background_blur` this
/// is gather, not spread — it reads the backdrop, so it interleaves in z-order.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Glass {
    /// Bezel profile: 0 circle, 1 squircle, 2 concave, 3 lip.
    pub surface_type: i32,
    pub bezel_width: f32,
    /// `glass_thickness` — refraction strength multiplier (0.2–3.0).
    pub thickness: f32,
    pub refractive_index: f32,
    pub specular_angle: f32,
    pub specular_opacity: f32,
    pub specular_saturation: f32,
    pub chromatic_aberration: f32,
    pub splay: f32,
    pub tilt_angle: f32,
    pub edge_boost: f32,
    pub zoom: f32,
    pub blur: f32,
    pub frost: f32,
    /// Quality floor `k ∈ (0, 1]` — the *free* downscale this lens tolerates (see
    /// [`CustomShader::acceptable_downscale`]). `1.0` (default) renders the lens at full device resolution; a
    /// soft/zoom lens declares less, and the whole gather surface renders at `min(cap, acceptable_downscale)`
    /// and upscales at the stamp. Independent of the memory cap (which is forced by `reach · zoom`).
    pub acceptable_downscale: f32,
    /// How the lens fills the area past its **scope's** content (see [`TileMode`]). Only affects a
    /// scoped lens crossing outside its isolated scope; `Decal` (default) leaves it clear.
    pub tile_mode: TileMode,
}

impl Glass {
    /// Combined blur sigma — the explicit blur plus the frost's own softening.
    #[must_use]
    pub fn total_blur_sigma(&self) -> f32 {
        self.blur + self.frost * 8.0
    }
}

/// A **custom** gather effect: a hand-written WGSL fragment shader over the backdrop beneath the
/// shape — the raw escape hatch that sits under the typed presets (blur, glass).
///
/// Its footprint is **required to be declared**, never guessed: `reads_backdrop` says whether
/// `@binding(2)` is the composited backdrop beneath the shape (a **gather** — z-serial, needs a
/// backdrop surface) or the shape's own body (a **spread**, like a layer blur — no backdrop, cheaper,
/// batches around it), and `reach` is the page-space extent it samples (0 = pointwise). There is no
/// worst-case default: every custom must state what it reads and how far, and the scheduler sizes and
/// batches it from that declaration exactly as it does a built-in unit. A shader that genuinely samples
/// the backdrop widely says so with a large `reach`, which the resolution cap bounds like any other —
/// "reads everything" is an explicit declaration a shader opts into, not a fallback the planner assumes.
/// `params` are the uniform floats the shader reads (packed after the resolution).
#[derive(Clone, Debug, PartialEq)]
pub struct CustomShader {
    /// A complete WGSL module: a `@vertex fn vs` + `@fragment fn fs`, reading `@binding(0)` uniform
    /// `array<vec4<f32>, N>` (resolution in `u[0].xy`, then `params`), `@binding(1)` sampler,
    /// `@binding(2)` the input texture (the backdrop if `reads_backdrop`, else the shape's own body).
    pub wgsl: String,
    /// Author-declared page-space reach (how far past the shape it samples).
    pub reach: f32,
    /// The exact size of `@binding(0)` — the literal `N` in the shader's `array<vec4<f32>, N>`. This is
    /// the single declaration that makes param-count mismatch impossible: the backend sizes the uniform
    /// buffer to *exactly* `param_vec4s` vec4s (= `param_vec4s * 4` floats), zero-filling a short
    /// [`params`](Self::params) and truncating a long one, so the bound buffer always matches what the
    /// shader declares. No runtime-sized arrays, no robust-access fallbacks — one number, honoured.
    pub param_vec4s: u32,
    /// Uniform floats the shader reads, packed after the surface resolution (`u[0].xy`). Need not fill
    /// `param_vec4s` vec4s exactly; the backend pads/truncates to the declared size.
    pub params: Vec<f32>,
    /// Whether the shader samples the backdrop beneath the shape (gather) or only its own body
    /// (spread). Required — a custom must declare what it reads; there is no worst-case default.
    pub reads_backdrop: bool,
    /// Author-declared **quality floor** `k ∈ (0, 1]`: the smallest fraction of device resolution this
    /// effect can be rendered at (then upscaled ×1/k) with acceptable quality. This is distinct from the
    /// memory cap — the cap is forced by `reach · zoom` to avoid OOM; `acceptable_downscale` is the *free*
    /// downsample the effect tolerates. `1.0` = must render at native (assume sharp — the safe default
    /// for an unknown shader). A blurry effect declares a low value; a crisp one leaves it `1.0`. The
    /// effective render scale is `min(resolution_cap(reach), acceptable_downscale)`.
    pub acceptable_downscale: f32,
}

/// Which authored effect a [`ShapeEffect`] came from — its identity for upsert/clear on the wire.
/// A shape can carry at most one effect per slot; re-setting a slot updates it in place (keeping its
/// position in the chain), and clearing removes just that slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EffectSlot {
    /// The fractal-noise displacement warp (`set_shape_texture`).
    Texture,
    /// The coloured fractal-noise grain (`set_shape_noise`).
    Noise,
    /// The raw WGSL escape hatch (`set_shape_custom_shader`).
    Custom,
}

/// One authored effect on a shape: a [`CustomShader`] plus the [`EffectSlot`] it was set from.
///
/// A node's [`effects`](Node::effects) list is **ordered**, and the order *is* the pipeline: each
/// spread effect reads the previous effect's output, so `[texture, noise]` warps the body then colours
/// the warped result. This is the "a list of effects is one shader graph, output → next input" model —
/// the chain is realized as consecutive spread passes (`Src::Pass(n)` feeding the next), fusible into a
/// single shader later where no blur/gather barrier sits between them.
#[derive(Clone, Debug, PartialEq)]
pub struct ShapeEffect {
    pub slot: EffectSlot,
    pub shader: CustomShader,
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
    /// Text content, present when `kind == ShapeKind::Text`. Carries the paragraphs/spans the host
    /// sent, not resolved glyphs — each backend shapes it against its own fonts. The box it flows
    /// in is [`Node::bounds`]. See [`crate::text`].
    pub text: Option<crate::text::TextBlock>,
    /// Raw SVG markup, present when `kind == ShapeKind::Svg`. Each backend parses and draws it into
    /// [`Node::bounds`] (Skia's SVG DOM / usvg). Not resolved to geometry here — kept as the source.
    pub svg: Option<String>,
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
    /// Whether this node is a **masked group**: its first (bottom-most) child is a mask that clips
    /// the rest to its silhouette. Only ever true on a [`ShapeKind::Group`] — Penpot sets it via
    /// `set_shape_masked_group`, and every other kind leaves it `false`.
    ///
    /// This is the *interpretation* of the existing `children` list, not new geometry: `children`
    /// still lists mask and content together in paint order, so the digest already sees them; this
    /// flag records that the first is consumed as the mask rather than drawn. The neutral model
    /// stops there — how faithfully a backend honours the mask (a hard clip for an opaque mask, a
    /// true DstIn alpha for a soft one) is a rendering decision, not part of what the document *is*.
    pub masked: bool,
    /// Paints, back to front. Solid and gradient carry their own pixels; an image is a
    /// reference each backend resolves against its own store — see [`Brush`].
    pub fills: Vec<Paint>,
    /// Strokes, back to front, painted over the fills.
    pub strokes: Vec<Stroke>,
    pub opacity: f32,
    /// How this node (its own paint *and* its children) composites against the backdrop. The
    /// default is [`crate::blend::DEFAULT_BLEND`] — plain source-over — which needs no layer at
    /// all; anything else is drawn under a blend layer.
    pub blend: peniko::BlendMode,
    /// Layer-blur **radius**, `None` when the shape has no layer blur. Blurs the node's own paint
    /// and its children together, like [`opacity`](Node::opacity).
    pub blur: Option<f32>,
    /// Background-blur **radius**, `None` when the shape has none. Unlike [`blur`](Node::blur) (a
    /// *spread* effect over the node's own paint), this is a *gather* effect: it blurs the backdrop
    /// **beneath** the shape and shows it through the shape's silhouette (frosted glass). Because it
    /// reads what is already painted below, it forces true z-order interleaving in the scheduler.
    pub background_blur: Option<f32>,
    /// A backdrop **tint**, `None` when the shape has none. A pointwise gather: it multiplies the
    /// backdrop beneath the shape by this straight colour and shows it through the shape's silhouette.
    /// Unlike [`background_blur`](Node::background_blur) it has no neighbourhood, so it is the first
    /// effect to run inline in `fine` (effects-in-fine) rather than as a post-fine dispatch.
    pub background_tint: Option<peniko::Color>,
    /// A synthetic **field-measured** backdrop tint used to exercise the inline field VM: the tint
    /// fades from full at the silhouette centre to none at its edge, driven per-pixel by the baked
    /// radial field program (program 3, `mix(backdrop, tint, mask)`). It is scaffolding for the
    /// effects-in-fine field path, not an authored effect. `None` when the shape has none.
    pub background_field: Option<peniko::Color>,
    /// A frosted-glass gather effect (refraction lens), `None` when the shape has none. Like
    /// [`background_blur`](Node::background_blur) it reads the backdrop beneath — a gather effect.
    pub glass: Option<Glass>,
    /// The shape's authored effects, in application order. Each is a [`CustomShader`] (a built-in
    /// texture/noise preset or the raw WGSL escape hatch) tagged with its [`EffectSlot`]. The order is
    /// the pipeline: consecutive spread effects chain (output → next input); a backdrop-reading effect
    /// is a gather. See [`ShapeEffect`] and the accessors below ([`spread_shaders`](Node::spread_shaders),
    /// [`gather_shader`](Node::gather_shader)).
    pub effects: Vec<ShapeEffect>,
    /// Drop shadows, back to front, drawn behind the shape. Inner shadows do not reach here.
    pub shadows: Vec<Shadow>,
    /// A chain of custom filter passes wrapping the shape + children, or `None`. Vello-only —
    /// render-wasm projects `None`. Drawn as nested filter layers ([`FilterGraph`]).
    pub filter_graph: Option<FilterGraph>,
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
            text: None,
            svg: None,
            corners: None,
            transform: Affine::IDENTITY,
            children: Vec::new(),
            parent: None,
            clip: false,
            masked: false,
            fills: Vec::new(),
            strokes: Vec::new(),
            opacity: 1.0,
            blend: crate::blend::DEFAULT_BLEND,
            blur: None,
            background_blur: None,
            background_tint: None,
            background_field: None,
            glass: None,
            effects: Vec::new(),
            shadows: Vec::new(),
            filter_graph: None,
            hidden: false,
        }
    }

    /// The spread effects (body-only shaders) in application order — the chain that warps/colours the
    /// shape's own paint. Each reads the previous one's output.
    pub fn spread_shaders(&self) -> impl Iterator<Item = &CustomShader> {
        self.effects.iter().map(|e| &e.shader).filter(|c| !c.reads_backdrop)
    }

    /// The same body-only spread effects, each with the slot that produced it — the backend needs the
    /// slot to tell an effect it can lower natively from one it can only run as WGSL.
    pub fn spread_effects(&self) -> impl Iterator<Item = (EffectSlot, &CustomShader)> {
        self.effects.iter().filter(|e| !e.shader.reads_backdrop).map(|e| (e.slot, &e.shader))
    }

    /// The (first) backdrop-reading effect — the custom *gather* shader, if any. A shape carries at
    /// most one gather custom shader alongside the typed glass/background-blur gathers.
    pub fn gather_shader(&self) -> Option<&CustomShader> {
        self.effects.iter().map(|e| &e.shader).find(|c| c.reads_backdrop)
    }

    /// Whether any effect is a body-only spread shader.
    pub fn has_spread_shader(&self) -> bool {
        self.effects.iter().any(|e| !e.shader.reads_backdrop)
    }

    /// The largest page-space reach over the spread shaders — how far past the silhouette the chain
    /// samples, so the spread surface is padded to hold it.
    pub fn max_spread_reach(&self) -> f32 {
        self.spread_shaders().map(|c| c.reach).fold(0.0, f32::max)
    }

    /// Insert or update the effect in `slot`, preserving its position in the chain when it already
    /// exists (a param edit) and appending in call order when it is new.
    pub fn upsert_effect(&mut self, slot: EffectSlot, shader: CustomShader) {
        if let Some(e) = self.effects.iter_mut().find(|e| e.slot == slot) {
            e.shader = shader;
        } else {
            self.effects.push(ShapeEffect { slot, shader });
        }
    }

    /// Remove the effect in `slot`, if present.
    pub fn remove_effect(&mut self, slot: EffectSlot) {
        self.effects.retain(|e| e.slot != slot);
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

    /// Iterate every node in the scene (unordered). Used by frame-wide passes that must inspect all
    /// shapes regardless of tree position — e.g. finding the gathers whose backdrop a dirty rect
    /// touches, so a multi-tile lens re-renders atomically.
    #[inline]
    pub fn iter_nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
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
        if node.kind == ShapeKind::Unsupported {
            return;
        }
        let paints = if node.kind == ShapeKind::Text {
            node.text.as_ref().is_some_and(|t| !t.is_empty())
        } else {
            node.kind != ShapeKind::Group && !(node.fills.is_empty() && node.strokes.is_empty())
        };
        if paints {
            *count += 1;
        }
        for child in &node.children {
            self.count_paintable(*child, count, depth + 1);
        }
    }

    /// Every diamond gradient reachable from the root, fills and strokes both.
    ///
    /// A backend that paints diamonds by baking (Vello) needs this before it draws, to bake the
    /// ones it has not seen — the walk mirrors the digest's, so it visits exactly what would be
    /// drawn and nothing orphaned.
    pub fn diamonds(&self) -> Vec<DiamondGradient> {
        let mut out = Vec::new();
        for id in self.roots() {
            self.collect_diamonds(*id, &mut out, 0);
        }
        out
    }

    fn collect_diamonds(&self, id: u128, out: &mut Vec<DiamondGradient>, depth: u32) {
        if depth >= MAX_DIGEST_DEPTH {
            return;
        }
        let Some(node) = self.get(id) else {
            return;
        };
        if node.hidden {
            return;
        }
        if node.kind == ShapeKind::Unsupported {
            return;
        }
        for paint in &node.fills {
            if let Brush::Diamond(d) = &paint.brush {
                out.push(d.clone());
            }
        }
        for stroke in &node.strokes {
            if let Brush::Diamond(d) = &stroke.paint.brush {
                out.push(d.clone());
            }
        }
        for child in &node.children {
            self.collect_diamonds(*child, out, depth + 1);
        }
    }

    fn digest_node(&self, id: u128, hash: &mut u64, depth: u32) {
        if depth >= MAX_DIGEST_DEPTH {
            return;
        }
        let Some(node) = self.get(id) else {
            fnv_u128(hash, id);
            fnv_u64(hash, MISSING_NODE_TAG);
            return;
        };
        if node.hidden {
            return;
        }
        if node.kind == ShapeKind::Unsupported {
            fnv_u128(hash, node.id);
            fnv_u64(hash, MISSING_NODE_TAG);
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
        fnv_u64(hash, u64::from(node.masked));
        fnv_u64(hash, u64::from(node.blend.mix as u8));
        fnv_u64(hash, u64::from(node.blend.compose as u8));

        match node.blur {
            Some(radius) => {
                fnv_u64(hash, 1);
                fnv_f64(hash, f64::from(radius));
            }
            None => fnv_u64(hash, 0),
        }

        match node.background_blur {
            Some(radius) => {
                fnv_u64(hash, 1);
                fnv_f64(hash, f64::from(radius));
            }
            None => fnv_u64(hash, 0),
        }

        match node.glass {
            Some(g) => {
                fnv_u64(hash, 1);
                fnv_u64(hash, g.surface_type as u64);
                for f in [
                    g.bezel_width,
                    g.thickness,
                    g.refractive_index,
                    g.specular_angle,
                    g.specular_opacity,
                    g.specular_saturation,
                    g.chromatic_aberration,
                    g.splay,
                    g.tilt_angle,
                    g.edge_boost,
                    g.zoom,
                    g.blur,
                    g.frost,
                    g.acceptable_downscale,
                ] {
                    fnv_f64(hash, f64::from(f));
                }
                fnv_u64(hash, g.tile_mode as u64);
            }
            None => fnv_u64(hash, 0),
        }

        fnv_u64(hash, node.effects.len() as u64);
        for e in &node.effects {
            let c = &e.shader;
            for b in c.wgsl.as_bytes() {
                fnv_u64(hash, u64::from(*b));
            }
            fnv_f64(hash, f64::from(c.reach));
            for p in &c.params {
                fnv_f64(hash, f64::from(*p));
            }
            fnv_u64(hash, u64::from(c.reads_backdrop));
            fnv_f64(hash, f64::from(c.acceptable_downscale));
        }

        fnv_u64(hash, node.shadows.len() as u64);
        for shadow in &node.shadows {
            for component in shadow.color.components {
                fnv_f64(hash, f64::from(component));
            }
            fnv_f64(hash, f64::from(shadow.blur));
            fnv_f64(hash, f64::from(shadow.spread));
            fnv_f64(hash, shadow.offset.x);
            fnv_f64(hash, shadow.offset.y);
            fnv_u64(hash, u64::from(shadow.inset));
        }

        match &node.filter_graph {
            Some(graph) => {
                fnv_u64(hash, 1);
                fnv_u64(hash, graph.nodes.len() as u64);
                for node in &graph.nodes {
                    match node {
                        FilterNode::Blur { sigma } => {
                            fnv_u64(hash, 0);
                            fnv_f64(hash, f64::from(*sigma));
                        }
                        FilterNode::Offset { dx, dy } => {
                            fnv_u64(hash, 1);
                            fnv_f64(hash, f64::from(*dx));
                            fnv_f64(hash, f64::from(*dy));
                        }
                        FilterNode::InnerShadow { dx, dy, sigma, color } => {
                            fnv_u64(hash, 3);
                            fnv_f64(hash, f64::from(*dx));
                            fnv_f64(hash, f64::from(*dy));
                            fnv_f64(hash, f64::from(*sigma));
                            for c in color.components {
                                fnv_f64(hash, f64::from(c));
                            }
                        }
                        FilterNode::Shader { effect, params } => {
                            fnv_u64(hash, 2);
                            fnv_u64(hash, u64::from(*effect));
                            fnv_u64(hash, params.len() as u64);
                            for p in params {
                                fnv_f64(hash, f64::from(*p));
                            }
                        }
                    }
                }
            }
            None => fnv_u64(hash, 0),
        }

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

        if node.kind == ShapeKind::Text {
            if let Some(text) = &node.text {
                digest_text(hash, text);
            }
        }

        if node.kind == ShapeKind::Svg {
            if let Some(svg) = &node.svg {
                fnv_u64(hash, svg.len() as u64);
                for b in svg.bytes() {
                    fnv_u64(hash, u64::from(b));
                }
            }
        }

        fnv_u64(hash, node.fills.len() as u64);
        for brush in &node.fills {
            digest_paint(hash, brush);
        }
        fnv_u64(hash, node.strokes.len() as u64);
        for stroke in &node.strokes {
            digest_stroke_style(hash, &stroke.style);
            digest_paint(hash, &stroke.paint);
            fnv_u64(hash, stroke.align as u64);
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

/// Hash a gradient's geometry. The discriminant goes in first, so a linear and a radial that
/// happen to agree on their numbers still hash apart.
fn digest_gradient_kind(hash: &mut u64, kind: &peniko::GradientKind) {
    match kind {
        peniko::GradientKind::Linear(p) => {
            fnv_u64(hash, 1);
            for v in [p.start.x, p.start.y, p.end.x, p.end.y] {
                fnv_f64(hash, v);
            }
        }
        peniko::GradientKind::Radial(p) => {
            fnv_u64(hash, 2);
            for v in [
                p.start_center.x,
                p.start_center.y,
                f64::from(p.start_radius),
                p.end_center.x,
                p.end_center.y,
                f64::from(p.end_radius),
            ] {
                fnv_f64(hash, v);
            }
        }
        peniko::GradientKind::Sweep(p) => {
            fnv_u64(hash, 3);
            for v in [
                p.center.x,
                p.center.y,
                f64::from(p.start_angle),
                f64::from(p.end_angle),
            ] {
                fnv_f64(hash, v);
            }
        }
    }
}

/// Hash a text block: every character and every style attribute that changes the picture.
///
/// The paragraph and span *counts* go in first (a two-span run is a different document from a
/// one-span run with the same text), then per paragraph its align and metrics, then per span the
/// bytes of its text, its font reference, size, metrics, decoration and every fill. Grow and
/// vertical align frame the whole block. Positions are deliberately absent — they are the shaper's,
/// and the two backends' shapers differ.
fn digest_text(hash: &mut u64, text: &crate::text::TextBlock) {
    fnv_u64(hash, text.grow as u64);
    fnv_u64(hash, text.vertical_align as u64);
    fnv_u64(hash, text.paragraphs.len() as u64);
    for paragraph in &text.paragraphs {
        fnv_u64(hash, paragraph.align as u64);
        fnv_u64(hash, paragraph.direction as u64);
        fnv_f64(hash, f64::from(paragraph.line_height));
        fnv_f64(hash, f64::from(paragraph.letter_spacing));
        fnv_u64(hash, paragraph.spans.len() as u64);
        for span in &paragraph.spans {
            fnv_u64(hash, span.text.len() as u64);
            for byte in span.text.as_bytes() {
                fnv_u64(hash, u64::from(*byte));
            }
            fnv_u128(hash, span.font.id);
            fnv_u64(hash, u64::from(span.font.weight));
            fnv_u64(hash, u64::from(span.font.italic));
            fnv_f64(hash, f64::from(span.size));
            fnv_f64(hash, f64::from(span.line_height));
            fnv_f64(hash, f64::from(span.letter_spacing));
            fnv_u64(hash, span.decoration as u64);
            fnv_u64(hash, span.transform as u64);
            fnv_u64(hash, span.fills.len() as u64);
            for fill in &span.fills {
                digest_paint(hash, fill);
            }
        }
    }
}

/// Hash paint: the brush and where it sits.
///
/// The transform matters as much as the colours — it places a radial gradient's ellipse and an
/// angular one's shear, so two backends agreeing on stops while disagreeing on the matrix would
/// otherwise compare equal.
fn digest_paint(hash: &mut u64, paint: &Paint) {
    digest_brush(hash, &paint.brush);
    for coefficient in paint.transform.as_coeffs() {
        fnv_f64(hash, coefficient);
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
            digest_gradient_kind(hash, &g.kind);
            fnv_u64(hash, g.extend as u64);
            fnv_u64(hash, g.stops.len() as u64);
            for stop in g.stops.iter() {
                fnv_f64(hash, f64::from(stop.offset));
                for component in stop.color.components {
                    fnv_f64(hash, f64::from(component));
                }
            }
        }
        Brush::Image(image) => {
            fnv_u64(hash, 3);
            fnv_u128(hash, image.id);
            fnv_u64(hash, u64::from(image.width));
            fnv_u64(hash, u64::from(image.height));
            fnv_u64(hash, u64::from(image.opacity));
            fnv_u64(hash, u64::from(image.keep_aspect));
            if let Some(dest) = image.dest {
                fnv_u64(hash, 1);
                for v in [dest.x0, dest.y0, dest.x1, dest.y1] {
                    fnv_f64(hash, v);
                }
            } else {
                fnv_u64(hash, 0);
            }
        }
        Brush::Diamond(d) => {
            fnv_u64(hash, 4);
            let g = &d.geometry;
            for (x, y) in [g.start, g.end, g.width] {
                fnv_f64(hash, f64::from(x));
                fnv_f64(hash, f64::from(y));
            }
            fnv_u64(hash, d.stops.len() as u64);
            for stop in d.stops.iter() {
                fnv_f64(hash, f64::from(stop.offset));
                for component in stop.color.components {
                    fnv_f64(hash, f64::from(component));
                }
            }
        }
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
        n.fills = vec![Paint::plain(Brush::Solid(Color::from_rgba8(255, 0, 0, 255)))];
        scene.insert(n);

        assert_eq!(scene.len(), 1);
        let got = scene.get(42).unwrap();
        assert_eq!(
            got.fills[0],
            Paint::plain(Brush::Solid(Color::from_rgba8(255, 0, 0, 255)))
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
        n.bounds = Rect::new(10.0, 20.0, 30.0, 40.0);
        n.transform = Affine::rotate(std::f64::consts::FRAC_PI_2);

        let centre = Point::new(20.0, 30.0);
        let moved = n.effective_transform() * centre;
        assert!((moved - centre).hypot() < 1e-9);

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
        a.fills = vec![Paint::plain(Brush::Solid(Color::from_rgba8(1, 2, 3, 255)))];

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
        assert_ne!(base, mutate(&|n| n.masked = true));
        assert_ne!(base, mutate(&|n| n.blend = crate::blend::blend_from_raw(24)));
        assert_ne!(base, mutate(&|n| n.blur = Some(8.0)));
        assert_ne!(
            base,
            mutate(&|n| n.shadows = vec![Shadow {
                color: Color::from_rgba8(0, 0, 0, 128),
                blur: 4.0,
                spread: 0.0,
                offset: kurbo::Vec2::new(2.0, 3.0),
                inset: false,
            }])
        );
        assert_ne!(base, mutate(&|n| n.transform = Affine::rotate(0.1)));
        assert_ne!(base, mutate(&|n| n.kind = ShapeKind::Path));
        assert_ne!(
            base,
            mutate(&|n| n.corners = Some(RoundedRectRadii::new(1.0, 1.0, 1.0, 1.0)))
        );
        assert_ne!(
            base,
            mutate(&|n| n.fills = vec![Paint::plain(Brush::Solid(Color::from_rgba8(9, 9, 9, 255)))])
        );
        assert_ne!(base, mutate(&|n| n.fills.clear()));
    }

    /// Two different mixes must hash differently — otherwise a document set to Multiply would look
    /// like parity against one set to Screen. Guards against hashing only the compose operator
    /// (which is `SrcOver` for every Penpot mode) and dropping the mix.
    #[test]
    fn digest_notices_which_blend_mode() {
        let with = |raw: u8| {
            let mut s = tree(&[0, 1, 2]);
            s.get_mut(1).unwrap().blend = crate::blend::blend_from_raw(raw);
            s.digest()
        };
        assert_ne!(with(24), with(14), "Multiply and Screen must differ");
        assert_eq!(with(3), tree(&[0, 1, 2]).digest(), "Normal is the default — no change");
    }

    /// Every field of a shadow is part of the picture: a shadow offset one way is a different
    /// document from the same shadow offset the other, and a soft shadow differs from a hard one.
    /// A digest that hashed only the count would let the two backends drift on all of it.
    #[test]
    fn digest_notices_every_field_of_a_shadow() {
        let base = Shadow {
            color: Color::from_rgba8(0, 0, 0, 128),
            blur: 4.0,
            spread: 0.0,
            offset: kurbo::Vec2::new(2.0, 3.0),
            inset: false,
        };
        let with = |s: Shadow| {
            let mut t = tree(&[0, 1, 2]);
            t.get_mut(1).unwrap().shadows = vec![s];
            t.digest()
        };
        let b = with(base);
        assert_ne!(b, with(Shadow { color: Color::from_rgba8(255, 0, 0, 128), ..base }));
        assert_ne!(b, with(Shadow { blur: 9.0, ..base }));
        assert_ne!(b, with(Shadow { spread: 2.0, ..base }));
        assert_ne!(b, with(Shadow { offset: kurbo::Vec2::new(-2.0, 3.0), ..base }));
        assert_ne!(b, with(Shadow { inset: true, ..base }));
        let mut two = tree(&[0, 1, 2]);
        two.get_mut(1).unwrap().shadows = vec![base, base];
        assert_ne!(b, two.digest());
    }

    /// The filter graph is hashed as its ordered node sequence — the pass order changes the picture,
    /// so the digest notices node kind, params, count, *and* order; having a graph at all differs
    /// from none.
    #[test]
    fn digest_notices_the_filter_graph() {
        let none = tree(&[0, 1, 2]).digest();
        let with = |nodes: Vec<FilterNode>| {
            let mut t = tree(&[0, 1, 2]);
            t.get_mut(1).unwrap().filter_graph = Some(FilterGraph { nodes });
            t.digest()
        };
        let blur = FilterNode::Blur { sigma: 4.0 };
        let offset = FilterNode::Offset { dx: 10.0, dy: 0.0 };
        let tint = FilterNode::Shader { effect: 0, params: vec![1.0, 0.45, 0.0, 0.7] };
        let inner = FilterNode::InnerShadow {
            dx: 6.0,
            dy: 6.0,
            sigma: 4.0,
            color: Color::from_rgba8(0, 0, 0, 128),
        };

        let base = with(vec![blur.clone(), offset.clone(), tint.clone()]);
        assert_ne!(none, base, "a graph differs from no graph");
        assert_ne!(base, with(vec![offset.clone(), blur.clone(), tint.clone()]), "order matters");
        assert_ne!(base, with(vec![blur.clone(), tint.clone()]), "node count matters");
        assert_ne!(base, with(vec![FilterNode::Blur { sigma: 9.0 }, offset, tint.clone()]), "params matter");
        assert_ne!(with(vec![inner.clone()]), with(vec![tint]), "node kind matters");
        assert_ne!(
            with(vec![inner]),
            with(vec![FilterNode::InnerShadow { dx: 6.0, dy: 6.0, sigma: 9.0, color: Color::from_rgba8(0, 0, 0, 128) }]),
            "inner-shadow params matter"
        );
    }

    /// A text block is hashed as its input — every character and style attribute is part of the
    /// picture, but glyph positions are not (the two backends shape differently).
    #[test]
    fn digest_notices_every_field_of_a_text_block() {
        use crate::text::{
            FontRef, TextAlign, TextBlock, TextDecoration, TextDirection, TextGrow, TextParagraph,
            TextSpan, TextTransform, VerticalAlign,
        };

        let solid = |c| Paint::plain(Brush::Solid(c));
        let span = || TextSpan {
            text: "Hello".into(),
            font: FontRef { id: 0xAB, weight: 400, italic: false },
            size: 16.0,
            line_height: 1.2,
            letter_spacing: 0.0,
            fills: vec![solid(Color::from_rgba8(0, 0, 0, 255))],
            decoration: TextDecoration::None,
            transform: TextTransform::None,
        };
        let block = || TextBlock {
            paragraphs: vec![TextParagraph {
                align: TextAlign::Left,
                direction: TextDirection::Ltr,
                line_height: 1.2,
                letter_spacing: 0.0,
                spans: vec![span()],
            }],
            grow: TextGrow::Fixed,
            vertical_align: VerticalAlign::Top,
        };
        let with = |f: &dyn Fn(&mut Node)| {
            let mut s = tree(&[0, 1, 2]);
            let n = s.get_mut(1).unwrap();
            n.kind = ShapeKind::Text;
            n.text = Some(block());
            f(n);
            s.digest()
        };

        let base = with(&|_| {});
        assert_ne!(base, tree(&[0, 1, 2]).digest());
        assert_ne!(base, with(&|n| n.text.as_mut().unwrap().paragraphs[0].spans[0].text = "Hallo".into()));
        assert_ne!(base, with(&|n| n.text.as_mut().unwrap().paragraphs[0].spans[0].size = 17.0));
        assert_ne!(base, with(&|n| n.text.as_mut().unwrap().paragraphs[0].spans[0].font.weight = 700));
        assert_ne!(base, with(&|n| n.text.as_mut().unwrap().paragraphs[0].spans[0].font.italic = true));
        assert_ne!(base, with(&|n| n.text.as_mut().unwrap().paragraphs[0].spans[0].font.id = 0xCD));
        assert_ne!(base, with(&|n| n.text.as_mut().unwrap().paragraphs[0].spans[0].fills[0] = solid(Color::from_rgba8(255, 0, 0, 255))));
        assert_ne!(base, with(&|n| n.text.as_mut().unwrap().paragraphs[0].spans[0].fills.push(solid(Color::from_rgba8(0, 255, 0, 128)))));
        assert_ne!(base, with(&|n| n.text.as_mut().unwrap().paragraphs[0].spans[0].decoration = TextDecoration::Underline));
        assert_ne!(base, with(&|n| n.text.as_mut().unwrap().paragraphs[0].spans[0].transform = TextTransform::Uppercase));
        assert_ne!(base, with(&|n| n.text.as_mut().unwrap().paragraphs[0].direction = TextDirection::Rtl));
        assert_ne!(base, with(&|n| n.text.as_mut().unwrap().paragraphs[0].align = TextAlign::Center));
        assert_ne!(base, with(&|n| n.text.as_mut().unwrap().vertical_align = VerticalAlign::Bottom));
        assert_ne!(base, with(&|n| n.text.as_mut().unwrap().grow = TextGrow::AutoWidth));
        assert_ne!(base, with(&|n| n.text.as_mut().unwrap().paragraphs[0].spans.push(span())));

        let mut painted = tree(&[0, 1, 2]);
        let n = painted.get_mut(1).unwrap();
        n.kind = ShapeKind::Text;
        n.text = Some(block());
        n.fills.clear();
        assert_eq!(painted.paintable_count(), 1, "text with content paints");
        painted.get_mut(1).unwrap().text.as_mut().unwrap().paragraphs[0].spans[0].text.clear();
        assert_eq!(painted.paintable_count(), 0, "empty text paints nothing");
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

    /// The whole reason `ShapeKind::Unsupported` exists. render-wasm *drops* a text/bool/svg
    /// shape (its parent lists an absent child); render-vello's streaming ABI has already made
    /// the node, so it *marks* it. The digest has to fold both onto one hash, or the harness can
    /// never reach parity on a document that contains text.
    #[test]
    fn an_unsupported_node_digests_as_the_dropped_hole_it_replaces() {
        const X: u128 = 0x5555;

        let root_frame = || {
            let mut r = node(ROOT_ID, ShapeKind::Frame);
            r.bounds = Rect::new(0.0, 0.0, 400.0, 300.0);
            r.children = vec![X];
            r
        };

        let mut a = Scene::new();
        a.insert(root_frame());

        let mut b = Scene::new();
        b.insert(root_frame());
        let mut x = node(X, ShapeKind::Unsupported);
        x.bounds = Rect::new(10.0, 10.0, 90.0, 40.0);
        x.fills = vec![Paint::plain(Brush::Solid(Color::from_rgba8(9, 9, 9, 255)))];
        b.insert(x);

        assert_eq!(a.digest(), b.digest(), "drop and mark must reconcile");

        let mut c = Scene::new();
        c.insert(root_frame());
        let mut real = node(X, ShapeKind::Rect);
        real.bounds = Rect::new(10.0, 10.0, 90.0, 40.0);
        c.insert(real);
        assert_ne!(a.digest(), c.digest(), "a supported shape is not a hole");

        let mut d = Scene::new();
        let mut childless = root_frame();
        childless.children = vec![];
        d.insert(childless);
        assert_ne!(a.digest(), d.digest(), "referenced-but-absent != not referenced");
    }

    /// An unsupported node draws nothing, so it is not paintable — even when it arrived with
    /// fills attached. Mirrors what `scene::draw_node` does with it.
    #[test]
    fn an_unsupported_node_is_not_paintable() {
        let mut scene = Scene::new();
        let mut root = node(ROOT_ID, ShapeKind::Frame);
        root.children = vec![1];
        scene.insert(root);

        let mut x = node(1, ShapeKind::Unsupported);
        x.bounds = Rect::new(0.0, 0.0, 50.0, 50.0);
        x.fills = vec![Paint::plain(Brush::Solid(Color::from_rgba8(1, 2, 3, 255)))];
        scene.insert(x);

        assert_eq!(scene.paintable_count(), 0);
    }

    /// Colours alone are not a gradient. Two fills with identical stops running in different
    /// directions are visibly different documents, and a digest that missed it would let the
    /// backends drift on exactly the thing gradients are for.
    #[test]
    fn digest_notices_a_gradient_direction() {
        use peniko::{Gradient, GradientKind};

        let stops = [
            peniko::ColorStop {
                offset: 0.0,
                color: Color::from_rgba8(255, 0, 0, 255).into(),
            },
            peniko::ColorStop {
                offset: 1.0,
                color: Color::from_rgba8(0, 0, 255, 255).into(),
            },
        ];
        let with = |kind: GradientKind| {
            let mut s = tree(&[0, 1, 2]);
            let mut g = Gradient::new_linear((0.0, 0.0), (1.0, 0.0));
            g.kind = kind;
            s.get_mut(1).unwrap().fills = vec![Paint::plain(Brush::Gradient(g.with_stops(&stops[..])))];
            s.digest()
        };

        let left_to_right = with(GradientKind::Linear(peniko::LinearGradientPosition {
            start: (0.0, 0.0).into(),
            end: (1.0, 0.0).into(),
        }));
        let top_to_bottom = with(GradientKind::Linear(peniko::LinearGradientPosition {
            start: (0.0, 0.0).into(),
            end: (0.0, 1.0).into(),
        }));
        assert_ne!(left_to_right, top_to_bottom, "direction must be hashed");

        let radial = with(GradientKind::Radial(peniko::RadialGradientPosition {
            start_center: (0.0, 0.0).into(),
            start_radius: 0.0,
            end_center: (1.0, 0.0).into(),
            end_radius: 1.0,
        }));
        assert_ne!(left_to_right, radial, "the kind must be hashed");
    }

    /// An image fill is compared by *reference*, so the digest must see every field of that
    /// reference — a different id, a different size, or a moved dest-rect is a different picture,
    /// even though neither backend's pixels are in the model.
    #[test]
    fn digest_notices_every_field_of_an_image_reference() {
        let base = ImageFill {
            id: 0xAA,
            width: 640,
            height: 480,
            opacity: 255,
            keep_aspect: true,
            dest: None,
        };
        let with = |image: ImageFill| {
            let mut s = tree(&[0, 1, 2]);
            s.get_mut(1).unwrap().fills = vec![Paint::plain(Brush::Image(image))];
            s.digest()
        };

        let d = with(base.clone());
        assert_ne!(d, with(ImageFill { id: 0xBB, ..base.clone() }), "id");
        assert_ne!(d, with(ImageFill { width: 641, ..base.clone() }), "width");
        assert_ne!(d, with(ImageFill { height: 481, ..base.clone() }), "height");
        assert_ne!(d, with(ImageFill { opacity: 254, ..base.clone() }), "opacity");
        assert_ne!(
            d,
            with(ImageFill { keep_aspect: false, ..base.clone() }),
            "keep_aspect"
        );
        assert_ne!(
            d,
            with(ImageFill {
                dest: Some(Rect::new(0.0, 0.0, 1.0, 1.0)),
                ..base.clone()
            }),
            "dest presence"
        );
        assert_ne!(
            with(ImageFill { dest: Some(Rect::new(0.0, 0.0, 1.0, 1.0)), ..base.clone() }),
            with(ImageFill { dest: Some(Rect::new(0.0, 0.0, 2.0, 1.0)), ..base.clone() }),
            "dest geometry"
        );
    }

    /// Diamond must hash apart from nothing and from a radial with the same numbers — the whole
    /// reason it is carried rather than dropped.
    #[test]
    fn digest_distinguishes_diamond_from_nothing_and_from_radial() {
        use crate::gradient::GradientGeometry;

        let stops: peniko::ColorStops = [
            peniko::ColorStop {
                offset: 0.0,
                color: Color::from_rgba8(255, 0, 0, 255).into(),
            },
            peniko::ColorStop {
                offset: 1.0,
                color: Color::from_rgba8(0, 0, 255, 255).into(),
            },
        ][..]
            .into();
        let geometry = GradientGeometry {
            start: (0.5, 0.5),
            end: (1.0, 0.5),
            width: (1.0, 0.0),
        };

        let base = tree(&[0, 1, 2]).digest();
        let with = |brush: Brush| {
            let mut s = tree(&[0, 1, 2]);
            s.get_mut(1).unwrap().fills = vec![Paint::plain(brush)];
            s.digest()
        };

        let diamond = with(Brush::Diamond(DiamondGradient {
            geometry,
            stops: stops.clone(),
        }));
        assert_ne!(diamond, base, "a diamond fill is not an empty node");

        let (radial, _) = crate::gradient::gradient_paint(
            crate::gradient::GradientShape::Radial,
            geometry,
            &stops,
        )
        .unwrap();
        assert_ne!(
            diamond,
            with(Brush::Gradient(radial)),
            "diamond and radial with identical numbers must not collide"
        );
    }

    /// The diagnostic this exists for: a blank canvas with a healthy node count. In `tree`, only
    /// node 1 carries a fill — node 2 has bounds and nothing to draw with, so it is delivered but
    /// not paintable, and the count says so.
    #[test]
    fn paintable_count_counts_only_what_would_draw() {
        assert_eq!(tree(&[0, 1, 2]).paintable_count(), 1);
        assert_eq!(Scene::new().paintable_count(), 0);

        let mut unrooted = tree(&[0, 1, 2]);
        unrooted.get_mut(ROOT_ID).unwrap().children.clear();
        assert_eq!(unrooted.paintable_count(), 0);

        let mut hidden = tree(&[0, 1, 2]);
        hidden.get_mut(1).unwrap().hidden = true;
        assert_eq!(hidden.paintable_count(), 0);

        let mut group = tree(&[0, 1, 2]);
        group.get_mut(1).unwrap().kind = ShapeKind::Group;
        assert_eq!(group.paintable_count(), 0);

        let mut stroked = tree(&[0, 1, 2]);
        let n = stroked.get_mut(2).unwrap();
        n.strokes = vec![Stroke {
            style: kurbo::Stroke::new(2.0),
            paint: Paint::plain(Brush::Solid(Color::from_rgba8(0, 0, 0, 255))),
            align: StrokeAlign::Center,
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
