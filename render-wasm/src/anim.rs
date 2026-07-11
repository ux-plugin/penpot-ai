//! Thin FFI shell over `anim_runtime::session::Session` — the portable animation
//! runtime (a Rust port of skia-rs-wasm's `anim/` IR). All logic lives in the
//! crate; this only moves bytes across the wasm boundary.
//!
//! The output buffer is pre-allocated once in `Session::load`, so `anim_eval`
//! never allocates and never grows wasm memory. That keeps a JS `HEAPF32` view
//! valid frame to frame (JS still re-reads `Module.HEAPF32` each frame, since an
//! unrelated allocation elsewhere can still grow memory and detach an old view).
//!
//! JS contract:
//!   ptr = _anim_alloc(len); HEAPU8.set(jsonBytes, ptr); _anim_load_doc();
//!   _anim_set_param(i, v);                        // when a parameter changes
//!   p = _anim_eval(time);                         // per frame → *const f32
//!   read nodeCount*6 floats at HEAPF32[p>>2] (node-major, NaN = no change).
//! JS derives the same node order the session uses (first appearance across the
//! doc's bindings), so no id table needs to cross the boundary.

use crate::mem;
use anim_runtime::session::Session;

static mut ANIM: Option<Session> = None;

/// Allocate a scratch buffer of `len` bytes for JS to write the document JSON into.
#[no_mangle]
pub extern "C" fn anim_alloc(len: usize) -> *mut u8 {
    mem::write_bytes(vec![0u8; len])
}

/// Parse the document JSON previously written into the scratch buffer, and
/// pre-allocate the frame buffer. A malformed doc clears the session.
#[no_mangle]
pub extern "C" fn anim_load_doc() {
    let json = String::from_utf8(mem::bytes()).unwrap_or_default();
    let session = Session::load(&json).ok();
    unsafe {
        ANIM = session;
    }
}

/// Update a live parameter by its index (event-driven; not called per frame).
#[no_mangle]
pub extern "C" fn anim_set_param(index: u32, value: f64) {
    unsafe {
        #[allow(static_mut_refs)]
        if let Some(session) = ANIM.as_mut() {
            session.set_param(index as usize, value);
        }
    }
}

/// Evaluate at `time` (+ current params). Returns a pointer to the frame buffer
/// (node-major, 6 floats/node, `NaN` = no change), or null if no doc is loaded.
/// Valid until the next call — JS reads it immediately.
#[no_mangle]
pub extern "C" fn anim_eval(time: f64) -> *const f32 {
    unsafe {
        #[allow(static_mut_refs)]
        match ANIM.as_mut() {
            Some(session) => session.eval(time).as_ptr(),
            None => std::ptr::null(),
        }
    }
}
