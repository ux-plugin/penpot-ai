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

#[cfg(target_arch = "wasm32")]
mod renderer;
#[cfg(target_arch = "wasm32")]
mod scene;

#[cfg(target_arch = "wasm32")]
pub use renderer::{FocusRenderer, create_focus_renderer};
