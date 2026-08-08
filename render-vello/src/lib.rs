//! The Vello rendering backend — a peer to render-wasm, not an add-on (D3). The host loads
//! exactly one of the two (D2).
//!
//! The crate splits along a target line:
//!
//! - [`abi`] is **target-agnostic**: the C-style entry points the host drives, and the decoding
//!   from the shared wire format into `render_core::model`. Pure Rust, no web or GPU
//!   dependencies, so it compiles and unit-tests on the host. That matters — this is where
//!   wire bugs would otherwise hide until they showed up as wrong pixels in a browser.
//! - `renderer` and `scene` are **wasm-only**, because they pull in wgpu, web-sys and
//!   wasm-bindgen. They carry `FocusRenderer`, the host-driven surface from Phase 0.
//!
//! Before this split the whole crate sat behind `#![cfg(target_arch = "wasm32")]`, which would
//! have made every ABI test dead code.

#![allow(
    clippy::cast_possible_truncation,
    reason = "truncation has no appreciable impact in this Phase-0 proof"
)]

pub mod abi;
pub mod editor;
pub mod rich_editor;

// The device-generic wgpu effect executor + profiler now live in render-vello-core; re-export their
// modules under the same crate paths (`crate::blend` / `glass` / `graph` / `prof`) the sink uses, so
// the carve is transparent to the rest of this crate. Gating mirrors the originals: the executor was
// wasm-only (it's driven by the sink); the profiler is all-target.
pub(crate) use render_vello_core::prof;
#[cfg(target_arch = "wasm32")]
pub(crate) use render_vello_core::{blend, glass, graph};

#[cfg(target_arch = "wasm32")]
mod renderer;
#[cfg(target_arch = "wasm32")]
mod scene;
#[cfg(target_arch = "wasm32")]
mod sink;
#[cfg(target_arch = "wasm32")]
mod tiles;

#[cfg(target_arch = "wasm32")]
pub use renderer::{FocusRenderer, create_focus_renderer};

/// Whether the host asked for a frame since this was last called, clearing the request.
///
/// The C-ABI `render()` records a request rather than drawing: Phase 0 deliberately left the
/// frame loop with the host (D3), and render-wasm's own `render()` schedules rather than draws.
/// A host driving this module through the facade polls this from its `requestAnimationFrame`
/// and calls `FocusRenderer::render()` when it returns true.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn frame_requested() -> bool {
    abi::take_needs_frame()
}
