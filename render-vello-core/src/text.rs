//! The neutral text draw path — lay a `render_core::model` text block out with Parley and draw its
//! glyph runs into any `RenderingContext`.
//!
//! This is the backend-neutral core of render-vello's text drawing: paragraph layout (styling each
//! span over exactly its characters), vertical alignment, and per-glyph-run fills/strokes/decoration.
//! Both Vello backends share it — render-vello's `scene.rs` delegates its non-editor text draw here
//! (keeping only the focused-editor overlay), and the classic backend renders text blocks through it.
//!
//! What stays out of here: the font *registration* (each backend fills its own Parley `FontContext`
//! from the faces the host uploaded) and the font-family *aliasing* (injected via [`DrawEnv::font_alias`]).
//! The caller owns the `FontContext`/`LayoutContext` and passes them in — a `FontContext` is expensive
//! to build, so it is kept across frames on the backend, not here.

use crate::draw::{set_paint, DrawEnv};
use glifo::Glyph;
use parley::{
    Alignment, AlignmentOptions, FontContext, FontFamily, GlyphRun, Layout, LayoutContext,
    LineHeight, PositionedLayoutItem, StyleProperty,
};
use render_core::kurbo::{Affine, Rect};
use render_core::model as m;
use render_core::text::{self, TextBrush};
use vello_example_scenes::RenderingContext;

/// The Parley state text layout needs, kept across frames on the backend (a `FontContext` is
/// expensive to build): the font collection each backend fills from its own uploaded faces, and the
/// reusable layout context. The neutral walk ([`crate::draw::draw_scene`]) threads `&mut TextState`
/// so it can lay a text node out on the way past. Font *registration* is the backend's job — it owns
/// `font_cx.collection` and registers faces under the names its [`DrawEnv::font_alias`] returns.
pub struct TextState {
    pub font_cx: FontContext,
    pub layout_cx: LayoutContext<TextBrush>,
}

impl Default for TextState {
    fn default() -> Self {
        Self { font_cx: FontContext::new(), layout_cx: LayoutContext::new() }
    }
}

impl TextState {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

/// Draw a text node's block: lay out its paragraphs, align them vertically in the box, and draw each
/// laid-out paragraph at the node's origin under `matrix`. The focused-editor path (selection, caret,
/// the editor's own live layout) is *not* here — that overlay stays in the hybrid backend.
pub fn draw_text_block<C: RenderingContext, E: DrawEnv>(
    ctx: &mut C,
    resources: &mut C::Resources,
    font_cx: &mut FontContext,
    layout_cx: &mut LayoutContext<TextBrush>,
    env: &E,
    node: &m::Node,
    matrix: Affine,
) {
    let Some(block) = &node.text else {
        return;
    };

    // `Fixed`/`AutoHeight` wrap to the box width; `AutoWidth` never wraps.
    let max_advance = match block.grow {
        text::TextGrow::AutoWidth => None,
        _ => Some(node.bounds.width() as f32),
    };

    // Lay out every paragraph first, so the total height is known before placing them — vertical
    // alignment needs it.
    let layouts: Vec<Layout<TextBrush>> = block
        .paragraphs
        .iter()
        .map(|paragraph| layout_paragraph(font_cx, layout_cx, env, paragraph, max_advance))
        .collect();
    let total_height: f32 = layouts.iter().map(Layout::height).sum();

    let box_height = node.bounds.height() as f32;
    let vertical_offset = match block.vertical_align {
        text::VerticalAlign::Top => 0.0,
        text::VerticalAlign::Center => (box_height - total_height) * 0.5,
        text::VerticalAlign::Bottom => box_height - total_height,
    };

    // Glyphs are placed in the node's own space (the same space `bounds` is in), then drawn under the
    // shape matrix — exactly how a rect's fill is positioned, so rotation and viewport apply the same
    // way.
    ctx.set_transform(matrix);
    ctx.set_paint_transform(Affine::IDENTITY);
    let origin_x = node.bounds.x0 as f32;
    let mut origin_y = node.bounds.y0 as f32 + vertical_offset;
    for layout in &layouts {
        draw_layout(ctx, resources, env, layout, origin_x, origin_y, node.bounds, &node.strokes);
        origin_y += layout.height();
    }
}

/// Lay out one paragraph into a Parley `Layout`, styling each span over exactly its characters.
fn layout_paragraph<E: DrawEnv>(
    font_cx: &mut FontContext,
    layout_cx: &mut LayoutContext<TextBrush>,
    env: &E,
    paragraph: &text::TextParagraph,
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
    let mut string = String::new();
    if paragraph.direction == text::TextDirection::Rtl {
        string.push('\u{200F}');
    }
    let mut ranges: Vec<std::ops::Range<usize>> = Vec::with_capacity(paragraph.spans.len());
    for span in &paragraph.spans {
        let start = string.len();
        string.push_str(&span.transform.apply(&span.text));
        ranges.push(start..string.len());
    }

    // Family aliases must outlive the builder (Parley borrows the name through `build`), so collect
    // them up front.
    let aliases: Vec<String> = paragraph
        .spans
        .iter()
        .map(|s| env.font_alias(s.font.id, s.font.weight, s.font.italic))
        .collect();

    let mut builder = layout_cx.ranged_builder(font_cx, &string, 1.0, true);
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

    let mut layout = builder.build(&string);
    layout.break_all_lines(max_advance);
    layout.align(alignment_of(paragraph.align), AlignmentOptions::default());
    layout
}

/// Penpot's absolute horizontal alignment → Parley's. Penpot's `Left`/`Right` are edges, not
/// direction-relative, so they map to `Left`/`Right` rather than `Start`/`End` — they stay put under
/// an RTL base direction, which only reorders the glyphs within the line.
fn alignment_of(align: text::TextAlign) -> Alignment {
    match align {
        text::TextAlign::Left => Alignment::Left,
        text::TextAlign::Center => Alignment::Center,
        text::TextAlign::Right => Alignment::Right,
        text::TextAlign::Justify => Alignment::Justify,
    }
}

/// Draw every glyph run in a laid-out paragraph at the given local origin. Public because the hybrid
/// backend's focused-editor overlay draws the editor's own `Layout` through it.
pub fn draw_layout<C: RenderingContext, E: DrawEnv>(
    ctx: &mut C,
    resources: &mut C::Resources,
    env: &E,
    layout: &Layout<TextBrush>,
    origin_x: f32,
    origin_y: f32,
    bounds: Rect,
    strokes: &[m::Stroke],
) {
    for line in layout.lines() {
        for item in line.items() {
            if let PositionedLayoutItem::GlyphRun(glyph_run) = item {
                draw_glyph_run(ctx, resources, env, &glyph_run, origin_x, origin_y, bounds, strokes);
            }
        }
    }
}

/// Draw one glyph run: its span's fills layered over the glyph coverage, then its decoration line.
///
/// The glyph positions are computed once and reused for every fill pass (and for the decoration's
/// skip-ink). Fills paint bottom-to-top — the order render-wasm's `merge_fills` composites them, each
/// new fill `SrcOver` the last — so a layered or gradient text fill reads the same way. Each fill
/// goes through the shared [`set_paint`], so a gradient text fill gets the same unit-box→bounds
/// mapping a gradient shape fill does; an unresolved image fill paints nothing rather than a hole.
fn draw_glyph_run<C: RenderingContext, E: DrawEnv>(
    ctx: &mut C,
    resources: &mut C::Resources,
    env: &E,
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
        if set_paint(ctx, env, fill, bounds) {
            ctx.glyph_run(resources, font)
                .font_size(font_size)
                .normalized_coords(bytemuck::cast_slice(normalized_coords))
                .hint(true)
                .fill_glyphs(glyphs.iter().cloned());
        }
    }

    // Strokes over the fills, outlining the glyphs with glifo's `stroke_glyphs` — the text
    // counterpart of the `set_stroke` + `stroke_path` a shape uses. Only centre strokes reach here
    // (inner/outer are dropped at projection on both sides, like shape strokes), so the width
    // straddles the glyph edge with no offsetting decision to make.
    for stroke in strokes {
        if set_paint(ctx, env, &stroke.paint, bounds) {
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
    if decoration != text::TextDecoration::None {
        use text::TextDecoration as D;
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
            if set_paint(ctx, env, fill, bounds) {
                ctx.glyph_run(resources, font)
                    .font_size(font_size)
                    .normalized_coords(bytemuck::cast_slice(normalized_coords))
                    .hint(true)
                    .render_decoration(glyphs.iter().cloned(), x_range, baseline_y, offset, size, 0.0);
            }
        }
    }
}
