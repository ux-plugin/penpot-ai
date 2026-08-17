// Backend-neutral core for the Penpot renderer.
//
// Phase 1 of the "Vello as a second render-wasm backend" plan (see
// render-wasm/docs/vello-backend-plan.md): the parts of render-wasm that do not depend on
// Skia, in a crate that compiles for both `wasm32-unknown-emscripten` (the Skia module) and
// `wasm32-unknown-unknown` (a Vello/wasm-bindgen module).
//
// The geometry and paint atoms are NOT hand-written here (decision D12). They are kurbo and
// peniko, re-exported below: both are pure Rust, `no_std`-capable and target-agnostic, which
// was the only reason to hand-roll them in the first place. kurbo additionally ships stroke
// expansion, dashing, flattening and offsetting, which this crate would otherwise have had to
// grow itself. The versions are pinned to the vello fork's own, so the Vello module and
// render-wasm share one kurbo rather than linking two incompatible copies.
//
// Consequence worth knowing: kurbo is f64 where Skia is f32. Skia -> core is therefore
// lossless and core -> Skia rounds. The pipeline runs Skia -> core -> Vello, so the rounding
// direction is only exercised by the conversion helpers, not by the handoff.

// NOTE: `forbid(unsafe_code)` was dropped when the vello layer (formerly the `render-vello-core`
// crate) was folded in as `pub mod vello`: its `abi` module carries the shared `#[unsafe(no_mangle)]`
// FFI exports that both backend cdylibs re-export.

pub use kurbo;
pub use peniko;

pub mod abi;
pub mod atlas;
pub mod blend;
pub mod blur;
pub mod effect;
pub mod effect_graph;
pub mod footprint;
pub mod geometry;
pub mod gradient;
pub mod host;
pub mod model;
pub mod parity;
pub mod quadtree;
pub mod schedule;
pub mod selection;
pub mod text;
pub mod tile_cache;
pub mod tiling;

/// The backend-agnostic Vello layer (formerly the `render-vello-core` crate): the device-generic
/// wgpu effect executor — compositor/blit, glass pass-graph, blur, custom-WGSL pass runner — plus
/// the neutral drawer, the shared production sink, and the `#[unsafe(no_mangle)]` FFI shell both
/// backend cdylibs re-export. Nested here so it and the neutral core are one crate.
pub mod vello;
