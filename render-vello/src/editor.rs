//! Text editing — the caret, selection and (later) input for a focused text shape.
//!
//! Unlike everything else render-vello draws, the editor is **not** part of the neutral document
//! model or its digest: it is ephemeral interaction state (which shape is being edited, where the
//! caret sits, what is selected). render-wasm hand-builds all of this on top of Skia's read-only
//! paragraph API (~2800 lines); render-vello instead wraps Parley's [`parley::PlainEditor`], which
//! already does cursor movement, bidi-aware hit-testing, selection geometry and IME.
//!
//! **Why a command queue.** The `PlainEditor` needs a `FontContext` to lay text out, and that
//! context lives on the scene's `TextEngine`, which only the render pass touches (D3: the host owns
//! the frame loop; the renderer owns the GPU and the fonts). The `text_editor_*` ABI runs *outside*
//! that pass. So the ABI here only records intent — a focused id, theme colours, a queue of edit
//! commands — and reads back state the render pass cached. The render pass ([`crate::scene`])
//! drains the queue against a live `PlainEditor`, then draws the caret and selection inline. The
//! host drives both backends through the *same* `text_editor_*` names (D17), so its editor code is
//! unchanged.
//!
//! This is stage 1: focus/blur, pointer hit-testing and drag-select, select-all/word, and the
//! caret + selection *display*. Typing, the model write-back and IME arrive in later stages.

use render_core::model::ShapeKind;

/// One queued edit, applied by the render pass against the live `PlainEditor`. Coordinates are in
/// the shape's own space (the host transforms screen → shape before calling, exactly as it does for
/// render-wasm's `get_caret_position_from_shape_coords`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum EditorCommand {
    /// Place the caret at a point (pointer down).
    PointerDown(f32, f32),
    /// Extend the selection to a point (pointer drag / up).
    ExtendToPoint(f32, f32),
    /// Select the word under a point (double-click).
    SelectWord(f32, f32),
    /// Select the whole text.
    SelectAll,
}

pub(crate) struct EditorState {
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
    /// Cached by the render pass (the only place the layout — hence the selection — exists).
    pub has_selection: bool,
    /// Caret visibility from the host's blink clock; the render pass draws the caret only when set.
    pub blink_on: bool,
    /// A redraw is needed (focus/selection/blink changed). Polled and cleared by `poll_event`.
    pub dirty: bool,
}

static EDITOR: std::sync::Mutex<EditorState> = std::sync::Mutex::new(EditorState {
    focused: None,
    // A translucent blue selection and an opaque black caret, until the host sets its theme.
    selection_color: 0x6633_99ff,
    cursor_color: 0xff00_0000,
    commands: Vec::new(),
    pointer_selecting: false,
    has_selection: false,
    blink_on: true,
    dirty: false,
});

fn with_editor<R>(f: impl FnOnce(&mut EditorState) -> R) -> R {
    f(&mut EDITOR.lock().expect("editor state poisoned"))
}

/// The render pass takes the focused id and the pending commands to apply this frame.
pub(crate) fn take_focus_and_commands() -> (Option<u128>, Vec<EditorCommand>) {
    with_editor(|e| (e.focused, std::mem::take(&mut e.commands)))
}

/// The render pass reports back what it computed: whether there is a (non-empty) selection.
pub(crate) fn set_has_selection(has: bool) {
    with_editor(|e| e.has_selection = has);
}

/// The caret colour the render pass should paint with (ARGB).
pub(crate) fn cursor_color() -> u32 {
    with_editor(|e| e.cursor_color)
}

/// The selection colour the render pass should paint with (ARGB).
pub(crate) fn selection_color() -> u32 {
    with_editor(|e| e.selection_color)
}

/// Whether the caret is currently in its visible blink phase.
pub(crate) fn blink_on() -> bool {
    with_editor(|e| e.blink_on)
}

// --- ABI --------------------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub extern "C" fn text_editor_apply_theme(selection_color: u32, cursor_color: u32) {
    with_editor(|e| {
        e.selection_color = selection_color;
        e.cursor_color = cursor_color;
        e.dirty = true;
    });
    crate::abi::request_frame();
}

/// Begin editing a text shape. Fails (returns false) if the id is not a text shape in the scene —
/// the host retries next frame, since a just-created box may not have synced yet.
#[unsafe(no_mangle)]
pub extern "C" fn text_editor_focus(a: u32, b: u32, c: u32, d: u32) -> bool {
    let id = crate::abi::uuid_u128(a, b, c, d);
    let is_text = crate::abi::with_scene(|scene, _, _| {
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
    crate::abi::request_frame();
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
    crate::abi::request_frame();
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
    let id = crate::abi::uuid_u128(a, b, c, d);
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
    let (a, b, c, d) = crate::abi::uuid_to_quartet(id);
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
    crate::abi::request_frame();
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
    crate::abi::request_frame();
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
    crate::abi::request_frame();
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
    crate::abi::request_frame();
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
        crate::abi::request_frame();
    }
    ok
}

/// Advance the caret blink from the host's clock. render-wasm keeps the blink phase inside the
/// wasm; here the host owns the clock and this only records the current on/off phase.
#[unsafe(no_mangle)]
pub extern "C" fn text_editor_update_blink(timestamp_ms: f32) {
    // ~530ms half-period, the platform default. Even half-periods are the visible phase.
    let on = ((timestamp_ms / 530.0) as i64) % 2 == 0;
    with_editor(|e| {
        if e.blink_on != on {
            e.blink_on = on;
            e.dirty = true;
        }
    });
    crate::abi::request_frame();
}

/// The caret and selection are drawn *inline* by the render pass when the focused text node is
/// painted, so there is no separate overlay to render — this only nudges a frame.
#[unsafe(no_mangle)]
pub extern "C" fn text_editor_render_overlay() {
    crate::abi::request_frame();
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
