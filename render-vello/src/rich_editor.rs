//! Rich (multi-span) text editing.
//!
//! Parley ships exactly one editor — [`parley::PlainEditor`] — and its own doc calls it a *"plain
//! text editor with a single style applied to the entire text"*: its `StyleSet` carries no ranges
//! and is, in Parley's words, *"unsuited for rich text"*. So focusing a multi-span shape with it
//! flattened every span to the first one's font, size and colour.
//!
//! But the pieces *under* `PlainEditor` are not single-style. [`parley::Selection`] and
//! [`parley::Cursor`] are generic over **any** `Layout<B>` — every method takes `&Layout` — and the
//! rich layout path already exists (`RangedBuilder`, the same one the non-editing draw uses). So the
//! rich editor is: keep our own span model, transform it on each edit, rebuild a **multi-style**
//! `Layout` with `RangedBuilder`, and drive `Selection`/`Cursor` over that. Caret motion, bidi
//! hit-testing, word boundaries and selection geometry are reused verbatim — the only genuinely new
//! logic is the span-transform on insert/delete ([`StyledText::replace_range`]).
//!
//! This module depends only on `parley` + `render_core` (no wgpu, no wasm), so the span-transform —
//! the part most worth testing — is unit-tested on the host below.
//!
//! **Scope of this slice.** Editing preserves and correctly lays out per-span styles: the caret no
//! longer drifts across differently-sized spans, and typing inherits the neighbouring span's style.
//! Two things stay as they were, noted where they bite: `export_content` still emits plain text
//! (serialising per-span *styles* back through render-wasm's export JSON is host-coupled and a
//! separate slice), and the whole block lays out under the first paragraph's alignment / base
//! direction (per-paragraph align + RTL base while editing is deferred — real RTL scripts still
//! reorder on their own).

use parley::{
    Affinity, Alignment, AlignmentOptions, BoundingBox, Cursor, FontContext, FontFamily,
    LayoutContext, LineHeight, Selection, StyleProperty,
};
use render_core::model::Paint;
use render_core::text::{FontRef, TextAlign, TextBlock, TextDecoration, TextGrow, TextSpan};

use parley::Layout;

/// The per-run style Parley carries through layout. Parley's `Brush` bound is
/// `Clone + PartialEq + Default + Debug`; the layout hands it back at each glyph run, so a run's
/// style follows the span it came from. It holds the span's whole fill list (drawn bottom-to-top
/// over the glyph coverage) and its decoration line. Defined here (not in `scene`) so the host-side
/// editor and its tests can build layouts without pulling in the wasm-only draw path.
#[derive(Clone, Debug, PartialEq, Default)]
pub(crate) struct TextBrush {
    pub fills: Vec<Paint>,
    pub decoration: TextDecoration,
}

/// The style of one editable run — everything a span carries *except* its text and case transform.
/// The transform is folded into the stored text at build time (as the plain editor already did), so
/// the editor works in the transformed text the user sees; the style itself is transform-free.
#[derive(Clone, Debug, PartialEq)]
struct SegStyle {
    font: FontRef,
    size: f32,
    line_height: f32,
    letter_spacing: f32,
    fills: Vec<Paint>,
    decoration: TextDecoration,
}

impl Default for SegStyle {
    fn default() -> Self {
        Self {
            font: FontRef { id: 0, weight: 400, italic: false },
            size: 16.0,
            line_height: 1.2,
            letter_spacing: 0.0,
            fills: Vec::new(),
            decoration: TextDecoration::None,
        }
    }
}

impl SegStyle {
    fn from_span(span: &TextSpan) -> Self {
        Self {
            font: span.font,
            size: span.size,
            line_height: span.line_height,
            letter_spacing: span.letter_spacing,
            fills: span.fills.clone(),
            decoration: span.decoration,
        }
    }
}

/// One contiguous run of `len` bytes in the editable text, all sharing `style`. Segments are
/// contiguous and covering: the sum of their `len`s equals the text length, and the start of each is
/// the running total of the earlier ones (kept implicit so an edit only has to rewrite lengths).
#[derive(Clone, Debug)]
struct Segment {
    len: usize,
    style: SegStyle,
}

/// The editable document: the flat string (paragraphs joined by `\n`, case transforms folded) and
/// the covering style segments over it. This is the piece an edit transforms; it has no Parley
/// dependency, so it is exhaustively unit-tested below.
#[derive(Clone, Debug)]
struct StyledText {
    text: String,
    segments: Vec<Segment>,
}

impl StyledText {
    /// Flatten a block into the editable string + segments. Spans concatenate; paragraphs are joined
    /// by a `\n` that extends the preceding segment (so it inherits a real style rather than needing
    /// its own). Adjacent runs with an equal style coalesce, keeping the segment list minimal.
    fn from_block(block: &TextBlock) -> Self {
        let default_style = block
            .paragraphs
            .iter()
            .flat_map(|p| p.spans.iter())
            .next()
            .map_or_else(SegStyle::default, SegStyle::from_span);

        let mut text = String::new();
        let mut segments: Vec<Segment> = Vec::new();

        let push = |segments: &mut Vec<Segment>, text: &mut String, s: &str, style: &SegStyle| {
            if s.is_empty() {
                return;
            }
            text.push_str(s);
            if let Some(last) = segments.last_mut() {
                if &last.style == style {
                    last.len += s.len();
                    return;
                }
            }
            segments.push(Segment { len: s.len(), style: style.clone() });
        };

        for (pi, paragraph) in block.paragraphs.iter().enumerate() {
            if pi > 0 {
                // Attach the paragraph-break newline to the previous segment (or a seed one if the
                // first paragraph was empty), so every byte is covered by a styled segment.
                if segments.is_empty() {
                    segments.push(Segment { len: 0, style: default_style.clone() });
                }
                segments.last_mut().unwrap().len += 1;
                text.push('\n');
            }
            for span in &paragraph.spans {
                let folded = span.transform.apply(&span.text);
                push(&mut segments, &mut text, &folded, &SegStyle::from_span(span));
            }
        }

        // An empty box still needs a segment to carry the style the first typed character inherits.
        if segments.is_empty() {
            segments.push(Segment { len: 0, style: default_style });
        }
        Self { text, segments }
    }

    /// The style newly inserted text at byte `pos` should take: the run to the *left* of the caret
    /// (the standard "typing continues the previous character's style"), or the run at `pos` when at
    /// the very start, or the default when empty.
    fn style_left(&self, pos: usize) -> SegStyle {
        let probe = pos.saturating_sub(1);
        let mut start = 0;
        for seg in &self.segments {
            let end = start + seg.len;
            // `probe < end` finds the covering run; for `pos == 0` (probe 0) this is the first
            // non-empty run. `<=` on the last boundary lets a caret at end-of-text inherit the last.
            if probe < end || end == self.text.len() {
                return seg.style.clone();
            }
            start = end;
        }
        self.segments.last().map_or_else(SegStyle::default, |s| s.style.clone())
    }

    /// Replace bytes `[a, b)` with `insert`, styling the inserted run with `style`. Rebuilds the
    /// segment list in three ordered parts — the content before `a`, the inserted run, the content
    /// after `b` — coalescing equal-styled neighbours. `a`/`b` are clamped and ordered by the caller
    /// (they come from a Parley selection, always on cluster boundaries).
    fn replace_range(&mut self, a: usize, b: usize, insert: &str, style: SegStyle) {
        let a = a.min(self.text.len());
        let b = b.min(self.text.len()).max(a);

        let mut new_text = String::with_capacity(self.text.len() - (b - a) + insert.len());
        new_text.push_str(&self.text[..a]);
        new_text.push_str(insert);
        new_text.push_str(&self.text[b..]);

        let mut segs: Vec<Segment> = Vec::new();
        let push = |segs: &mut Vec<Segment>, len: usize, style: &SegStyle| {
            if len == 0 {
                return;
            }
            if let Some(last) = segs.last_mut() {
                if &last.style == style {
                    last.len += len;
                    return;
                }
            }
            segs.push(Segment { len, style: style.clone() });
        };

        // Content kept from before the cut.
        let mut pos = 0;
        for seg in &self.segments {
            let (s, e) = (pos, pos + seg.len);
            pos = e;
            if s < a {
                push(&mut segs, e.min(a) - s, &seg.style);
            }
        }
        // The inserted run.
        push(&mut segs, insert.len(), &style);
        // Content kept from after the cut.
        let mut pos = 0;
        for seg in &self.segments {
            let (s, e) = (pos, pos + seg.len);
            pos = e;
            if e > b {
                push(&mut segs, e - s.max(b), &seg.style);
            }
        }

        if segs.is_empty() {
            // Everything was deleted: keep the just-used style so the next keystroke inherits it.
            segs.push(Segment { len: 0, style });
        }
        debug_assert_eq!(segs.iter().map(|s| s.len).sum::<usize>(), new_text.len());
        self.text = new_text;
        self.segments = segs;
    }
}

/// A focused, editable text shape: our span model, its multi-style Parley layout, and the caret /
/// selection over that layout. Mirrors what [`parley::PlainEditor`] does, but with per-range styles
/// instead of one `StyleSet`. The `FontContext`/`LayoutContext` live on the scene's text engine (the
/// render pass owns them), so every layout-building method takes them by reference.
pub(crate) struct RichEditor {
    model: StyledText,
    layout: Layout<TextBrush>,
    selection: Selection,
    /// Byte range of the IME pre-edit (composing) text in `model.text`, or `None`.
    compose: Option<std::ops::Range<usize>>,
    /// Wrap width (`None` for auto-width, which never wraps).
    width: Option<f32>,
    /// The whole block lays out under one alignment (the first paragraph's) — see the module note.
    align: Alignment,
}

impl RichEditor {
    /// Build the editor for a block, laid out to `width`, caret at the start.
    pub(crate) fn build(
        block: &TextBlock,
        width: f32,
        font_cx: &mut FontContext,
        layout_cx: &mut LayoutContext<TextBrush>,
    ) -> Self {
        let model = StyledText::from_block(block);
        let width = match block.grow {
            TextGrow::AutoWidth => None,
            _ => Some(width),
        };
        let align = block
            .paragraphs
            .first()
            .map_or(Alignment::Left, |p| alignment_of(p.align));
        let layout = build_layout(&model, width, align, font_cx, layout_cx);
        let selection = Selection::from_byte_index(&layout, 0, Affinity::Downstream);
        Self { model, layout, selection, compose: None, width, align }
    }

    /// Rebuild the layout from the current model (after a text change), keeping the selection valid.
    fn relayout(&mut self, font_cx: &mut FontContext, layout_cx: &mut LayoutContext<TextBrush>) {
        self.layout = build_layout(&self.model, self.width, self.align, font_cx, layout_cx);
        self.selection = self.selection.refresh(&self.layout);
    }

    /// Apply one queued command against the live layout. Selection-only commands read the current
    /// layout; text-changing commands rewrite the model and relayout. `overtype` makes a collapsed
    /// insert replace the character ahead first.
    pub(crate) fn apply(
        &mut self,
        command: EditorCommandRef<'_>,
        overtype: bool,
        font_cx: &mut FontContext,
        layout_cx: &mut LayoutContext<TextBrush>,
    ) {
        use EditorCommandRef as C;
        match command {
            C::PointerDown(x, y) => self.selection = Selection::from_point(&self.layout, x, y),
            C::ExtendToPoint(x, y) => {
                self.selection = self.selection.extend_to_point(&self.layout, x, y);
            }
            C::SelectWord(x, y) => self.selection = Selection::word_from_point(&self.layout, x, y),
            C::SelectAll => {
                let anchor = Cursor::from_byte_index(&self.layout, 0, Affinity::Downstream);
                let focus =
                    Cursor::from_byte_index(&self.layout, self.model.text.len(), Affinity::Upstream);
                self.selection = Selection::new(anchor, focus);
            }
            C::Insert(s) => {
                let (a, b) = self.sel_range();
                let b = if a == b && overtype { self.next_index(a) } else { b };
                self.edit(a, b, s, font_cx, layout_cx);
            }
            C::InsertParagraph => {
                let (a, b) = self.sel_range();
                self.edit(a, b, "\n", font_cx, layout_cx);
            }
            C::DeleteBackward(word) => {
                let (a, b) = self.sel_range();
                if a != b {
                    self.edit(a, b, "", font_cx, layout_cx);
                } else {
                    let start = if word { self.prev_word_index(a) } else { self.prev_index(a) };
                    self.edit(start, a, "", font_cx, layout_cx);
                }
            }
            C::DeleteForward(word) => {
                let (a, b) = self.sel_range();
                if a != b {
                    self.edit(a, b, "", font_cx, layout_cx);
                } else {
                    let end = if word { self.next_word_index(a) } else { self.next_index(a) };
                    self.edit(a, end, "", font_cx, layout_cx);
                }
            }
            C::Move { direction, word, extend } => {
                self.selection = self.moved(direction, word, extend);
            }
            C::SetCompose(s) => self.set_compose(s, font_cx, layout_cx),
            C::CommitCompose(s) => self.commit_compose(s, font_cx, layout_cx),
        }
    }

    /// Splice text and place the caret after the insertion. Any IME composition is cancelled.
    fn edit(
        &mut self,
        a: usize,
        b: usize,
        insert: &str,
        font_cx: &mut FontContext,
        layout_cx: &mut LayoutContext<TextBrush>,
    ) {
        self.compose = None;
        let style = self.model.style_left(a);
        self.model.replace_range(a, b, insert, style);
        self.relayout(font_cx, layout_cx);
        let caret = (a + insert.len()).min(self.model.text.len());
        self.selection = Selection::from_byte_index(&self.layout, caret, Affinity::Downstream);
    }

    /// Set the IME pre-edit text: replace the existing composition, or (first update) insert at the
    /// caret and remember the range. The caret sits at the end of the pre-edit, as IMEs expect.
    fn set_compose(
        &mut self,
        s: &str,
        font_cx: &mut FontContext,
        layout_cx: &mut LayoutContext<TextBrush>,
    ) {
        let (start, remove_end) = match self.compose.clone() {
            Some(r) => (r.start, r.end),
            None => {
                let (a, b) = self.sel_range();
                // Drop any selected text the composition replaces, then compose at that point.
                (a, b)
            }
        };
        let style = self.model.style_left(start);
        self.model.replace_range(start, remove_end, s, style);
        self.relayout(font_cx, layout_cx);
        let end = start + s.len();
        self.compose = (!s.is_empty()).then(|| start..end);
        self.selection = Selection::from_byte_index(&self.layout, end, Affinity::Downstream);
    }

    /// End composition: remove the pre-edit, then insert the committed text (empty just cancels).
    fn commit_compose(
        &mut self,
        s: &str,
        font_cx: &mut FontContext,
        layout_cx: &mut LayoutContext<TextBrush>,
    ) {
        if let Some(r) = self.compose.take() {
            let style = self.model.style_left(r.start);
            self.model.replace_range(r.start, r.end, "", style);
            self.relayout(font_cx, layout_cx);
            self.selection = Selection::from_byte_index(&self.layout, r.start, Affinity::Downstream);
        }
        if !s.is_empty() {
            let (a, b) = self.sel_range();
            self.edit(a, b, s, font_cx, layout_cx);
        }
    }

    /// Move the selection per render-wasm's `CursorDirection` (0 Backward, 1 Forward, 2 up, 3 down,
    /// 4 LineStart, 5 LineEnd); `word` moves by word; `extend` grows rather than collapses.
    fn moved(&self, direction: u32, word: bool, extend: bool) -> Selection {
        let l = &self.layout;
        match (direction, word) {
            (0, false) => self.selection.previous_visual(l, extend),
            (0, true) => self.selection.previous_visual_word(l, extend),
            (1, false) => self.selection.next_visual(l, extend),
            (1, true) => self.selection.next_visual_word(l, extend),
            (2, _) => self.selection.move_lines(l, -1, extend),
            (3, _) => self.selection.move_lines(l, 1, extend),
            (4, _) => self.selection.line_start(l, extend),
            (5, _) => self.selection.line_end(l, extend),
            _ => self.selection,
        }
    }

    /// The selection as an ordered byte range `[start, end)`.
    fn sel_range(&self) -> (usize, usize) {
        let r = self.selection.text_range();
        (r.start, r.end)
    }

    fn prev_index(&self, a: usize) -> usize {
        Cursor::from_byte_index(&self.layout, a, Affinity::Upstream)
            .previous_visual(&self.layout)
            .index()
    }
    fn next_index(&self, a: usize) -> usize {
        Cursor::from_byte_index(&self.layout, a, Affinity::Downstream)
            .next_visual(&self.layout)
            .index()
    }
    fn prev_word_index(&self, a: usize) -> usize {
        Cursor::from_byte_index(&self.layout, a, Affinity::Upstream)
            .previous_visual_word(&self.layout)
            .index()
    }
    fn next_word_index(&self, a: usize) -> usize {
        Cursor::from_byte_index(&self.layout, a, Affinity::Downstream)
            .next_visual_word(&self.layout)
            .index()
    }

    // --- read-back for the render pass / ABI ---------------------------------------------------

    pub(crate) fn text(&self) -> &str {
        &self.model.text
    }

    pub(crate) fn selection_range(&self) -> (usize, usize) {
        self.sel_range()
    }

    pub(crate) fn layout(&self) -> &Layout<TextBrush> {
        &self.layout
    }

    /// The caret rectangle `[left, top, width, height]` in text-local space.
    pub(crate) fn caret_rect(&self, width: f32) -> [f32; 4] {
        let b = self.selection.focus().geometry(&self.layout, width);
        [b.x0 as f32, b.y0 as f32, (b.x1 - b.x0) as f32, (b.y1 - b.y0) as f32]
    }

    /// The selection highlight rectangles, one per covered line fragment.
    pub(crate) fn selection_geometry(&self) -> Vec<BoundingBox> {
        self.selection.geometry(&self.layout).into_iter().map(|(b, _)| b).collect()
    }
}

/// A borrowed edit command, so the render pass can apply the queue without cloning the payload
/// strings. Mirrors `crate::editor::EditorCommand`; kept separate so this module has no dependency on
/// the ABI state.
pub(crate) enum EditorCommandRef<'a> {
    PointerDown(f32, f32),
    ExtendToPoint(f32, f32),
    SelectWord(f32, f32),
    SelectAll,
    Insert(&'a str),
    InsertParagraph,
    DeleteBackward(bool),
    DeleteForward(bool),
    Move { direction: u32, word: bool, extend: bool },
    SetCompose(&'a str),
    CommitCompose(&'a str),
}

/// Penpot's absolute horizontal alignment → Parley's. `Left`/`Right` are edges (not
/// direction-relative), so they stay put under an RTL base.
fn alignment_of(align: TextAlign) -> Alignment {
    match align {
        TextAlign::Left => Alignment::Left,
        TextAlign::Center => Alignment::Center,
        TextAlign::Right => Alignment::Right,
        TextAlign::Justify => Alignment::Justify,
    }
}

/// Build one multi-style Parley `Layout` for the whole editable text — the same `RangedBuilder` path
/// the non-editing draw uses, but pushing every segment's style over its byte range. Newlines in the
/// text become hard line breaks. Family aliases are collected up front because `FontFamily::named`
/// borrows the name through `build`.
fn build_layout(
    model: &StyledText,
    width: Option<f32>,
    align: Alignment,
    font_cx: &mut FontContext,
    layout_cx: &mut LayoutContext<TextBrush>,
) -> Layout<TextBrush> {
    let aliases: Vec<String> = model
        .segments
        .iter()
        .map(|seg| crate::abi::font_alias(seg.style.font.id, seg.style.font.weight, seg.style.font.italic))
        .collect();

    let mut builder = layout_cx.ranged_builder(font_cx, &model.text, 1.0, true);
    let mut pos = 0;
    for (seg, alias) in model.segments.iter().zip(&aliases) {
        let range = pos..pos + seg.len;
        pos += seg.len;
        if seg.len == 0 {
            continue;
        }
        builder.push(StyleProperty::FontFamily(FontFamily::named(alias)), range.clone());
        builder.push(StyleProperty::FontSize(seg.style.size), range.clone());
        builder.push(
            StyleProperty::LineHeight(LineHeight::FontSizeRelative(seg.style.line_height)),
            range.clone(),
        );
        builder.push(StyleProperty::LetterSpacing(seg.style.letter_spacing), range.clone());
        builder.push(
            StyleProperty::Brush(TextBrush {
                fills: seg.style.fills.clone(),
                decoration: seg.style.decoration,
            }),
            range,
        );
    }

    let mut layout = builder.build(&model.text);
    layout.break_all_lines(width);
    layout.align(align, AlignmentOptions::default());
    layout
}

#[cfg(test)]
mod tests {
    use super::*;
    use render_core::text::{TextParagraph, TextTransform};

    fn span(text: &str, size: f32) -> TextSpan {
        TextSpan {
            text: text.to_string(),
            font: FontRef { id: 1, weight: 400, italic: false },
            size,
            line_height: 1.2,
            letter_spacing: 0.0,
            fills: Vec::new(),
            decoration: TextDecoration::None,
            transform: TextTransform::None,
        }
    }

    fn paragraph(spans: Vec<TextSpan>) -> TextParagraph {
        TextParagraph {
            align: TextAlign::Left,
            direction: render_core::text::TextDirection::Ltr,
            line_height: 1.2,
            letter_spacing: 0.0,
            spans,
        }
    }

    fn block(paragraphs: Vec<TextParagraph>) -> TextBlock {
        TextBlock { paragraphs, grow: TextGrow::AutoWidth, vertical_align: render_core::text::VerticalAlign::Top }
    }

    fn seg_lens(t: &StyledText) -> Vec<usize> {
        t.segments.iter().map(|s| s.len).collect()
    }

    #[test]
    fn flattens_spans_and_coalesces() {
        // Two spans, same style → one coalesced segment; different size → two segments.
        let same = StyledText::from_block(&block(vec![paragraph(vec![span("ab", 16.0), span("cd", 16.0)])]));
        assert_eq!(same.text, "abcd");
        assert_eq!(seg_lens(&same), vec![4]);

        let diff = StyledText::from_block(&block(vec![paragraph(vec![span("ab", 16.0), span("cd", 24.0)])]));
        assert_eq!(diff.text, "abcd");
        assert_eq!(seg_lens(&diff), vec![2, 2]);
    }

    #[test]
    fn paragraphs_join_with_newline_on_previous_segment() {
        let t = StyledText::from_block(&block(vec![
            paragraph(vec![span("ab", 16.0)]),
            paragraph(vec![span("cd", 24.0)]),
        ]));
        assert_eq!(t.text, "ab\ncd");
        // The '\n' rides on the first paragraph's segment.
        assert_eq!(seg_lens(&t), vec![3, 2]);
        assert_eq!(seg_lens(&t).iter().sum::<usize>(), t.text.len());
    }

    #[test]
    fn empty_block_keeps_a_style_carrying_segment() {
        let t = StyledText::from_block(&block(vec![paragraph(vec![span("", 20.0)])]));
        assert_eq!(t.text, "");
        assert_eq!(seg_lens(&t), vec![0]);
        assert_eq!(t.style_left(0).size, 20.0);
    }

    #[test]
    fn insert_inherits_style_to_the_left() {
        // "AA" (16) + "BB" (24). Insert at byte 2 (the AA|BB boundary) inherits the *left* run (16),
        // extending the first segment.
        let mut t = StyledText::from_block(&block(vec![paragraph(vec![span("AA", 16.0), span("BB", 24.0)])]));
        let style = t.style_left(2);
        assert_eq!(style.size, 16.0);
        t.replace_range(2, 2, "xx", style);
        assert_eq!(t.text, "AAxxBB");
        assert_eq!(seg_lens(&t), vec![4, 2]);
    }

    #[test]
    fn insert_in_the_middle_of_a_run_splits_nothing() {
        let mut t = StyledText::from_block(&block(vec![paragraph(vec![span("AABB", 16.0)])]));
        let style = t.style_left(2);
        t.replace_range(2, 2, "x", style);
        assert_eq!(t.text, "AAxBB");
        assert_eq!(seg_lens(&t), vec![5]); // all one style → coalesced
    }

    #[test]
    fn delete_across_segments_clips_both() {
        // "AA"(16) "BB"(24) "CC"(16): delete bytes [1,5) leaves "A" + "C" — first and last runs.
        let mut t = StyledText::from_block(&block(vec![paragraph(vec![
            span("AA", 16.0),
            span("BB", 24.0),
            span("CC", 16.0),
        ])]));
        assert_eq!(seg_lens(&t), vec![2, 2, 2]);
        t.replace_range(1, 5, "", SegStyle::default());
        assert_eq!(t.text, "AC");
        // "A" (16) then "C" (16) — same style, coalesced.
        assert_eq!(seg_lens(&t), vec![2]);
    }

    #[test]
    fn replace_selection_takes_left_style() {
        let mut t = StyledText::from_block(&block(vec![paragraph(vec![span("AA", 16.0), span("BB", 24.0)])]));
        // Select "AB" (bytes 1..3), replace with "z" — inherits left of byte 1 (the 16 run).
        let style = t.style_left(1);
        assert_eq!(style.size, 16.0);
        t.replace_range(1, 3, "z", style);
        assert_eq!(t.text, "AzB");
        assert_eq!(seg_lens(&t), vec![2, 1]); // "Az"(16) + "B"(24)
    }
}
