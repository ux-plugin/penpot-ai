//! The neutral text draw path — lay a `crate::model` text block out with Parley and draw its
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

use crate::vello::draw::{set_paint, DrawEnv};
use crate::vello::rich_editor::{EditorCommandRef, RichEditor};
use glifo::Glyph;
use parley::fontique::{FontInfoOverride, GenericFamily};
use parley::{
    Alignment, AlignmentOptions, FontContext, FontFamily, GlyphRun, Layout, LayoutContext,
    LineHeight, PositionedLayoutItem, StyleProperty,
};
use crate::kurbo::{Affine, Rect};
use crate::model as m;
use crate::text::{self, TextBrush};
use vello_example_scenes::RenderingContext;

/// The Parley state text layout needs, kept across frames on the backend (a `FontContext` is
/// expensive to build): the font collection each backend fills from its own uploaded faces, and the
/// reusable layout context. The neutral walk ([`crate::vello::draw::draw_scene`]) threads `&mut TextState`
/// so it can lay a text node out on the way past. Font *registration* is the backend's job — it owns
/// `font_cx.collection` and registers faces under the names its [`DrawEnv::font_alias`] returns.
pub struct TextState {
    pub font_cx: FontContext,
    pub layout_cx: LayoutContext<TextBrush>,
    /// This consumer's position in the shared font registry — see
    /// [`crate::vello::abi::fonts_since`]. Starts at 0 so a `TextState` created after faces were
    /// uploaded still registers all of them on its first sync.
    registry_cursor: usize,
    /// The live editor for the focused text shape, if any ([`RichEditor`] holds the span model, its
    /// multi-style layout, and the caret/selection over it). Rebuilt when focus moves; `None` when
    /// nothing is being edited. See [`crate::vello::editor`] for why the ABI only queues into this
    /// via the render pass.
    pub editor: Option<RichEditor>,
    /// The shape id `editor` was built for, so a focus change triggers a rebuild.
    pub editor_for: Option<u128>,
}

impl Default for TextState {
    fn default() -> Self {
        Self {
            font_cx: FontContext::new(),
            layout_cx: LayoutContext::new(),
            registry_cursor: 0,
            editor: None,
            editor_for: None,
        }
    }
}

impl TextState {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register every face published since this state's last call into the font collection, under
    /// the same alias [`crate::vello::abi::font_alias`] produces — so [`DrawEnv::font_alias`] finds it.
    /// Reads the shared registry through this state's own cursor ([`crate::vello::abi::fonts_since`]),
    /// so any number of `TextState`s — one per renderer, one for measurement — each receive every
    /// face exactly once, regardless of creation order. Idempotent; the backend calls it once per
    /// frame before laying text out.
    pub fn sync_fonts(&mut self) {
        for font in crate::vello::abi::fonts_since(&mut self.registry_cursor) {
            let registered = self.font_cx.collection.register_fonts(
                font.bytes,
                Some(FontInfoOverride {
                    family_name: Some(&font.alias),
                    width: None,
                    style: None,
                    weight: None,
                    axes: None,
                }),
            );
            if font.is_emoji {
                let ids = registered.iter().map(|(family_id, _)| *family_id);
                self.font_cx.collection.append_generic_families(GenericFamily::Emoji, ids);
            }
        }
    }

    /// Bring the editor in step with the ABI: rebuild it when focus moves, apply the queued edit
    /// commands, and report the selection state back. Runs inside the render pass — the only place
    /// the `FontContext` the edited text lays out against is reachable (see
    /// [`crate::vello::editor`]). Shared by both backends: each calls it once per frame with the
    /// live scene before drawing.
    pub fn sync_editor(&mut self, scene: &m::Scene) {
        let (focused, commands) = crate::vello::editor::take_focus_and_commands();
        let Self { font_cx, layout_cx, editor, editor_for, .. } = self;

        let Some(id) = focused else {
            *editor = None;
            *editor_for = None;
            crate::vello::editor::clear_snapshot();
            return;
        };

        if *editor_for != Some(id) {
            *editor = scene.get(id).and_then(|node| node.text.as_ref()).map(|block| {
                let width = scene.get(id).map_or(0.0, |n| n.bounds.width() as f32);
                RichEditor::build(block, width, font_cx, layout_cx)
            });
            *editor_for = Some(id);
        }

        let Some(ed) = editor.as_mut() else {
            crate::vello::editor::clear_snapshot();
            return;
        };

        let overtype = crate::vello::editor::overtype();
        for command in &commands {
            use crate::vello::editor::EditorCommand as C;
            let borrowed = match command {
                C::PointerDown(x, y) => EditorCommandRef::PointerDown(*x, *y),
                C::ExtendToPoint(x, y) => EditorCommandRef::ExtendToPoint(*x, *y),
                C::SelectWord(x, y) => EditorCommandRef::SelectWord(*x, *y),
                C::SelectAll => EditorCommandRef::SelectAll,
                C::Insert(s) => EditorCommandRef::Insert(s),
                C::InsertParagraph => EditorCommandRef::InsertParagraph,
                C::DeleteBackward(word) => EditorCommandRef::DeleteBackward(*word),
                C::DeleteForward(word) => EditorCommandRef::DeleteForward(*word),
                C::Move { direction, word, extend } => {
                    EditorCommandRef::Move { direction: *direction, word: *word, extend: *extend }
                }
                C::SetCompose(s) => EditorCommandRef::SetCompose(s),
                C::CommitCompose(s) => EditorCommandRef::CommitCompose(s),
            };
            ed.apply(borrowed, overtype, font_cx, layout_cx);
        }

        let (start, end) = ed.selection_range();
        let caret = Some(ed.caret_rect(CARET_WIDTH));
        crate::vello::editor::set_snapshot(
            ed.text().to_string(),
            (start, end),
            caret,
            Some(ed.layout_size()),
        );
    }
}

/// Caret width in text-local units. Parley draws the caret as a thin rect of this width.
pub const CARET_WIDTH: f32 = 2.0;

/// Draw a text node, routing through the focused editor when this node is being edited: the editor's
/// own layout (so caret/selection align with the drawn glyphs) instead of the committed content.
/// The non-edited path is [`draw_text_block`] unchanged.
pub fn draw_text_node<C: RenderingContext, E: DrawEnv>(
    ctx: &mut C,
    resources: &mut C::Resources,
    state: &mut TextState,
    env: &E,
    node: &m::Node,
    matrix: Affine,
) {
    if state.editor_for == Some(node.id) && state.editor.is_some() {
        draw_focused_editor(ctx, resources, state, env, node, matrix);
        return;
    }
    draw_text_block(
        ctx,
        resources,
        &mut state.font_cx,
        &mut state.layout_cx,
        env,
        node,
        matrix,
        None,
    );
}

/// Draw a text shape that is being edited: its selection highlights, then its glyphs (from the
/// editor's own layout), then the caret — all in the node's space so they align with each other.
pub fn draw_focused_editor<C: RenderingContext, E: DrawEnv>(
    ctx: &mut C,
    resources: &mut C::Resources,
    state: &TextState,
    env: &E,
    node: &m::Node,
    matrix: Affine,
) {
    let Some(editor) = state.editor.as_ref() else {
        return;
    };
    let (ox, oy) = (node.bounds.x0, node.bounds.y0);

    ctx.set_transform(matrix);
    ctx.set_paint_transform(Affine::IDENTITY);
    ctx.set_paint(crate::vello::abi::argb_to_color(crate::vello::editor::selection_color()));
    for bbox in editor.selection_geometry() {
        ctx.fill_rect(&Rect::new(ox + bbox.x0, oy + bbox.y0, ox + bbox.x1, oy + bbox.y1));
    }

    draw_layout(
        ctx,
        resources,
        env,
        editor.layout(),
        ox as f32,
        oy as f32,
        node.bounds,
        &node.strokes,
        None,
    );

    if crate::vello::editor::blink_on() {
        let [cx, cy, cw, ch] = editor.caret_rect(CARET_WIDTH);
        ctx.set_transform(matrix);
        ctx.set_paint_transform(Affine::IDENTITY);
        ctx.set_paint(crate::vello::abi::argb_to_color(crate::vello::editor::cursor_color()));
        ctx.fill_rect(&Rect::new(
            ox + f64::from(cx),
            oy + f64::from(cy),
            ox + f64::from(cx + cw),
            oy + f64::from(cy + ch),
        ));
    }
}

/// The measurement-only `DrawEnv`: font aliases resolve through the shared ABI naming (the same
/// names every backend registers under), and images never resolve — measurement lays out glyphs,
/// it does not paint.
struct MeasureEnv;

impl DrawEnv for MeasureEnv {
    fn resolve_image(&self, _id: u128) -> Option<vello_common::paint::ImageId> {
        None
    }
    fn font_alias(&self, id: u128, weight: u16, italic: bool) -> String {
        crate::vello::abi::font_alias(id, weight, italic)
    }
}

std::thread_local! {
    /// The measurement consumer: its own Parley state, fed from the shared font registry through
    /// its own cursor ([`crate::vello::abi::fonts_since`]) — the third registry consumer besides
    /// the two backends. Lives outside any renderer so `get_text_dimensions` /
    /// `calculate_position_data` can lay text out synchronously from the C ABI.
    static MEASURE: std::cell::RefCell<Option<TextState>> = const { std::cell::RefCell::new(None) };
}

/// Lay the current shape's committed text out and hand back its metrics. When the queried shape is
/// the focused editor, the *live* editor layout's size (cached by the render pass each frame) wins,
/// so auto-grow follows what the user is typing rather than the stale committed content.
fn measure_current_shape() -> [f32; 5] {
    let Some(id) = crate::vello::abi::current_shape() else {
        return [0.0; 5];
    };
    crate::vello::abi::with_scene(|scene, _, _| {
        let Some(node) = scene.get(id) else {
            return [0.0; 5];
        };
        let (x, y) = (node.bounds.x0 as f32, node.bounds.y0 as f32);
        if let Some([w, h]) = crate::vello::editor::focused_layout_size(id) {
            let w = w.max(1.0);
            return [w, h, w, x, y];
        }
        let Some(block) = &node.text else {
            return [0.0, 0.0, 0.0, x, y];
        };
        let max_advance = match block.grow {
            crate::text::TextGrow::AutoWidth => None,
            _ => Some(node.bounds.width() as f32),
        };
        MEASURE.with(|cell| {
            let mut slot = cell.borrow_mut();
            let state = slot.get_or_insert_with(TextState::new);
            state.sync_fonts();
            let mut width: f32 = 0.0;
            let mut height: f32 = 0.0;
            for paragraph in &block.paragraphs {
                let layout = layout_paragraph(
                    &mut state.font_cx,
                    &mut state.layout_cx,
                    &MeasureEnv,
                    paragraph,
                    max_advance,
                );
                width = width.max(layout.width());
                height += layout.height();
            }
            let width = width.max(1.0);
            [width, height, width, x, y]
        })
    })
}

/// Keeps the last measurement result alive for the host to read (the same pattern as the editor's
/// `RESULT_STR`): the returned pointer is valid until the next call.
static MEASURE_RESULT: std::sync::Mutex<Vec<u8>> = std::sync::Mutex::new(Vec::new());

fn measure_result(bytes: Vec<u8>) -> *mut u8 {
    let mut guard = MEASURE_RESULT.lock().expect("measure result poisoned");
    *guard = bytes;
    guard.as_mut_ptr()
}

/// The laid-out dimensions of the current shape's text as five little-endian `f32`s
/// `[width, height, max_width, x, y]` — the wire format render-wasm's `get_text_dimensions` used,
/// which the host's auto-grow (`computeAutoSize`) reads every keystroke.
#[unsafe(no_mangle)]
pub extern "C" fn get_text_dimensions() -> *mut u8 {
    let dims = measure_current_shape();
    let mut bytes = Vec::with_capacity(20);
    for v in dims {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    measure_result(bytes)
}

/// Re-lay-out after a content change. Layout here happens at draw (and on demand in
/// [`get_text_dimensions`]), so there is no cached layout to invalidate — this only schedules a
/// frame, keeping render-wasm's wire contract.
#[unsafe(no_mangle)]
pub extern "C" fn update_shape_text_layout() {
    crate::vello::abi::request_frame();
}

/// Per-line position data for the current shape's text, in render-wasm's wire format: a `u32`
/// count, then 9 little-endian words per entry — `paragraph, span, start, end` (`u32`, byte
/// offsets within the paragraph), `x, y, width, height` (`f32`, shape-local), `direction` (`u32`).
/// The host attaches these to the saved document for line-level hit testing.
#[unsafe(no_mangle)]
pub extern "C" fn calculate_position_data() -> *mut u8 {
    let entries = position_data_entries();
    let mut bytes = Vec::with_capacity(4 + entries.len() * 36);
    bytes.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for e in entries {
        bytes.extend_from_slice(&e.paragraph.to_le_bytes());
        bytes.extend_from_slice(&e.span.to_le_bytes());
        bytes.extend_from_slice(&e.start.to_le_bytes());
        bytes.extend_from_slice(&e.end.to_le_bytes());
        for v in [e.x, e.y, e.width, e.height] {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        bytes.extend_from_slice(&e.direction.to_le_bytes());
    }
    measure_result(bytes)
}

struct PositionEntry {
    paragraph: u32,
    span: u32,
    start: u32,
    end: u32,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    direction: u32,
}

/// One entry per laid-out line: its byte range within its paragraph and its box in shape-local
/// space. Spans are not split per-line (`span` stays 0) — the host's consumers key on the line
/// geometry.
fn position_data_entries() -> Vec<PositionEntry> {
    let Some(id) = crate::vello::abi::current_shape() else {
        return Vec::new();
    };
    crate::vello::abi::with_scene(|scene, _, _| {
        let Some(node) = scene.get(id) else {
            return Vec::new();
        };
        let Some(block) = &node.text else {
            return Vec::new();
        };
        let max_advance = match block.grow {
            crate::text::TextGrow::AutoWidth => None,
            _ => Some(node.bounds.width() as f32),
        };
        MEASURE.with(|cell| {
            let mut slot = cell.borrow_mut();
            let state = slot.get_or_insert_with(TextState::new);
            state.sync_fonts();
            let mut entries = Vec::new();
            let mut para_y: f32 = 0.0;
            for (pi, paragraph) in block.paragraphs.iter().enumerate() {
                let layout = layout_paragraph(
                    &mut state.font_cx,
                    &mut state.layout_cx,
                    &MeasureEnv,
                    paragraph,
                    max_advance,
                );
                for line in layout.lines() {
                    let metrics = line.metrics();
                    let range = line.text_range();
                    entries.push(PositionEntry {
                        paragraph: pi as u32,
                        span: 0,
                        start: range.start as u32,
                        end: range.end as u32,
                        x: 0.0,
                        y: para_y + metrics.baseline - metrics.ascent,
                        width: metrics.advance,
                        height: metrics.ascent + metrics.descent,
                        direction: 0,
                    });
                }
                para_y += layout.height();
            }
            entries
        })
    })
}

/// Draw a text node's block: lay out its paragraphs, align them vertically in the box, and draw each
/// laid-out paragraph at the node's origin under `matrix`. The focused-editor path (selection, caret,
/// the editor's own live layout) is *not* here — that overlay stays in the hybrid backend.
///
/// `shadow` overrides every glyph-run's ink with one flat colour: `Some(c)` paints the block's whole
/// inked coverage (glyph fills, glyph strokes, decoration) in `c`, which is how a drop shadow stamps a
/// glyph-shaped silhouette to blur. `None` paints the real per-span fills/strokes/decoration.
pub fn draw_text_block<C: RenderingContext, E: DrawEnv>(
    ctx: &mut C,
    resources: &mut C::Resources,
    font_cx: &mut FontContext,
    layout_cx: &mut LayoutContext<TextBrush>,
    env: &E,
    node: &m::Node,
    matrix: Affine,
    shadow: Option<crate::peniko::Color>,
) {
    let Some(block) = &node.text else {
        return;
    };

    let max_advance = match block.grow {
        text::TextGrow::AutoWidth => None,
        _ => Some(node.bounds.width() as f32),
    };

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

    ctx.set_transform(matrix);
    ctx.set_paint_transform(Affine::IDENTITY);
    let origin_x = node.bounds.x0 as f32;
    let mut origin_y = node.bounds.y0 as f32 + vertical_offset;
    for layout in &layouts {
        draw_layout(ctx, resources, env, layout, origin_x, origin_y, node.bounds, &node.strokes, shadow);
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
    shadow: Option<crate::peniko::Color>,
) {
    for line in layout.lines() {
        for item in line.items() {
            if let PositionedLayoutItem::GlyphRun(glyph_run) = item {
                draw_glyph_run(ctx, resources, env, &glyph_run, origin_x, origin_y, bounds, strokes, shadow);
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
    shadow: Option<crate::peniko::Color>,
) {
    let style = glyph_run.style();
    if style.brush.fills.is_empty() && strokes.is_empty() {
        return;
    }

    let run_start = origin_x + glyph_run.offset();
    let baseline_y = origin_y + glyph_run.baseline();

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

    if let Some(sc) = shadow {
        if !style.brush.fills.is_empty() {
            ctx.set_paint(sc);
            ctx.glyph_run(resources, font)
                .font_size(font_size)
                .normalized_coords(bytemuck::cast_slice(normalized_coords))
                .hint(true)
                .fill_glyphs(glyphs.iter().cloned());
        }
        for stroke in strokes {
            ctx.set_paint(sc);
            ctx.set_stroke(stroke.style.clone());
            ctx.glyph_run(resources, font)
                .font_size(font_size)
                .normalized_coords(bytemuck::cast_slice(normalized_coords))
                .hint(true)
                .stroke_glyphs(glyphs.iter().cloned());
        }
        if style.brush.decoration != text::TextDecoration::None && !style.brush.fills.is_empty() {
            use text::TextDecoration as D;
            let metrics = run.metrics();
            let (offset, size) = match style.brush.decoration {
                D::Underline => (metrics.underline_offset, metrics.underline_size),
                D::LineThrough => (metrics.strikethrough_offset, metrics.strikethrough_size),
                D::Overline => (metrics.ascent, metrics.underline_size),
                D::None => unreachable!(),
            };
            let x_range = run_start..=(run_start + glyph_run.advance());
            ctx.set_paint(sc);
            ctx.glyph_run(resources, font)
                .font_size(font_size)
                .normalized_coords(bytemuck::cast_slice(normalized_coords))
                .hint(true)
                .render_decoration(glyphs.iter().cloned(), x_range, baseline_y, offset, size, 0.0);
        }
        return;
    }

    for fill in &style.brush.fills {
        if set_paint(ctx, env, fill, bounds) {
            ctx.glyph_run(resources, font)
                .font_size(font_size)
                .normalized_coords(bytemuck::cast_slice(normalized_coords))
                .hint(true)
                .fill_glyphs(glyphs.iter().cloned());
        }
    }

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

    let decoration = style.brush.decoration;
    if decoration != text::TextDecoration::None {
        use text::TextDecoration as D;
        let metrics = run.metrics();
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
