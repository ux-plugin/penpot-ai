//! Text editing — the caret, selection and (later) input for a focused text shape.
//!
//! Unlike everything else render-vello draws, the editor is **not** part of the neutral document
//! model or its digest: it is ephemeral interaction state (which shape is being edited, where the
//! caret sits, what is selected). render-wasm hand-builds all of this on top of Skia's read-only
//! paragraph API (~2800 lines); render-vello instead drives [`crate::vello::rich_editor::RichEditor`],
//! which reuses Parley's `Selection`/`Cursor` (cursor movement, bidi-aware hit-testing, selection
//! geometry, IME) over a **multi-style** layout, so per-span styles survive editing.
//!
//! **Why a command queue.** The editor needs a `FontContext` to lay text out, and that context
//! lives on the scene's `TextEngine`, which only the render pass touches (D3: the host owns the
//! frame loop; the renderer owns the GPU and the fonts). The `text_editor_*` ABI runs *outside* that
//! pass. So the ABI here only records intent — a focused id, theme colours, a queue of edit
//! commands — and reads back state the render pass cached. The render pass (the backend render pass) drains
//! the queue against the live `RichEditor`, then draws the caret and selection inline. The host
//! drives both backends through the *same* `text_editor_*` names (D17), so its editor code is
//! unchanged.
//!
//! Focus/blur, pointer hit-testing and drag-select, select-all/word, typing, delete, caret motion
//! and IME are all live. The one gap is *export of styles*: `export_content` still emits plain text
//! (the span model is preserved across edits, but serialising it back through render-wasm's export
//! JSON is host-coupled — a separate slice).

use crate::model::ShapeKind;

/// One queued edit, applied by the render pass against the live `PlainEditor`. Coordinates are in
/// the shape's own space (the host transforms screen → shape before calling, exactly as it does for
/// render-wasm's `get_caret_position_from_shape_coords`).
#[derive(Clone, Debug, PartialEq)]
pub enum EditorCommand {
    /// Place the caret at a point (pointer down).
    PointerDown(f32, f32),
    /// Extend the selection to a point (pointer drag / up).
    ExtendToPoint(f32, f32),
    /// Select the word under a point (double-click).
    SelectWord(f32, f32),
    /// Select the whole text.
    SelectAll,
    /// Insert text at the caret, replacing any selection.
    Insert(String),
    /// Insert a newline (paragraph break).
    InsertParagraph,
    /// Delete before the caret (backspace); `true` deletes a whole word.
    DeleteBackward(bool),
    /// Delete after the caret (delete key); `true` deletes a whole word.
    DeleteForward(bool),
    /// Move the caret. `direction` is render-wasm's `CursorDirection`
    /// (0 Backward, 1 Forward, 2 LineBefore, 3 LineAfter, 4 LineStart, 5 LineEnd); `word` moves by
    /// word; `extend` grows the selection instead of collapsing it.
    Move {
        direction: u32,
        word: bool,
        extend: bool,
    },
    /// Set the IME pre-edit (composing) text at the caret.
    SetCompose(String),
    /// Commit the IME composition: drop the pre-edit, then insert the final text (empty cancels).
    CommitCompose(String),
}

pub struct EditorState {
    /// The shape being edited, if any.
    pub focused: Option<u128>,
    /// Selection highlight colour (ARGB), set by `text_editor_apply_theme`.
    pub selection_color: u32,
    /// Caret colour (ARGB).
    pub cursor_color: u32,
    /// Edits recorded since the last render pass drained them.
    pub commands: Vec<EditorCommand>,
    /// True between pointer-down and pointer-up, so moves only extend an active drag.
    pub pointer_selecting: bool,
    /// Overtype (replace) mode, toggled by `text_editor_toggle_overtype_mode`.
    pub overtype: bool,
    /// Cached by the render pass (the only place the layout — hence the selection — exists).
    pub has_selection: bool,
    /// The editor's current text, cached each frame so `export_content` can read it without the
    /// `PlainEditor` (which lives on the render pass).
    pub text_cache: String,
    /// The selection's byte range `[start, end)` in `text_cache`, cached likewise.
    pub selection: (usize, usize),
    /// The caret rectangle in shape-local space `[left, top, width, height]`, cached each frame so
    /// `get_cursor_rect` (used for IME candidate placement) can serve it without the `PlainEditor`.
    pub caret_rect: Option<[f32; 4]>,
    /// The live editor layout's `[width, height]`, cached each frame so `get_text_dimensions` can
    /// serve the *edited* size (auto-grow reads it every keystroke) without the render-pass layout.
    pub layout_size: Option<[f32; 2]>,
    /// Caret visibility from the host's blink clock; the render pass draws the caret only when set.
    pub blink_on: bool,
    /// A redraw is needed (focus/selection/blink changed). Polled and cleared by `poll_event`.
    pub dirty: bool,
}

/// Keeps the last string result (e.g. `export_content` JSON) alive for the host to read.
static RESULT_STR: std::sync::Mutex<Vec<u8>> = std::sync::Mutex::new(Vec::new());

static EDITOR: std::sync::Mutex<EditorState> = std::sync::Mutex::new(EditorState {
    focused: None,
    selection_color: 0x6633_99ff,
    cursor_color: 0xff00_0000,
    commands: Vec::new(),
    pointer_selecting: false,
    overtype: false,
    has_selection: false,
    text_cache: String::new(),
    selection: (0, 0),
    caret_rect: None,
    layout_size: None,
    blink_on: true,
    dirty: false,
});

fn with_editor<R>(f: impl FnOnce(&mut EditorState) -> R) -> R {
    f(&mut EDITOR.lock().expect("editor state poisoned"))
}

/// The render pass takes the focused id and the pending commands to apply this frame.
pub fn take_focus_and_commands() -> (Option<u128>, Vec<EditorCommand>) {
    with_editor(|e| (e.focused, std::mem::take(&mut e.commands)))
}

/// The render pass reports back what it computed against the live editor: the current text, the
/// selection byte range, and whether that selection is non-empty. Cleared to empty when nothing is
/// focused.
pub fn set_snapshot(
    text: String,
    selection: (usize, usize),
    caret_rect: Option<[f32; 4]>,
    layout_size: Option<[f32; 2]>,
) {
    with_editor(|e| {
        e.has_selection = selection.0 != selection.1;
        e.text_cache = text;
        e.selection = selection;
        e.caret_rect = caret_rect;
        e.layout_size = layout_size;
    });
}

/// Clear the cached editor snapshot (no focused editor this frame).
pub fn clear_snapshot() {
    with_editor(|e| {
        e.has_selection = false;
        e.text_cache.clear();
        e.selection = (0, 0);
        e.caret_rect = None;
        e.layout_size = None;
    });
}

/// The live editor layout's `[width, height]` cached by the render pass, if `id` is the focused
/// shape — so `get_text_dimensions` measures what the user is typing, not the stale committed
/// content. None when unfocused or before the first frame laid the editor out.
pub fn focused_layout_size(id: u128) -> Option<[f32; 2]> {
    with_editor(|e| if e.focused == Some(id) { e.layout_size } else { None })
}

/// Whether overtype (replace) mode is on — read by the render pass when applying an insert.
pub fn overtype() -> bool {
    with_editor(|e| e.overtype)
}

/// The caret colour the render pass should paint with (ARGB).
pub fn cursor_color() -> u32 {
    with_editor(|e| e.cursor_color)
}

/// The selection colour the render pass should paint with (ARGB).
pub fn selection_color() -> u32 {
    with_editor(|e| e.selection_color)
}

/// Whether the caret is currently in its visible blink phase.
pub fn blink_on() -> bool {
    with_editor(|e| e.blink_on)
}


#[unsafe(no_mangle)]
pub extern "C" fn text_editor_apply_theme(selection_color: u32, cursor_color: u32) {
    with_editor(|e| {
        e.selection_color = selection_color;
        e.cursor_color = cursor_color;
        e.dirty = true;
    });
    crate::vello::abi::request_frame();
}

/// Begin editing a text shape. Fails (returns false) if the id is not a text shape in the scene —
/// the host retries next frame, since a just-created box may not have synced yet.
#[unsafe(no_mangle)]
pub extern "C" fn text_editor_focus(a: u32, b: u32, c: u32, d: u32) -> bool {
    let id = crate::vello::abi::uuid_u128(a, b, c, d);
    let is_text = crate::vello::abi::with_scene(|scene, _, _| {
        scene
            .get(id)
            .is_some_and(|n| n.kind == ShapeKind::Text && n.text.is_some())
    });
    if !is_text {
        return false;
    }
    with_editor(|e| {
        e.focused = Some(id);
        e.commands.clear();
        e.pointer_selecting = false;
        e.has_selection = false;
        e.blink_on = true;
        e.dirty = true;
    });
    crate::vello::abi::request_frame();
    true
}

#[unsafe(no_mangle)]
pub extern "C" fn text_editor_blur() -> bool {
    let had = with_editor(|e| {
        let had = e.focused.is_some();
        e.focused = None;
        e.commands.clear();
        e.pointer_selecting = false;
        e.has_selection = false;
        e.dirty = true;
        had
    });
    crate::vello::abi::request_frame();
    had
}

/// Same as blur for render-vello: the `PlainEditor` is dropped when focus clears, so there is no
/// separate resource to dispose.
#[unsafe(no_mangle)]
pub extern "C" fn text_editor_dispose() -> bool {
    text_editor_blur()
}

#[unsafe(no_mangle)]
pub extern "C" fn text_editor_has_focus() -> bool {
    with_editor(|e| e.focused.is_some())
}

#[unsafe(no_mangle)]
pub extern "C" fn text_editor_has_focus_with_id(a: u32, b: u32, c: u32, d: u32) -> bool {
    let id = crate::vello::abi::uuid_u128(a, b, c, d);
    with_editor(|e| e.focused == Some(id))
}

#[unsafe(no_mangle)]
pub extern "C" fn text_editor_has_selection() -> bool {
    with_editor(|e| e.has_selection)
}

/// Write the focused shape's id as the wire's `(a, b, c, d)` quartet to `buffer_ptr`. Writes
/// nothing when unfocused (the host checks `has_focus` first).
///
/// # Safety
/// `buffer_ptr` must point to space for four `u32`s, as the host allocates.
#[unsafe(no_mangle)]
pub extern "C" fn text_editor_get_active_shape_id(buffer_ptr: *mut u32) {
    let Some(id) = with_editor(|e| e.focused) else {
        return;
    };
    let (a, b, c, d) = crate::vello::abi::uuid_to_quartet(id);
    unsafe {
        *buffer_ptr = a;
        *buffer_ptr.add(1) = b;
        *buffer_ptr.add(2) = c;
        *buffer_ptr.add(3) = d;
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn text_editor_pointer_down(x: f32, y: f32) {
    with_editor(|e| {
        if e.focused.is_none() {
            return;
        }
        e.pointer_selecting = true;
        e.commands.push(EditorCommand::PointerDown(x, y));
        e.dirty = true;
    });
    crate::vello::abi::request_frame();
}

#[unsafe(no_mangle)]
pub extern "C" fn text_editor_pointer_move(x: f32, y: f32) {
    with_editor(|e| {
        if e.focused.is_none() || !e.pointer_selecting {
            return;
        }
        e.commands.push(EditorCommand::ExtendToPoint(x, y));
        e.dirty = true;
    });
    crate::vello::abi::request_frame();
}

#[unsafe(no_mangle)]
pub extern "C" fn text_editor_pointer_up(x: f32, y: f32) {
    with_editor(|e| {
        if e.focused.is_none() || !e.pointer_selecting {
            return;
        }
        e.commands.push(EditorCommand::ExtendToPoint(x, y));
        e.pointer_selecting = false;
        e.dirty = true;
    });
    crate::vello::abi::request_frame();
}

#[unsafe(no_mangle)]
pub extern "C" fn text_editor_select_word_boundary(x: f32, y: f32) {
    with_editor(|e| {
        if e.focused.is_none() {
            return;
        }
        e.commands.push(EditorCommand::SelectWord(x, y));
        e.dirty = true;
    });
    crate::vello::abi::request_frame();
}

#[unsafe(no_mangle)]
pub extern "C" fn text_editor_select_all() -> bool {
    let ok = with_editor(|e| {
        if e.focused.is_none() {
            return false;
        }
        e.commands.push(EditorCommand::SelectAll);
        e.dirty = true;
        true
    });
    if ok {
        crate::vello::abi::request_frame();
    }
    ok
}

/// Advance the caret blink from the host's clock. render-wasm keeps the blink phase inside the
/// wasm; here the host owns the clock and this only records the current on/off phase.
#[unsafe(no_mangle)]
pub extern "C" fn text_editor_update_blink(timestamp_ms: f32) {
    let on = ((timestamp_ms / 530.0) as i64) % 2 == 0;
    with_editor(|e| {
        if e.blink_on != on {
            e.blink_on = on;
            e.dirty = true;
        }
    });
    crate::vello::abi::request_frame();
}

/// The caret and selection are drawn *inline* by the render pass when the focused text node is
/// painted, so there is no separate overlay to render — this only nudges a frame.
#[unsafe(no_mangle)]
pub extern "C" fn text_editor_render_overlay() {
    crate::vello::abi::request_frame();
}

/// Return whether a redraw is pending, clearing the flag. The host polls this to decide whether to
/// request another frame for the editor.
#[unsafe(no_mangle)]
pub extern "C" fn text_editor_poll_event() -> u8 {
    with_editor(|e| {
        let dirty = e.dirty;
        e.dirty = false;
        u8::from(dirty)
    })
}


/// Queue a command if a shape is focused, and nudge a frame.
fn enqueue(command: EditorCommand) {
    let queued = with_editor(|e| {
        if e.focused.is_none() {
            return false;
        }
        e.commands.push(command);
        e.dirty = true;
        true
    });
    if queued {
        crate::vello::abi::request_frame();
    }
}

/// Insert the uploaded UTF-8 bytes at the caret (replacing any selection). Mirrors render-wasm's
/// `insert_text`, which reads the same shared byte buffer.
#[unsafe(no_mangle)]
pub extern "C" fn text_editor_insert_text() {
    let bytes = crate::vello::abi::take_bytes();
    if let Ok(text) = String::from_utf8(bytes) {
        if !text.is_empty() {
            enqueue(EditorCommand::Insert(text));
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn text_editor_insert_paragraph() {
    enqueue(EditorCommand::InsertParagraph);
}

#[unsafe(no_mangle)]
pub extern "C" fn text_editor_delete_backward(word_boundary: bool) {
    enqueue(EditorCommand::DeleteBackward(word_boundary));
}

#[unsafe(no_mangle)]
pub extern "C" fn text_editor_delete_forward(word_boundary: bool) {
    enqueue(EditorCommand::DeleteForward(word_boundary));
}

#[unsafe(no_mangle)]
pub extern "C" fn text_editor_move_cursor(direction: u32, word_boundary: bool, extend_selection: bool) {
    enqueue(EditorCommand::Move {
        direction,
        word: word_boundary,
        extend: extend_selection,
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn text_editor_toggle_overtype_mode() {
    with_editor(|e| {
        e.overtype = !e.overtype;
        e.dirty = true;
    });
    crate::vello::abi::request_frame();
}


/// Split a flat byte offset in `text` into a `(paragraph, offset-in-paragraph)` pair, paragraphs
/// being the newline-separated lines — the shape render-wasm's selection uses.
fn byte_to_para_offset(text: &str, pos: usize) -> (u32, u32) {
    let pos = pos.min(text.len());
    let before = &text[..pos];
    let paragraph = before.matches('\n').count();
    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
    (paragraph as u32, (pos - line_start) as u32)
}

/// Escape a string as a JSON string body (without the surrounding quotes), matching render-wasm's
/// `export_content` escaping.
fn json_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

/// Export the edited text as render-wasm's `export_content` JSON: an array of paragraphs, each an
/// array of span strings. Each newline-separated paragraph is emitted as a single string here; the
/// `RichEditor` keeps per-span styles across edits, but serialising them back through render-wasm's
/// export schema (rich `export_styled`) is host-coupled and a later stage. Returns a pointer to a
/// null-terminated buffer kept alive in [`RESULT_STR`], or null when unfocused.
#[unsafe(no_mangle)]
pub extern "C" fn text_editor_export_content() -> *mut u8 {
    let json = with_editor(|e| {
        e.focused.map(|_| {
            let paragraphs: Vec<String> = e
                .text_cache
                .split('\n')
                .map(|line| format!("[\"{}\"]", json_escape(line)))
                .collect();
            format!("[{}]", paragraphs.join(","))
        })
    });
    let Some(json) = json else {
        return std::ptr::null_mut();
    };
    let mut bytes = json.into_bytes();
    bytes.push(0);
    let mut guard = RESULT_STR.lock().expect("result string poisoned");
    *guard = bytes;
    guard.as_mut_ptr()
}

/// Write the selection as render-wasm's `(anchorPara, anchorOffset, focusPara, focusOffset)`
/// quartet to `buffer_ptr`; returns false (writing nothing) when the selection is empty.
///
/// # Safety
/// `buffer_ptr` must point to space for four `u32`s.
#[unsafe(no_mangle)]
pub extern "C" fn text_editor_get_selection(buffer_ptr: *mut u32) -> bool {
    with_editor(|e| {
        let (start, end) = e.selection;
        if start == end {
            return false;
        }
        let (ap, ao) = byte_to_para_offset(&e.text_cache, start);
        let (fp, fo) = byte_to_para_offset(&e.text_cache, end);
        unsafe {
            *buffer_ptr = ap;
            *buffer_ptr.add(1) = ao;
            *buffer_ptr.add(2) = fp;
            *buffer_ptr.add(3) = fo;
        }
        true
    })
}


/// Begin an IME composition. PlainEditor starts composing on the first `set_compose`, so this only
/// nudges a frame; the caret stays where it is until pre-edit text arrives.
#[unsafe(no_mangle)]
pub extern "C" fn text_editor_composition_start() {
    crate::vello::abi::request_frame();
}

/// Update the IME pre-edit text (read from the shared byte buffer).
#[unsafe(no_mangle)]
pub extern "C" fn text_editor_composition_update() {
    let bytes = crate::vello::abi::take_bytes();
    if let Ok(text) = String::from_utf8(bytes) {
        enqueue(EditorCommand::SetCompose(text));
    }
}

/// End the IME composition, committing the final text (empty cancels the pre-edit).
#[unsafe(no_mangle)]
pub extern "C" fn text_editor_composition_end() {
    let bytes = crate::vello::abi::take_bytes();
    let text = String::from_utf8(bytes).unwrap_or_default();
    enqueue(EditorCommand::CommitCompose(text));
}

/// Return the caret rectangle as four little-endian `f32`s (`left, top, width, height`) in
/// shape-local space — the host uses it to place the IME candidate window. Null when there is no
/// visible caret. Kept alive in [`RESULT_STR`].
#[unsafe(no_mangle)]
pub extern "C" fn text_editor_get_cursor_rect() -> *mut u8 {
    let Some([l, t, w, h]) = with_editor(|e| e.caret_rect) else {
        return std::ptr::null_mut();
    };
    let mut bytes = Vec::with_capacity(16);
    for v in [l, t, w, h] {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    let mut guard = RESULT_STR.lock().expect("result string poisoned");
    *guard = bytes;
    guard.as_mut_ptr()
}
