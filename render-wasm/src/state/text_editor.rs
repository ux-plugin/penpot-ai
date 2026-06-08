#![allow(dead_code)]

use macros::ToJs;

use crate::shapes::{
    Fill, FontFamily, FontStyle, Paragraph, SolidColor, TextAlign, TextContent, TextDecoration,
    TextDirection, TextPositionWithAffinity, TextSpan, TextTransform, VerticalAlign,
};
use crate::utils::uuid_from_u32_quartet;
use crate::uuid::Uuid;
use crate::wasm::text::helpers::{self as text_helpers, find_text_span_at_offset};
use crate::wasm::text_editor::CursorDirection;
use skia_safe::{
    textlayout::{Affinity, PositionWithAffinity},
    Color,
};

#[derive(Debug, Clone, Copy, Default)]
pub struct TextSelection {
    pub anchor: TextPositionWithAffinity,
    pub focus: TextPositionWithAffinity,
}

impl TextSelection {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_position_with_affinity(position: TextPositionWithAffinity) -> Self {
        Self {
            anchor: position,
            focus: position,
        }
    }

    pub fn is_collapsed(&self) -> bool {
        self.anchor == self.focus
    }

    pub fn is_selection(&self) -> bool {
        !self.is_collapsed()
    }

    pub fn reset(&mut self) {
        self.anchor.reset();
        self.focus.reset();
    }

    pub fn set_caret(&mut self, cursor: TextPositionWithAffinity) {
        self.anchor = cursor;
        self.focus = cursor;
    }

    pub fn extend_to(&mut self, cursor: TextPositionWithAffinity) {
        self.focus = cursor;
    }

    pub fn collapse_to_focus(&mut self) {
        self.anchor = self.focus;
    }

    pub fn collapse_to_anchor(&mut self) {
        self.focus = self.anchor;
    }

    pub fn start(&self) -> TextPositionWithAffinity {
        if self.anchor.paragraph < self.focus.paragraph {
            self.anchor
        } else if self.anchor.paragraph > self.focus.paragraph {
            self.focus
        } else if self.anchor.offset <= self.focus.offset {
            self.anchor
        } else {
            self.focus
        }
    }

    pub fn end(&self) -> TextPositionWithAffinity {
        if self.anchor.paragraph > self.focus.paragraph {
            self.anchor
        } else if self.anchor.paragraph < self.focus.paragraph {
            self.focus
        } else if self.anchor.offset >= self.focus.offset {
            self.anchor
        } else {
            self.focus
        }
    }
}

/// Events that the text editor can emit for frontend synchronization
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, ToJs)]
pub enum TextEditorEvent {
    None = 0,
    ContentChanged = 1,
    SelectionChanged = 2,
    StylesChanged = 3,
    NeedsLayout = 4,
}

/// FIXME: It should be better to get these constants from the frontend through the API.
const SELECTION_COLOR: Color = Color::from_argb(127, 0, 209, 184);
const CURSOR_COLOR: Color = Color::BLACK;
const CURSOR_WIDTH: f32 = 1.0;
const CURSOR_BLINK_INTERVAL_MS: f32 = 530.0;

#[derive(Debug)]
pub struct TextEditorStyles {
    pub vertical_align: VerticalAlign,
    pub text_align: Multiple<TextAlign>,         // Multiple
    pub text_direction: Multiple<TextDirection>, // Multiple
    pub text_decoration: Multiple<TextDecoration>,
    pub text_transform: Multiple<TextTransform>,
    pub font_family: Multiple<FontFamily>,
    pub font_size: Multiple<f32>,
    pub font_weight: Multiple<i32>,
    pub font_variant_id: Multiple<Uuid>,
    pub line_height: Multiple<f32>,
    pub letter_spacing: Multiple<f32>,
    pub fills_are_multiple: bool,
    pub fills: Vec<Fill>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
#[repr(u8)]
pub enum MultipleState {
    Undefined = 0,
    Single = 1,
    Multiple = 2,
}

#[derive(Debug)]
pub struct Multiple<T> {
    state: MultipleState,
    value: Option<T>,
}

impl<T> Multiple<T> {
    pub fn empty() -> Self {
        Self {
            state: MultipleState::Undefined,
            value: None,
        }
    }

    pub fn new(state: MultipleState, value: Option<T>) -> Self {
        Self { state, value }
    }

    pub fn state(&self) -> &MultipleState {
        &self.state
    }

    pub fn value(&self) -> &Option<T> {
        &self.value
    }

    pub fn is_undefined(&self) -> bool {
        self.state == MultipleState::Undefined
    }

    pub fn is_multiple(&self) -> bool {
        self.state == MultipleState::Multiple
    }

    pub fn is_single(&self) -> bool {
        self.state == MultipleState::Single
    }

    pub fn is_single_some(&self) -> bool {
        !self.is_undefined() && self.value.is_some()
    }

    pub fn is_single_none(&self) -> bool {
        !self.is_undefined() && self.value.is_none()
    }

    pub fn reset(&mut self) {
        self.state = MultipleState::Undefined;
        self.value = None;
    }

    pub fn set(&mut self, value: Option<T>) {
        if self.state == MultipleState::Undefined || self.state == MultipleState::Multiple {
            self.state = MultipleState::Single;
        }
        self.value = value;
    }

    pub fn set_single(&mut self, value: Option<T>) {
        self.state = MultipleState::Single;
        self.value = value;
    }

    pub fn set_multiple(&mut self) {
        self.state = MultipleState::Multiple;
        self.value = None;
    }

    pub fn merge(&mut self, value: Option<T>) -> bool
    where
        T: PartialEq,
    {
        if self.state == MultipleState::Multiple {
            return false;
        }

        if self.state == MultipleState::Undefined {
            self.set_single(value);
            return true;
        }

        if self.value.as_ref() != value.as_ref() {
            self.set_multiple();
            return false;
        }

        self.value = value;
        true
    }
}

impl TextEditorStyles {
    pub fn new() -> Self {
        Self {
            vertical_align: VerticalAlign::Top,
            text_align: Multiple::empty(),
            text_direction: Multiple::empty(),
            text_decoration: Multiple::empty(),
            text_transform: Multiple::empty(),
            font_family: Multiple::empty(),
            font_size: Multiple::empty(),
            font_weight: Multiple::empty(),
            font_variant_id: Multiple::empty(),
            line_height: Multiple::empty(),
            letter_spacing: Multiple::empty(),
            fills_are_multiple: false,
            fills: Vec::new(),
        }
    }

    pub fn reset(&mut self) {
        self.text_align.reset();
        self.text_direction.reset();
        self.text_decoration.reset();
        self.text_transform.reset();
        self.font_family.reset();
        self.font_size.reset();
        self.font_weight.reset();
        self.font_variant_id.reset();
        self.line_height.reset();
        self.letter_spacing.reset();
        self.fills_are_multiple = false;
        self.fills.clear();
    }
}

pub struct TextEditorTheme {
    pub selection_color: Color,
    pub cursor_color: Color,
    pub cursor_width: f32,
}

pub struct TextComposition {
    pub previous: String,
    pub current: String,
    pub is_composing: bool,
}

impl TextComposition {
    pub fn new() -> Self {
        Self {
            previous: String::new(),
            current: String::new(),
            is_composing: false,
        }
    }

    pub fn start(&mut self) -> bool {
        if self.is_composing {
            return false;
        }
        self.is_composing = true;
        self.previous = String::new();
        self.current = String::new();
        true
    }

    pub fn update(&mut self, text: &str) -> bool {
        if !self.is_composing {
            self.is_composing = true;
        }
        self.previous = self.current.clone();
        self.current = text.to_owned();
        true
    }

    pub fn end(&mut self) -> bool {
        if !self.is_composing {
            return false;
        }
        self.is_composing = false;
        true
    }

    pub fn get_selection(&self, selection: &TextSelection) -> TextSelection {
        if self.previous.is_empty() {
            return *selection;
        }

        let focus = selection.focus;
        let previous_len = self.previous.chars().count();
        let anchor = TextPositionWithAffinity::new_without_affinity(
            focus.paragraph,
            focus.offset + previous_len,
        );

        TextSelection { anchor, focus }
    }
}

pub struct TextEditorState {
    pub theme: TextEditorTheme,
    pub selection: TextSelection,
    pub composition: TextComposition,
    pub has_focus: bool,
    // This property indicates that we've started
    // selecting something with the pointer.
    pub is_pointer_selection_active: bool,
    pub is_click_event_skipped: bool,
    pub is_overtype_mode: bool,
    pub active_shape_id: Option<Uuid>,
    pub cursor_visible: bool,
    pub last_blink_time_ms: f32,
    pub current_styles: TextEditorStyles,
    pending_events: Vec<TextEditorEvent>,
}

impl TextEditorState {
    pub fn new() -> Self {
        Self {
            theme: TextEditorTheme {
                selection_color: SELECTION_COLOR,
                cursor_color: CURSOR_COLOR,
                cursor_width: CURSOR_WIDTH,
            },
            selection: TextSelection::new(),
            composition: TextComposition::new(),
            has_focus: false,
            is_pointer_selection_active: false,
            is_click_event_skipped: false,
            is_overtype_mode: false,
            active_shape_id: None,
            cursor_visible: true,
            last_blink_time_ms: 0.0,
            pending_events: Vec::new(),
            current_styles: TextEditorStyles::new(),
        }
    }

    pub fn focus(&mut self, shape_id: Uuid) {
        self.has_focus = true;
        self.active_shape_id = Some(shape_id);
        self.cursor_visible = true;
        self.last_blink_time_ms = 0.0;
        self.selection.reset();
        self.is_pointer_selection_active = false;
        self.is_overtype_mode = false;
        self.pending_events.clear();
    }

    pub fn blur(&mut self) {
        self.has_focus = false;
        // self.active_shape_id = None;
        self.cursor_visible = false;
        self.last_blink_time_ms = 0.0;
        // self.selection.reset();
        self.is_pointer_selection_active = false;
        self.is_overtype_mode = false;
        self.pending_events.clear();
    }

    pub fn dispose(&mut self) {
        self.has_focus = false;
        self.active_shape_id = None;
        self.cursor_visible = false;
        self.last_blink_time_ms = 0.0;
        self.selection.reset();
        self.is_pointer_selection_active = false;
        self.is_overtype_mode = false;
        self.pending_events.clear();
    }

    pub fn start_pointer_selection(&mut self) -> bool {
        if self.is_pointer_selection_active {
            return false;
        }
        self.is_pointer_selection_active = true;
        true
    }

    pub fn stop_pointer_selection(&mut self) -> bool {
        if !self.is_pointer_selection_active {
            return false;
        }
        self.is_pointer_selection_active = false;
        true
    }

    pub fn select_all(&mut self, text_content: &TextContent) -> bool {
        self.is_pointer_selection_active = false;
        self.set_caret_from_position(&TextPositionWithAffinity::empty());
        let num_paragraphs = text_content.paragraphs().len() - 1;
        let Some(last_paragraph) = text_content.paragraphs().last() else {
            return false;
        };
        #[allow(dead_code)]
        let _num_spans = last_paragraph.children().len() - 1;
        let Some(_last_text_span) = last_paragraph.children().last() else {
            return false;
        };
        let mut offset = 0;
        for span in last_paragraph.children() {
            offset += span.text.len();
        }
        self.extend_selection_from_position(&TextPositionWithAffinity::new(
            PositionWithAffinity {
                position: offset as i32,
                affinity: Affinity::Upstream,
            },
            num_paragraphs,
            offset,
        ));
        self.update_styles(text_content);
        self.reset_blink();
        self.push_event(TextEditorEvent::SelectionChanged);

        true
    }

    pub fn select_word_boundary(
        &mut self,
        text_content: &TextContent,
        position: &TextPositionWithAffinity,
    ) {
        self.is_pointer_selection_active = false;

        let paragraphs = text_content.paragraphs();
        if paragraphs.is_empty() || position.paragraph >= paragraphs.len() {
            return;
        }

        let paragraph = &paragraphs[position.paragraph];
        let paragraph_text: String = paragraph
            .children()
            .iter()
            .map(|span| span.text.as_str())
            .collect();

        let chars: Vec<char> = paragraph_text.chars().collect();
        if chars.is_empty() {
            self.set_caret_from_position(&TextPositionWithAffinity::new_without_affinity(
                position.paragraph,
                0,
            ));
            self.update_styles(text_content);
            self.reset_blink();
            self.push_event(TextEditorEvent::SelectionChanged);
            return;
        }

        let mut offset = position.offset.min(chars.len());

        if offset == chars.len() {
            offset = offset.saturating_sub(1);
        } else if !text_helpers::is_word_char(chars[offset])
            && offset > 0
            && text_helpers::is_word_char(chars[offset - 1])
        {
            offset -= 1;
        }

        if !text_helpers::is_word_char(chars[offset]) {
            self.set_caret_from_position(&TextPositionWithAffinity::new_without_affinity(
                position.paragraph,
                position.offset.min(chars.len()),
            ));
            self.update_styles(text_content);
            self.reset_blink();
            self.push_event(TextEditorEvent::SelectionChanged);
            return;
        }

        let mut start = offset;
        while start > 0 && text_helpers::is_word_char(chars[start - 1]) {
            start -= 1;
        }

        let mut end = offset + 1;
        while end < chars.len() && text_helpers::is_word_char(chars[end]) {
            end += 1;
        }

        self.set_caret_from_position(&TextPositionWithAffinity::new_without_affinity(
            position.paragraph,
            start,
        ));
        self.extend_selection_from_position(&TextPositionWithAffinity::new_without_affinity(
            position.paragraph,
            end,
        ));
        self.update_styles(text_content);
        self.reset_blink();
        self.push_event(TextEditorEvent::SelectionChanged);
    }

    pub fn set_caret_from_position(&mut self, position: &TextPositionWithAffinity) {
        self.selection.set_caret(*position);
        self.push_event(TextEditorEvent::SelectionChanged);
    }

    pub fn extend_selection_from_position(&mut self, position: &TextPositionWithAffinity) {
        self.selection.extend_to(*position);
        self.push_event(TextEditorEvent::SelectionChanged);
    }

    pub fn set_overtype_mode(&mut self, overtype_mode: bool) {
        self.is_overtype_mode = overtype_mode;
    }

    pub fn toggle_overtype_mode(&mut self) {
        self.set_overtype_mode(!self.is_overtype_mode);
    }

    fn update_styles_from_selection(&mut self, text_content: &TextContent) -> bool {
        let paragraphs = text_content.paragraphs();
        if paragraphs.is_empty() {
            return false;
        }

        let start = self.selection.start();
        if start.paragraph >= paragraphs.len() {
            return false;
        }

        let end = self.selection.end();
        let end_paragraph = end.paragraph.min(paragraphs.len() - 1);

        self.current_styles.reset();
        let mut has_selected_content = false;
        for (para_idx, paragraph) in paragraphs
            .iter()
            .enumerate()
            .take(end_paragraph + 1)
            .skip(start.paragraph)
        {
            let paragraph_char_count: usize = paragraph
                .children()
                .iter()
                .map(|span| span.text.chars().count())
                .sum();

            let range_start = if para_idx == start.paragraph {
                start.offset.min(paragraph_char_count)
            } else {
                0
            };

            let range_end = if para_idx == end.paragraph {
                end.offset.min(paragraph_char_count)
            } else {
                paragraph_char_count
            };

            if range_start >= range_end {
                continue;
            }

            has_selected_content = true;
            self.current_styles
                .text_align
                .merge(Some(paragraph.text_align()));

            let mut char_pos = 0;
            for span in paragraph.children() {
                let span_len = span.text.chars().count();
                let span_start = char_pos;
                let span_end = char_pos + span_len;
                char_pos += span_len;

                let selected_start = range_start.max(span_start);
                let selected_end = range_end.min(span_end);
                if selected_start >= selected_end {
                    continue;
                }

                self.current_styles
                    .text_direction
                    .merge(Some(span.text_direction));
                self.current_styles
                    .text_decoration
                    .merge(span.text_decoration);
                self.current_styles
                    .text_transform
                    .merge(span.text_transform);
                self.current_styles
                    .font_family
                    .merge(Some(span.font_family));
                self.current_styles.font_size.merge(Some(span.font_size));
                self.current_styles
                    .font_weight
                    .merge(Some(span.font_weight));
                self.current_styles
                    .font_variant_id
                    .merge(Some(span.font_variant_id));
                self.current_styles
                    .line_height
                    .merge(Some(span.line_height));
                self.current_styles
                    .letter_spacing
                    .merge(Some(span.letter_spacing));

                if self.current_styles.fills.is_empty() {
                    self.current_styles.fills.append(&mut span.fills.clone());
                } else if self.current_styles.fills != span.fills {
                    self.current_styles.fills_are_multiple = true;
                    self.current_styles.fills.append(&mut span.fills.clone());
                }
            }
        }

        has_selected_content
    }

    fn update_styles_from_caret(&mut self, text_content: &TextContent) -> bool {
        let focus = self.selection.focus;
        let paragraphs = text_content.paragraphs();
        let Some(current_paragraph) = paragraphs.get(focus.paragraph) else {
            return false;
        };
        let current_offset = focus.offset;
        let current_text_span = find_text_span_at_offset(current_paragraph, current_offset);

        self.current_styles.reset();
        self.current_styles
            .text_align
            .set_single(Some(current_paragraph.text_align()));
        if let Some((text_span_index, _)) = current_text_span {
            if let Some(text_span) = current_paragraph.children().get(text_span_index) {
                self.current_styles
                    .text_direction
                    .set_single(Some(text_span.text_direction));
                self.current_styles
                    .text_decoration
                    .set_single(text_span.text_decoration);
                self.current_styles
                    .text_transform
                    .set_single(text_span.text_transform);
                self.current_styles
                    .font_family
                    .set_single(Some(text_span.font_family));
                self.current_styles
                    .font_size
                    .set_single(Some(text_span.font_size));
                self.current_styles
                    .font_weight
                    .set_single(Some(text_span.font_weight));
                self.current_styles
                    .font_variant_id
                    .set_single(Some(text_span.font_variant_id));
                self.current_styles
                    .line_height
                    .set_single(Some(text_span.line_height));
                self.current_styles
                    .letter_spacing
                    .set_single(Some(text_span.letter_spacing));
                self.current_styles.fills = text_span.fills.clone();
            }
        } else {
            self.current_styles
                .line_height
                .set_single(Some(current_paragraph.line_height()));
            self.current_styles
                .letter_spacing
                .set_single(Some(current_paragraph.letter_spacing()));
        }
        true
    }

    pub fn update_styles(&mut self, text_content: &TextContent) -> bool {
        if self.selection.is_selection() {
            let styles_were_updated = self.update_styles_from_selection(text_content);
            if styles_were_updated {
                self.push_event(TextEditorEvent::StylesChanged);
            }
            return styles_were_updated;
        }
        // It is a caret.
        let styles_were_updated = self.update_styles_from_caret(text_content);
        if styles_were_updated {
            self.push_event(TextEditorEvent::StylesChanged);
        }
        styles_were_updated
    }

    pub fn update_blink(&mut self, timestamp_ms: f32) {
        if !self.has_focus {
            return;
        }

        if self.last_blink_time_ms == 0.0 {
            self.last_blink_time_ms = timestamp_ms;
            self.cursor_visible = true;
            return;
        }

        let elapsed = timestamp_ms - self.last_blink_time_ms;
        if elapsed >= CURSOR_BLINK_INTERVAL_MS {
            self.cursor_visible = !self.cursor_visible;
            self.last_blink_time_ms = timestamp_ms;
        }
    }

    pub fn reset_blink(&mut self) {
        self.cursor_visible = true;
        self.last_blink_time_ms = 0.0;
    }

    pub fn push_event(&mut self, event: TextEditorEvent) {
        if self.pending_events.last() != Some(&event) {
            self.pending_events.push(event);
        }
    }

    pub fn poll_event(&mut self) -> TextEditorEvent {
        self.pending_events.pop().unwrap_or(TextEditorEvent::None)
    }

    pub fn has_pending_events(&self) -> bool {
        !self.pending_events.is_empty()
    }

    pub fn delete_backward(&mut self, text_content: &mut TextContent, word_boundary: bool) {
        if self.selection.is_selection() {
            text_helpers::delete_selection_range(text_content, &self.selection);
            let start = self.selection.start();
            let clamped = text_helpers::clamp_cursor(start, text_content.paragraphs());
            self.selection.set_caret(clamped);
        } else if word_boundary {
            let cursor = self.selection.focus;
            if let Some(new_cursor) = text_helpers::delete_word_before(text_content, &cursor) {
                self.selection.set_caret(new_cursor);
            }
        } else {
            let cursor = self.selection.focus;
            if let Some(new_cursor) = text_helpers::delete_char_before(text_content, &cursor) {
                self.selection.set_caret(new_cursor);
            }
        }

        text_content.layout.paragraphs.clear();
        text_content.layout.paragraph_builders.clear();

        self.reset_blink();
        self.push_event(TextEditorEvent::ContentChanged);
        self.push_event(TextEditorEvent::NeedsLayout);
    }

    pub fn delete_forward(&mut self, text_content: &mut TextContent, word_boundary: bool) {
        if self.selection.is_selection() {
            text_helpers::delete_selection_range(text_content, &self.selection);
            let start = self.selection.start();
            let clamped = text_helpers::clamp_cursor(start, text_content.paragraphs());
            self.selection.set_caret(clamped);
        } else if word_boundary {
            let cursor = self.selection.focus;
            text_helpers::delete_word_after(text_content, &cursor);
            let clamped = text_helpers::clamp_cursor(cursor, text_content.paragraphs());
            self.selection.set_caret(clamped);
        } else {
            let cursor = self.selection.focus;
            text_helpers::delete_char_after(text_content, &cursor);
            let clamped = text_helpers::clamp_cursor(cursor, text_content.paragraphs());
            self.selection.set_caret(clamped);
        }

        text_content.layout.paragraphs.clear();
        text_content.layout.paragraph_builders.clear();

        self.reset_blink();
        self.push_event(TextEditorEvent::ContentChanged);
        self.push_event(TextEditorEvent::NeedsLayout);
    }

    pub fn insert_paragraph(&mut self, text_content: &mut TextContent) {
        if self.selection.is_selection() {
            text_helpers::delete_selection_range(text_content, &self.selection);
            let start = self.selection.start();
            self.selection.set_caret(start);
        }

        let cursor = self.selection.focus;
        if text_helpers::split_paragraph_at_cursor(text_content, &cursor) {
            let new_cursor =
                TextPositionWithAffinity::new_without_affinity(cursor.paragraph + 1, 0);
            self.selection.set_caret(new_cursor);
        }

        text_content.layout.paragraphs.clear();
        text_content.layout.paragraph_builders.clear();

        self.reset_blink();
        self.push_event(TextEditorEvent::ContentChanged);
        self.push_event(TextEditorEvent::NeedsLayout);
    }

    pub fn move_cursor(
        &mut self,
        text_content: &TextContent,
        direction: CursorDirection,
        word_boundary: bool,
        extend_selection: bool,
    ) -> bool {
        let paragraphs = text_content.paragraphs();
        if paragraphs.is_empty() {
            return false;
        }

        let focus = self.selection.focus;

        // Get the text direction of the span at the current cursor position
        let text_span_text_direction = if focus.paragraph < paragraphs.len() {
            text_helpers::get_text_span_text_direction_at_offset(
                &paragraphs[focus.paragraph],
                focus.offset,
            )
        } else {
            TextDirection::LTR
        };

        // For horizontal navigation, swap Backward/Forward when in RTL text
        let adjusted_direction = if text_span_text_direction == TextDirection::RTL {
            match direction {
                CursorDirection::Backward => CursorDirection::Forward,
                CursorDirection::Forward => CursorDirection::Backward,
                other => other,
            }
        } else {
            direction
        };

        let new_cursor = match adjusted_direction {
            CursorDirection::Backward => {
                text_helpers::move_cursor_backward(&focus, paragraphs, word_boundary)
            }
            CursorDirection::Forward => {
                text_helpers::move_cursor_forward(&focus, paragraphs, word_boundary)
            }
            CursorDirection::LineBefore => {
                text_helpers::move_cursor_up(&focus, paragraphs, text_content)
            }
            CursorDirection::LineAfter => {
                text_helpers::move_cursor_down(&focus, paragraphs, text_content)
            }
            CursorDirection::LineStart => text_helpers::move_cursor_line_start(&focus, paragraphs),
            CursorDirection::LineEnd => text_helpers::move_cursor_line_end(&focus, paragraphs),
        };

        if extend_selection {
            self.selection.extend_to(new_cursor);
        } else {
            self.selection.set_caret(new_cursor);
        }

        self.update_styles(text_content);

        self.reset_blink();
        self.push_event(TextEditorEvent::SelectionChanged);
        true
    }

    /// Apply a style patch to the current selection — or, when the selection is
    /// collapsed/absent, to ALL content (the panel's "no selection ⇒ whole shape"
    /// rule). Splits spans at the selection boundaries, mutates the shape's
    /// TextContent in place, then invalidates layout and refreshes the style
    /// buffer so the panel reflects the result.
    pub fn apply_styles(&mut self, text_content: &mut TextContent, patch: &StylePatch) {
        let paragraph_count = text_content.paragraphs().len();
        if paragraph_count == 0 {
            return;
        }

        if self.selection.is_selection() {
            let start = self.selection.start();
            let end = self.selection.end();
            let end_paragraph = end.paragraph.min(paragraph_count - 1);
            for para_idx in start.paragraph..=end_paragraph {
                let Some(para) = text_content.paragraphs_mut().get_mut(para_idx) else {
                    continue;
                };
                let para_char_count: usize = para
                    .children()
                    .iter()
                    .map(|span| span.text.chars().count())
                    .sum();
                let range_start = if para_idx == start.paragraph {
                    start.offset.min(para_char_count)
                } else {
                    0
                };
                let range_end = if para_idx == end.paragraph {
                    end.offset.min(para_char_count)
                } else {
                    para_char_count
                };
                apply_styles_to_range_in_paragraph(para, range_start, range_end, patch);
            }
        } else {
            for para in text_content.paragraphs_mut().iter_mut() {
                let para_char_count: usize = para
                    .children()
                    .iter()
                    .map(|span| span.text.chars().count())
                    .sum();
                apply_styles_to_range_in_paragraph(para, 0, para_char_count, patch);
            }
        }

        text_content.layout.paragraphs.clear();
        text_content.layout.paragraph_builders.clear();

        self.reset_blink();
        self.push_event(TextEditorEvent::ContentChanged);
        self.push_event(TextEditorEvent::NeedsLayout);
        self.update_styles(text_content);
    }
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// A set of style attributes to apply to a span range. Only `Some` fields are
/// written, so toggling one control doesn't clobber the others. Decoded from the
/// little-endian patch buffer the TS `textEditorApplyStyles` writes.
#[derive(Debug, Clone, Default)]
pub struct StylePatch {
    pub font_family_id: Option<Uuid>,
    pub font_weight: Option<i32>,
    pub font_style: Option<FontStyle>,
    pub font_size: Option<f32>,
    pub line_height: Option<f32>,
    pub letter_spacing: Option<f32>,
    /// Outer = present; inner = the decoration (`None` ⇒ "no decoration").
    pub text_decoration: Option<Option<TextDecoration>>,
    pub text_transform: Option<Option<TextTransform>>,
    pub text_direction: Option<TextDirection>,
    pub text_align: Option<TextAlign>,
    pub fills: Option<Vec<Fill>>,
}

impl StylePatch {
    /// Decode the patch buffer (all little-endian):
    ///   0  u32 presence · 4 u8 decoration · 5 u8 transform · 6 u8 direction
    ///   7  u8 align · 8 u8 font_style · 9..=11 pad · 12 f32 font_size
    ///   16 i32 font_weight · 20 f32 line_height · 24 f32 letter_spacing
    ///   28..=43 font-family UUID (4×u32) · 44 u32 fill_count
    ///   48.. fill_count × u32 ARGB (solid only).
    /// Presence bits: 0 family, 1 weight, 2 style, 3 size, 4 line_height,
    /// 5 letter_spacing, 6 decoration, 7 transform, 8 direction, 9 align, 10 fills.
    pub fn decode(bytes: &[u8]) -> Option<StylePatch> {
        if bytes.len() < 48 {
            return None;
        }
        let u32_at =
            |o: usize| u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
        let i32_at =
            |o: usize| i32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
        let f32_at =
            |o: usize| f32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);

        let presence = u32_at(0);
        let has = |bit: u32| presence & (1u32 << bit) != 0;

        let font_family_id = if has(0) {
            Some(uuid_from_u32_quartet(
                u32_at(28),
                u32_at(32),
                u32_at(36),
                u32_at(40),
            ))
        } else {
            None
        };
        let font_weight = if has(1) { Some(i32_at(16)) } else { None };
        let font_style = if has(2) {
            Some(match bytes[8] {
                1 => FontStyle::Italic,
                _ => FontStyle::Normal,
            })
        } else {
            None
        };
        let font_size = if has(3) { Some(f32_at(12)) } else { None };
        let line_height = if has(4) { Some(f32_at(20)) } else { None };
        let letter_spacing = if has(5) { Some(f32_at(24)) } else { None };
        let text_decoration = if has(6) {
            Some(match bytes[4] {
                1 => Some(TextDecoration::UNDERLINE),
                2 => Some(TextDecoration::LINE_THROUGH),
                3 => Some(TextDecoration::OVERLINE),
                _ => None,
            })
        } else {
            None
        };
        let text_transform = if has(7) {
            Some(match bytes[5] {
                1 => Some(TextTransform::Uppercase),
                2 => Some(TextTransform::Lowercase),
                3 => Some(TextTransform::Capitalize),
                _ => None,
            })
        } else {
            None
        };
        let text_direction = if has(8) {
            Some(match bytes[6] {
                1 => TextDirection::RTL,
                _ => TextDirection::LTR,
            })
        } else {
            None
        };
        let text_align = if has(9) {
            Some(match bytes[7] {
                1 => TextAlign::Center,
                2 => TextAlign::Right,
                3 => TextAlign::Justify,
                _ => TextAlign::Left,
            })
        } else {
            None
        };
        let fills = if has(10) {
            let count = u32_at(44) as usize;
            if bytes.len() < 48 + count * 4 {
                return None;
            }
            let mut list = Vec::with_capacity(count);
            for i in 0..count {
                let argb = u32_at(48 + i * 4);
                let a = ((argb >> 24) & 0xff) as u8;
                let r = ((argb >> 16) & 0xff) as u8;
                let g = ((argb >> 8) & 0xff) as u8;
                let b = (argb & 0xff) as u8;
                list.push(Fill::Solid(SolidColor(Color::from_argb(a, r, g, b))));
            }
            Some(list)
        } else {
            None
        };

        Some(StylePatch {
            font_family_id,
            font_weight,
            font_style,
            font_size,
            line_height,
            letter_spacing,
            text_decoration,
            text_transform,
            text_direction,
            text_align,
            fills,
        })
    }

    /// Write the present fields onto a span. Font face (family/weight/style) is
    /// recombined into one `FontFamily`, mirroring how the serializer stores
    /// weight/style on the family (and weight also on the span).
    fn apply_to_span(&self, span: &mut TextSpan) {
        let mut family_id = span.font_family.id();
        let mut family_weight = span.font_family.weight();
        let mut family_style = span.font_family.style();
        let mut face_changed = false;
        if let Some(id) = self.font_family_id {
            family_id = id;
            face_changed = true;
        }
        if let Some(weight) = self.font_weight {
            family_weight = weight as u32;
            span.font_weight = weight;
            face_changed = true;
        }
        if let Some(style) = self.font_style {
            family_style = style;
            face_changed = true;
        }
        if face_changed {
            span.font_family = FontFamily::new(family_id, family_weight, family_style);
        }
        if let Some(size) = self.font_size {
            span.font_size = size;
        }
        if let Some(line_height) = self.line_height {
            span.line_height = line_height;
        }
        if let Some(letter_spacing) = self.letter_spacing {
            span.letter_spacing = letter_spacing;
        }
        if let Some(decoration) = self.text_decoration {
            span.text_decoration = decoration;
        }
        if let Some(transform) = self.text_transform {
            span.text_transform = transform;
        }
        if let Some(direction) = self.text_direction {
            span.text_direction = direction;
        }
        if let Some(ref fills) = self.fills {
            span.fills = fills.clone();
        }
    }
}

/// Ensure a span boundary exists at `char_offset`, so the characters before and
/// after it live in separate spans. No-op when the offset already falls on a
/// boundary or past the paragraph's end.
fn split_span_at(para: &mut Paragraph, char_offset: usize) {
    let mut accumulated = 0usize;
    let children = para.children_mut();
    for idx in 0..children.len() {
        let span_len = children[idx].text.chars().count();
        let span_start = accumulated;
        let span_end = accumulated + span_len;
        if char_offset <= span_start {
            return; // already on a boundary
        }
        if char_offset < span_end {
            let split_at = char_offset - span_start;
            let chars: Vec<char> = children[idx].text.chars().collect();
            let left: String = chars[..split_at].iter().collect();
            let right: String = chars[split_at..].iter().collect();
            let mut right_span = children[idx].clone();
            children[idx].set_text(left);
            right_span.set_text(right);
            children.insert(idx + 1, right_span);
            return;
        }
        accumulated = span_end;
    }
}

/// Split the paragraph at `start`/`end`, then apply `patch` to every span fully
/// inside `[start, end)`. Paragraph alignment (when present) applies to the whole
/// paragraph regardless of the character range.
fn apply_styles_to_range_in_paragraph(
    para: &mut Paragraph,
    start: usize,
    end: usize,
    patch: &StylePatch,
) {
    if start < end {
        split_span_at(para, start);
        split_span_at(para, end);

        let mut accumulated = 0usize;
        for span in para.children_mut().iter_mut() {
            let span_len = span.text.chars().count();
            let span_start = accumulated;
            let span_end = accumulated + span_len;
            accumulated = span_end;
            if span_len > 0 && span_start >= start && span_end <= end {
                patch.apply_to_span(span);
            }
        }
    }

    if let Some(align) = patch.text_align {
        para.set_text_align(align);
    }
}
