//! Wasm exports for the isolated shader-material preview (focus mode).
//!
//! **The JS side owns the GL context and MUST make the preview context current
//! before calling ANY of these, then restore the main context afterwards.**
//! Skia binds whatever context is current (`Interface::new_native()`), and
//! `preview_init` literally reads `GL_FRAMEBUFFER_BINDING` — call it with the
//! main context current and it would capture the main canvas's framebuffer and
//! corrupt both surfaces. See `focus-preview.ts`, which mirrors the
//! register/make-current dance already in `api/canvas.ts`.
//!
//! State lives in its own global, deliberately separate from `STATE` (the
//! document): the preview never reads a shape or walks the tree, so it cannot
//! disturb the document or its tiles.

use crate::mem;
use crate::render::preview::PreviewState;

use super::material::parse_material;

pub(crate) static mut PREVIEW: Option<Box<PreviewState>> = None;

/// Create the preview GPU state + surface for the currently-current GL context.
/// Returns `true` on success. Safe to call again after a context loss — the old
/// state is dropped first.
#[no_mangle]
pub extern "C" fn preview_init(width: i32, height: i32) -> bool {
    unsafe {
        PREVIEW = None;
    }
    match PreviewState::try_new(width, height) {
        Ok(state) => {
            unsafe {
                PREVIEW = Some(Box::new(state));
            }
            true
        }
        Err(_) => false,
    }
}

#[no_mangle]
pub extern "C" fn preview_resize(width: i32, height: i32) {
    unsafe {
        if let Some(state) = PREVIEW.as_mut() {
            let _ = state.resize(width, height);
        }
    }
}

/// Set the material to preview. Same LE byte layout as `set_shape_material`
/// (parsed by the shared `parse_material`), so the TS side serializes once.
#[no_mangle]
pub extern "C" fn preview_set_material() {
    let bytes = mem::bytes();
    let material = parse_material(&bytes);
    unsafe {
        if let Some(state) = PREVIEW.as_mut() {
            state.set_material(material);
        }
    }
    let _ = mem::free_bytes();
}

#[no_mangle]
pub extern "C" fn preview_clear_material() {
    unsafe {
        if let Some(state) = PREVIEW.as_mut() {
            state.set_material(None);
        }
    }
}

/// Draw the current material at `time` (seconds) into the preview surface.
#[no_mangle]
pub extern "C" fn preview_draw(time: f32) {
    unsafe {
        if let Some(state) = PREVIEW.as_mut() {
            state.draw(time);
        }
    }
}

/// Drop cached GPU resources but KEEP the context+surface alive — for when
/// focus mode closes. Reopening then skips the context rebuild and the
/// per-context shader program re-compile.
#[no_mangle]
pub extern "C" fn preview_purge() {
    unsafe {
        if let Some(state) = PREVIEW.as_mut() {
            state.purge();
        }
    }
}

/// Full teardown (app shutdown / context lost). `preview_init` can rebuild.
#[no_mangle]
pub extern "C" fn preview_destroy() {
    unsafe {
        PREVIEW = None;
    }
}
