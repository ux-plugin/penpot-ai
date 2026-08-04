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

use render_core::blend::DEFAULT_BLEND;
use render_core::blur::radius_to_sigma;
use render_core::kurbo::{Affine, BezPath, Ellipse, Rect, RoundedRect, Shape as _};
use render_core::model as m;
use render_core::model::Brush;
use render_core::peniko::Color;
use vello_common::filter_effects::{EdgeMode, Filter, FilterPrimitive};
use vello_example_scenes::{ExampleScene, RenderingContext};

use glifo::Glyph;
use parley::fontique::{FontInfoOverride, GenericFamily};
use parley::{
    Alignment, AlignmentOptions, FontContext, FontFamily, GlyphRun, Layout, LayoutContext,
    LineHeight, PositionedLayoutItem, StyleProperty,
};

/// A Gaussian-blur filter of the given sigma. `EdgeMode::None` fades to transparent at the edges,
/// which is what a blur or a soft shadow wants.
fn gaussian_blur(sigma: f32) -> Filter {
    Filter::from_primitive(FilterPrimitive::GaussianBlur {
        std_deviation: sigma,
        edge_mode: EdgeMode::None,
    })
}

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
pub struct NeutralModelScene {
    fallback: m::Scene,
    text: TextEngine,
}

impl std::fmt::Debug for NeutralModelScene {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // `TextEngine` wraps Parley contexts that are not `Debug`; the scene's identity is the
        // fallback model, so that is all this prints.
        f.debug_struct("NeutralModelScene")
            .field("fallback", &self.fallback)
            .finish_non_exhaustive()
    }
}

impl NeutralModelScene {
    pub fn new() -> Self {
        Self {
            fallback: demo_model(),
            text: TextEngine::new(),
        }
    }
}

/// The per-run style Parley carries through layout. Parley's `Brush` bound is
/// `Clone + PartialEq + Default + Debug`; the layout hands it back at each glyph run, so a run's
/// style follows the span it came from. It holds the span's whole fill list (drawn bottom-to-top
/// over the glyph coverage) and its decoration line.
#[derive(Clone, Debug, PartialEq, Default)]
struct TextBrush {
    fills: Vec<m::Paint>,
    decoration: render_core::text::TextDecoration,
}

/// The Parley state text layout needs, kept across frames on the scene rather than rebuilt each
/// frame: the font collection (fed by `store_font`, which must persist its faces) and the reusable
/// layout/font contexts (a `FontContext` is expensive to construct).
struct TextEngine {
    font_cx: FontContext,
    layout_cx: LayoutContext<TextBrush>,
}

impl TextEngine {
    fn new() -> Self {
        Self {
            font_cx: FontContext::new(),
            layout_cx: LayoutContext::new(),
        }
    }

    /// Register every face the host has uploaded since the last frame. The ABI queue is drained
    /// (each face is staged at most once, deduped by alias there), so this is idempotent. The face
    /// is registered under our own alias — see [`font_alias`] — which the draw path looks it up by.
    fn sync_fonts(&mut self) {
        for font in crate::abi::take_pending_fonts() {
            let registered = self.font_cx.collection.register_fonts(
                font.bytes.into(),
                Some(FontInfoOverride {
                    family_name: Some(&font.alias),
                    width: None,
                    style: None,
                    weight: None,
                    axes: None,
                }),
            );
            // An emoji face also joins Parley's `Emoji` generic family. Parley appends that generic
            // to the font query for any cluster it detects as emoji, so an emoji the primary font
            // lacks falls through to this face — and glifo's glyph cascade (COLR > bitmap > outline)
            // draws its colour layers. `append` (not `set`) so multiple emoji faces accumulate.
            if font.is_emoji {
                let ids = registered.iter().map(|(family_id, _)| *family_id);
                self.font_cx
                    .collection
                    .append_generic_families(GenericFamily::Emoji, ids);
            }
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
        resources: &mut T::Resources,
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

        // Register any faces uploaded since the last frame before laying text out against them.
        self.text.sync_fonts();

        // Pre-borrow the disjoint fields so the closure can hold the fallback model and the text
        // engine at once (a whole-`self` capture would alias them).
        let fallback = &self.fallback;
        let text = &mut self.text;
        crate::abi::with_scene(|live, viewport, modifiers| {
            // `root` is the harness's own pan/zoom; `viewport` is what the host set through
            // `set_view`. They compose — the harness stays at identity when a host is driving.
            let (model, view) = if live.is_empty() {
                (fallback, root)
            } else {
                (live, root * viewport)
            };
            for id in model.roots() {
                draw_node(ctx, resources, text, model, *id, view, modifiers, 0);
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
    resources: &mut T::Resources,
    text: &mut TextEngine,
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
    if node.kind == m::ShapeKind::Unsupported {
        // A kind this backend does not draw yet (Text, Bool, SVGRaw). Skip it and its subtree,
        // matching the digest's reachability so the picture and the hash count the same nodes.
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

    // Clip and the composite layer cannot share one layer, because they cover different things.
    //
    // Opacity and blend both wrap this node's own paint *and* its children — a half-transparent
    // or multiplied group must composite as one image against the backdrop, not per child, so
    // they ride the *same* outer layer. Clipping covers only the children: render-wasm builds the
    // clip in `get_children_clip_bounds`, and a frame is not clipped by itself (which matters once
    // strokes land, since a stroke straddles the boundary).
    // Drop shadows sit behind the shape, and *outside* the layer-blur/opacity/blend layer — a
    // layer blur blurs the shape, not its shadow. Each is its own soft, offset, coloured
    // silhouette; multiple shadows are just multiple passes (no multi-primitive filter needed).
    draw_drop_shadows(ctx, node, matrix);

    let alpha = (node.opacity < 1.0).then_some(node.opacity);
    let blend = (node.blend != DEFAULT_BLEND).then_some(node.blend);
    // Layer blur rides the same outer layer as opacity/blend, via `push_layer`'s filter slot, so
    // it covers this node's paint and its children as one image.
    let blur = node.blur.map(|radius| gaussian_blur(radius_to_sigma(radius)));
    let composite = alpha.is_some() || blend.is_some() || blur.is_some();
    if composite {
        ctx.set_transform(matrix);
        ctx.push_layer(None, blend, alpha, None, blur);
    }

    // Text carries no `fills`/geometry — its paint is the glyph colour inside its spans — so it
    // takes its own draw path rather than `paint_self`.
    if node.kind == m::ShapeKind::Text {
        draw_text(ctx, resources, text, node, matrix);
    } else {
        paint_self(ctx, node, matrix);
    }

    let clip = (node.clip && !node.children.is_empty()).then(|| outline(node));
    if clip.is_some() {
        // The clip path is captured in the transform current at push time, which is this
        // node's — matching render-wasm, where each clip entry carries its own matrix.
        ctx.set_transform(matrix);
        ctx.push_layer(clip.as_ref(), None, None, None, None);
    }

    draw_children(ctx, resources, text, scene, node, root, modifiers, depth);

    if clip.is_some() {
        ctx.pop_layer();
    }
    if composite {
        ctx.pop_layer();
    }
}

/// Draw a container's children, honouring a masked group.
///
/// For a masked group the first (bottom-most) child is Penpot's mask: it clips the rest to its
/// silhouette instead of being drawn itself. An **opaque** mask makes that exactly a clip to the
/// silhouette, which is what happens here — the mask child's outline becomes a clip layer around
/// the content. A **soft** mask (a gradient, an image, or a partly transparent fill) needs a true
/// DstIn *alpha* mask, which `push_layer`'s mask slot wants as a screen-space raster built from an
/// offscreen render the neutral `RenderingContext` cannot yet produce — so it is deferred and, for
/// now, approximated by this hard clip, the same "carry it in the model, approximate the pixels"
/// contract as shadow spread and inner shadows. The digest already agrees regardless, because the
/// mask flag and the children are in the model either way.
fn draw_children<T: RenderingContext>(
    ctx: &mut T,
    resources: &mut T::Resources,
    text: &mut TextEngine,
    scene: &m::Scene,
    node: &m::Node,
    root: Affine,
    modifiers: &crate::abi::Modifiers,
    depth: u32,
) {
    // The mask is the first child, the content the rest. A masked group with no children has
    // nothing to mask; one with only the mask draws nothing at all (the content is empty).
    let mask_id = (node.masked && node.kind == m::ShapeKind::Group)
        .then(|| node.children.first().copied())
        .flatten();

    let Some(mask_id) = mask_id else {
        for child in &node.children {
            draw_node(ctx, resources, text, scene, *child, root, modifiers, depth + 1);
        }
        return;
    };

    // Clip to the mask child's silhouette, captured in that child's own page-space matrix — the
    // same way a frame's clip carries the matrix current at push time. If the mask child has not
    // arrived yet, draw the content unclipped rather than hiding it, matching how a not-yet-sent
    // child is tolerated elsewhere.
    let clipped = scene.get(mask_id).map(|mask| {
        let modifier = modifiers.get(&mask_id).copied().unwrap_or(Affine::IDENTITY);
        ctx.set_transform(root * modifier * mask.effective_transform());
        ctx.push_layer(Some(&outline(mask)), None, None, None, None);
    });

    for child in node.children.iter().skip(1) {
        draw_node(ctx, resources, text, scene, *child, root, modifiers, depth + 1);
    }

    if clipped.is_some() {
        ctx.pop_layer();
    }
}

/// Draw a node's drop shadows, back to front, behind its own paint.
///
/// A drop shadow is the shape's silhouette, offset, filled with the shadow colour and softened by
/// a Gaussian blur — built from the single upstream `GaussianBlur` primitive rather than the
/// fork's compound `DropShadow` (which bundles the source and so cannot stack). One
/// `push_filter_layer` per shadow keeps every filter graph single-primitive.
///
/// Not done yet, and dropped rather than faked: **spread** (needs a dilate/morphology the fork
/// does not implement) and **inner** shadows (never reach the model). The offset is applied in
/// the shape's own space (`matrix · translate(offset)`), so it rotates with the shape; that
/// composition is not yet pixel-checked against render-wasm.
fn draw_drop_shadows<T: RenderingContext>(ctx: &mut T, node: &m::Node, matrix: Affine) {
    // A text shadow is glyph-shaped, not a box around the bounds; drawing `outline(node)` (the
    // bounds rect) would be wrong, so text shadows are deferred with the rest of the text effects.
    if node.shadows.is_empty()
        || node.kind == m::ShapeKind::Group
        || node.kind == m::ShapeKind::Text
    {
        return;
    }
    let silhouette = outline(node);
    for shadow in &node.shadows {
        let sigma = radius_to_sigma(shadow.blur);
        let softened = sigma > 0.0;
        if softened {
            ctx.push_filter_layer(gaussian_blur(sigma));
        }
        ctx.set_transform(matrix * Affine::translate((shadow.offset.x, shadow.offset.y)));
        ctx.set_paint_transform(Affine::IDENTITY);
        ctx.set_paint(shadow.color);
        ctx.fill_path(&silhouette);
        if softened {
            ctx.pop_layer();
        }
    }
}

/// Shape and paint a text node with Parley.
///
/// render-wasm lays the same content out with Skia; the two shapers disagree glyph-for-glyph, so
/// the neutral model carries the *input* and each backend shapes it — the digest hashes that input,
/// not this result (see [`render_core::text`]). One Parley `Layout` per paragraph, stacked top to
/// bottom (matching render-wasm's per-paragraph layout), then the whole stack is offset for
/// vertical alignment.
///
/// Deferred, and dropped rather than faked (a later slice): text transforms, RTL, emoji/COLR,
/// text effects, the editor.
fn draw_text<T: RenderingContext>(
    ctx: &mut T,
    resources: &mut T::Resources,
    engine: &mut TextEngine,
    node: &m::Node,
    matrix: Affine,
) {
    let Some(block) = &node.text else {
        return;
    };

    // `Fixed`/`AutoHeight` wrap to the box width; `AutoWidth` never wraps.
    let max_advance = match block.grow {
        render_core::text::TextGrow::AutoWidth => None,
        _ => Some(node.bounds.width() as f32),
    };

    // Lay out every paragraph first, so the total height is known before placing them — vertical
    // alignment needs it.
    let layouts: Vec<Layout<TextBrush>> = block
        .paragraphs
        .iter()
        .map(|paragraph| layout_paragraph(engine, paragraph, max_advance))
        .collect();
    let total_height: f32 = layouts.iter().map(Layout::height).sum();

    let box_height = node.bounds.height() as f32;
    let vertical_offset = match block.vertical_align {
        render_core::text::VerticalAlign::Top => 0.0,
        render_core::text::VerticalAlign::Center => (box_height - total_height) * 0.5,
        render_core::text::VerticalAlign::Bottom => box_height - total_height,
    };

    // Glyphs are placed in the node's own space (the same space `bounds` is in), then drawn under
    // the shape matrix — exactly how a rect's fill is positioned, so rotation and viewport apply
    // the same way.
    ctx.set_transform(matrix);
    ctx.set_paint_transform(Affine::IDENTITY);
    let origin_x = node.bounds.x0 as f32;
    let mut origin_y = node.bounds.y0 as f32 + vertical_offset;
    for layout in &layouts {
        draw_layout(ctx, resources, layout, origin_x, origin_y, node.bounds, &node.strokes);
        origin_y += layout.height();
    }
}

/// Lay out one paragraph into a Parley `Layout`, styling each span over exactly its characters.
fn layout_paragraph(
    engine: &mut TextEngine,
    paragraph: &render_core::text::TextParagraph,
    max_advance: Option<f32>,
) -> Layout<TextBrush> {
    // Concatenate the spans into one string, remembering each span's byte range so its style is
    // pushed over exactly the characters it covers. The span text is folded by its case transform
    // here (the model keeps it raw); ranges track the folded length, which `to_uppercase` can grow.
    //
    // A right-to-left paragraph is forced by prepending a RIGHT-TO-LEFT MARK: Parley resolves the
    // bidi algorithm from content and has no explicit base-direction knob, so this zero-width,
    // unstyled control char sets the base level to RTL the way render-wasm's `set_text_direction`
    // does. Real RTL scripts (Arabic/Hebrew) already reorder on their own; this only fixes the base
    // for neutral or mixed text.
    let mut text = String::new();
    if paragraph.direction == render_core::text::TextDirection::Rtl {
        text.push('\u{200F}');
    }
    let mut ranges: Vec<std::ops::Range<usize>> = Vec::with_capacity(paragraph.spans.len());
    for span in &paragraph.spans {
        let start = text.len();
        text.push_str(&span.transform.apply(&span.text));
        ranges.push(start..text.len());
    }

    // Family aliases must outlive the builder (Parley borrows the name through `build`), so collect
    // them up front.
    let aliases: Vec<String> = paragraph
        .spans
        .iter()
        .map(|s| crate::abi::font_alias(s.font.id, s.font.weight, s.font.italic))
        .collect();

    let mut builder = engine
        .layout_cx
        .ranged_builder(&mut engine.font_cx, &text, 1.0, true);
    for ((range, span), alias) in ranges.iter().zip(&paragraph.spans).zip(&aliases) {
        builder.push(StyleProperty::FontFamily(FontFamily::named(alias)), range.clone());
        builder.push(StyleProperty::FontSize(span.size), range.clone());
        builder.push(
            StyleProperty::LineHeight(LineHeight::FontSizeRelative(span.line_height)),
            range.clone(),
        );
        builder.push(StyleProperty::LetterSpacing(span.letter_spacing), range.clone());
        builder.push(
            StyleProperty::Brush(TextBrush {
                fills: span.fills.clone(),
                decoration: span.decoration,
            }),
            range.clone(),
        );
    }

    let mut layout = builder.build(&text);
    layout.break_all_lines(max_advance);
    layout.align(alignment_of(paragraph.align), AlignmentOptions::default());
    layout
}

/// Penpot's absolute horizontal alignment → Parley's. Penpot's `Left`/`Right` are edges, not
/// direction-relative, so they map to `Left`/`Right` rather than `Start`/`End` — they stay put
/// under an RTL base direction, which only reorders the glyphs within the line.
fn alignment_of(align: render_core::text::TextAlign) -> Alignment {
    match align {
        render_core::text::TextAlign::Left => Alignment::Left,
        render_core::text::TextAlign::Center => Alignment::Center,
        render_core::text::TextAlign::Right => Alignment::Right,
        render_core::text::TextAlign::Justify => Alignment::Justify,
    }
}

/// Draw every glyph run in a laid-out paragraph at the given local origin.
fn draw_layout<T: RenderingContext>(
    ctx: &mut T,
    resources: &mut T::Resources,
    layout: &Layout<TextBrush>,
    origin_x: f32,
    origin_y: f32,
    bounds: Rect,
    strokes: &[m::Stroke],
) {
    for line in layout.lines() {
        for item in line.items() {
            if let PositionedLayoutItem::GlyphRun(glyph_run) = item {
                draw_glyph_run(ctx, resources, &glyph_run, origin_x, origin_y, bounds, strokes);
            }
        }
    }
}

/// Draw one glyph run: its span's fills layered over the glyph coverage, then its decoration line.
///
/// The glyph positions are computed once and reused for every fill pass (and for the decoration's
/// skip-ink). Fills paint bottom-to-top — the order render-wasm's `merge_fills` composites them,
/// each new fill `SrcOver` the last — so a layered or gradient text fill reads the same way. Each
/// fill goes through the shared [`set_paint`], so a gradient text fill gets the same unit-box→bounds
/// mapping a gradient shape fill does; an unresolved image fill paints nothing rather than a hole.
fn draw_glyph_run<T: RenderingContext>(
    ctx: &mut T,
    resources: &mut T::Resources,
    glyph_run: &GlyphRun<'_, TextBrush>,
    origin_x: f32,
    origin_y: f32,
    bounds: Rect,
    strokes: &[m::Stroke],
) {
    let style = glyph_run.style();
    if style.brush.fills.is_empty() && strokes.is_empty() {
        return;
    }

    let run_start = origin_x + glyph_run.offset();
    let baseline_y = origin_y + glyph_run.baseline();

    // Positioned glyphs, materialised once so each fill pass and the decoration reuse them.
    let mut run_x = glyph_run.offset();
    let glyphs: Vec<Glyph> = glyph_run
        .glyphs()
        .map(|glyph| {
            let x = origin_x + run_x + glyph.x;
            let y = baseline_y - glyph.y;
            run_x += glyph.advance;
            Glyph { id: glyph.id, x, y }
        })
        .collect();

    let run = glyph_run.run();
    let font = run.font();
    let font_size = run.font_size();
    let normalized_coords: &[i16] = run.normalized_coords();

    for fill in &style.brush.fills {
        if set_paint(ctx, fill, bounds) {
            ctx.glyph_run(resources, font)
                .font_size(font_size)
                .normalized_coords(bytemuck::cast_slice(normalized_coords))
                .hint(true)
                .fill_glyphs(glyphs.iter().cloned());
        }
    }

    // Strokes over the fills, outlining the glyphs with glifo's `stroke_glyphs` — the text
    // counterpart of the `set_stroke` + `stroke_path` a shape uses. Only centre strokes reach
    // here (inner/outer are dropped at projection on both sides, like shape strokes), so the
    // width straddles the glyph edge with no offsetting decision to make.
    for stroke in strokes {
        if set_paint(ctx, &stroke.paint, bounds) {
            ctx.set_stroke(stroke.style.clone());
            ctx.glyph_run(resources, font)
                .font_size(font_size)
                .normalized_coords(bytemuck::cast_slice(normalized_coords))
                .hint(true)
                .stroke_glyphs(glyphs.iter().cloned());
        }
    }

    // The decoration line, tinted by the topmost (last) fill so it matches the visible ink.
    let decoration = style.brush.decoration;
    if decoration != render_core::text::TextDecoration::None {
        use render_core::text::TextDecoration as D;
        let metrics = run.metrics();
        // `*_offset` is the top of the line from the baseline; overline has no metric of its own, so
        // it rides at the ascent with the underline's thickness.
        let (offset, size) = match decoration {
            D::Underline => (metrics.underline_offset, metrics.underline_size),
            D::LineThrough => (metrics.strikethrough_offset, metrics.strikethrough_size),
            D::Overline => (metrics.ascent, metrics.underline_size),
            D::None => unreachable!(),
        };
        let x_range = run_start..=(run_start + glyph_run.advance());
        if let Some(fill) = style.brush.fills.last() {
            if set_paint(ctx, fill, bounds) {
                ctx.glyph_run(resources, font)
                    .font_size(font_size)
                    .normalized_coords(bytemuck::cast_slice(normalized_coords))
                    .hint(true)
                    .render_decoration(glyphs.iter().cloned(), x_range, baseline_y, offset, size, 0.0);
            }
        }
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

    // The first fill this backend can paint wins — not simply the first fill, or a shape whose
    // top fill is an image would render as nothing while a solid underneath it went unused.
    let painted = node.fills.iter().any(|f| set_paint(ctx, f, node.bounds));
    if painted {
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
        ctx.set_paint_transform(Affine::IDENTITY);
        return;
    }
    let path = outline(node);
    for stroke in &node.strokes {
        if !set_paint(ctx, &stroke.paint, node.bounds) {
            continue;
        }
        ctx.set_stroke(stroke.style.clone());
        ctx.stroke_path(&path);
    }

    // The paint transform is context state, not an argument: left set, the next shape's solid
    // fill would be drawn through this shape's gradient mapping.
    ctx.set_paint_transform(Affine::IDENTITY);
}

/// Install a paint as the current one. Returns false when this backend cannot draw it, so the
/// caller can fall through to the next fill rather than drawing nothing.
///
/// **Gradient coordinates are normalised to the shape's own box**, not page space — Penpot's
/// exporter emits `0..1` and render-wasm maps them with `translate(rect.origin) · scale(rect.size)`
/// as a shader-local matrix. Vello's paint transform has exactly those semantics (applied to the
/// paint after the geometry's transform), so the same mapping is expressed the same way. Drawn
/// without it, every gradient collapses into the top-left pixel of the page.
///
/// The paint's own transform composes *inside* that: it carries a radial gradient's rotation and
/// ellipse ratio, and an angular one's shear, all in unit-box space. `render_core::gradient`
/// builds it alongside the gradient so neither backend re-derives the matrix.
fn set_paint<T: RenderingContext>(ctx: &mut T, paint: &m::Paint, bounds: Rect) -> bool {
    match &paint.brush {
        Brush::Solid(color) => {
            ctx.set_paint_transform(Affine::IDENTITY);
            ctx.set_paint(*color);
            true
        }
        Brush::Gradient(g) => {
            ctx.set_paint_transform(unit_box_to(bounds) * paint.transform);
            ctx.set_paint(g.clone());
            true
        }
        Brush::Image(image) => {
            // Resolve the reference against the atlas the renderer filled from `store_image_rgba`.
            // Absent means the pixels have not arrived yet — draw nothing this frame rather than a
            // placeholder, and the next frame after the upload will show it.
            let Some(image_id) = crate::abi::resolve_image(image.id) else {
                return false;
            };
            let target = image.dest.unwrap_or(bounds);
            ctx.set_paint_transform(image_paint_transform(image, target));
            ctx.set_paint(vello_common::paint::Image {
                image: vello_common::paint::ImageSource::opaque_id(image_id),
                sampler: vello_common::peniko::ImageSampler {
                    // Clamp at the edges: with the cover/stretch transform the fill never samples
                    // outside the image, so the extend mode only matters at sub-pixel borders.
                    x_extend: vello_common::peniko::Extend::Pad,
                    y_extend: vello_common::peniko::Extend::Pad,
                    quality: vello_common::peniko::ImageQuality::Medium,
                    alpha: f32::from(image.opacity) / 255.0,
                },
            });
            true
        }
        Brush::Diamond(d) => {
            // Diamond has no peniko kind, so it is baked to a tile and drawn as an image. The
            // renderer's pre-pass (`stage_diamond_bakes`) rasterises the L1 field and uploads it
            // under this content key; here it resolves exactly like an image fill. Absent means
            // the bake has not landed yet — draw nothing this frame, painted the next.
            let Some(image_id) = crate::abi::resolve_image(d.content_key()) else {
                return false;
            };
            // The bake covers the unit box, but it is an *image* now, sampled in pixel space —
            // so the transform maps the whole tile `[0, TILE]²` onto the shape, exactly the
            // stretch a plain image uses. (Mapping unit space `[0,1]` here samples only the tile's
            // first pixel across the whole shape — which is how the first cut rendered solid.)
            // The non-square-shape distortion comes from this stretch, matching render-wasm's
            // normalised-space shader. Stop alphas are baked in; the sampler adds none.
            let tile = f64::from(crate::abi::DIAMOND_TILE);
            ctx.set_paint_transform(
                Affine::translate((bounds.x0, bounds.y0))
                    * Affine::scale_non_uniform(bounds.width() / tile, bounds.height() / tile),
            );
            ctx.set_paint(vello_common::paint::Image {
                image: vello_common::paint::ImageSource::opaque_id(image_id),
                sampler: vello_common::peniko::ImageSampler {
                    x_extend: vello_common::peniko::Extend::Pad,
                    y_extend: vello_common::peniko::Extend::Pad,
                    quality: vello_common::peniko::ImageQuality::Medium,
                    alpha: 1.0,
                },
            });
            true
        }
    }
}

/// Map the image's pixel space onto its target rect, in the shape's local coordinates.
///
/// Two placements, matching render-wasm's `get_source_rect`:
/// - **stretch** (default): the image fills the box exactly, distorting aspect if it must.
/// - **cover** (`keep_aspect`): the image is scaled by the larger axis ratio and centred, so it
///   covers the box with no letterboxing; the overflow is clipped by the fill to `target`.
fn image_paint_transform(image: &m::ImageFill, target: Rect) -> Affine {
    let (iw, ih) = (f64::from(image.width.max(1)), f64::from(image.height.max(1)));
    let (tw, th) = (target.width(), target.height());

    if image.keep_aspect {
        let scale = (tw / iw).max(th / ih);
        // Centre the scaled image over the target; the fill clips whatever spills past it.
        let ox = target.x0 + (tw - iw * scale) * 0.5;
        let oy = target.y0 + (th - ih * scale) * 0.5;
        Affine::translate((ox, oy)) * Affine::scale(scale)
    } else {
        Affine::translate((target.x0, target.y0)) * Affine::scale_non_uniform(tw / iw, th / ih)
    }
}

/// Maps the unit box onto `bounds` — the space Penpot's gradient coordinates live in.
fn unit_box_to(bounds: Rect) -> Affine {
    // A zero-extent axis would collapse the paint onto a line and hand the rasteriser a
    // singular matrix; leaving that axis unscaled keeps the fill finite and visible.
    let sx = if bounds.width().abs() > f64::EPSILON {
        bounds.width()
    } else {
        1.0
    };
    let sy = if bounds.height().abs() > f64::EPSILON {
        bounds.height()
    } else {
        1.0
    };
    Affine::translate((bounds.x0, bounds.y0)) * Affine::scale_non_uniform(sx, sy)
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
    frame.fills = vec![m::Paint::plain(Brush::Solid(Color::from_rgba8(56, 152, 236, 255)))];
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
        paint: m::Paint::plain(Brush::Solid(Color::from_rgba8(255, 255, 255, 255))),
    }];
    frame.clip = true;
    frame.children = vec![2, 3];
    s.insert(frame);

    let mut circle = m::Node::new(2, m::ShapeKind::Circle);
    circle.bounds = Rect::new(540.0, 420.0, 870.0, 750.0);
    // A radial gradient, deliberately squashed and rotated: the ellipse ratio and the angle
    // both live in the paint transform, so a circle filled with a plain circular gradient would
    // prove nothing about that path.
    let (radial, radial_transform) = render_core::gradient::gradient_paint(
        render_core::gradient::GradientShape::Radial,
        render_core::gradient::GradientGeometry {
            start: (0.5, 0.5),
            end: (0.95, 0.25),
            width: (0.55, 0.0),
        },
        &[
            render_core::peniko::ColorStop {
                offset: 0.0,
                color: Color::from_rgba8(255, 220, 120, 255).into(),
            },
            render_core::peniko::ColorStop {
                offset: 1.0,
                color: Color::from_rgba8(240, 90, 40, 255).into(),
            },
        ],
    )
    .expect("the demo gradient is not degenerate");
    circle.fills = vec![m::Paint {
        brush: Brush::Gradient(radial),
        transform: radial_transform,
    }];
    s.insert(circle);

    let mut rect = m::Node::new(3, m::ShapeKind::Rect);
    rect.bounds = Rect::new(180.0, 240.0, 420.0, 360.0);
    rect.transform = Affine::rotate(0.3);
    rect.fills = vec![m::Paint::plain(Brush::Solid(Color::from_rgba8(250, 250, 250, 255)))];
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
        paint: m::Paint::plain(Brush::Solid(Color::from_rgba8(20, 20, 20, 255))),
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
    path_node.fills = vec![m::Paint::plain(Brush::Solid(Color::from_rgba8(70, 190, 120, 255)))];
    s.insert(path_node);

    s
}
