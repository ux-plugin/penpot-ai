//! Transient hover chrome: a stroke traced over a shape's own outline.
//!
//! The editor used to draw this as an SVG overlay above the canvas, which meant
//! a second, approximate copy of the shape's geometry (axis-aligned box, no
//! corner radii) living in the DOM. Here the renderer draws it from the real
//! shape, so it follows radii and rotation for free and can never drift from
//! what is painted.
//!
//! It is chrome, not content: it lives on the UI surface, is never part of the
//! document, and is not exported. See `render::ui::render_highlight`.

use crate::{uuid_from_u32_quartet, with_state_mut, STATE};

/// Highlight `(a,b,c,d)` with `color` (ARGB, as produced by `uuidToU32Tuple`'s
/// sibling on the TS side). Replaces any previous highlight — only one at a time.
#[no_mangle]
pub extern "C" fn set_shape_highlight(a: u32, b: u32, c: u32, d: u32, color: u32) {
    with_state_mut!(state, {
        let id = uuid_from_u32_quartet(a, b, c, d);
        state.render_state.shape_highlight = Some((id, color));
    });
}

#[no_mangle]
pub extern "C" fn clear_shape_highlight() {
    with_state_mut!(state, {
        state.render_state.shape_highlight = None;
    });
}
