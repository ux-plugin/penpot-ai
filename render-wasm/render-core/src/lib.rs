// Backend-neutral core for the Penpot renderer.
//
// Phase 1 of the "Vello as a second render-wasm backend" plan (see
// render-wasm/docs/vello-backend-plan.md): extract the parts of render-wasm that do not
// depend on Skia into a crate that compiles for both `wasm32-unknown-emscripten` (the Skia
// module) and `wasm32-unknown-unknown` (a Vello/wasm-bindgen module).
//
// Increment 1 (this file's `geom` module) is the geometry foundation — the atoms that the
// rest of the model is built on (`Point`, `Vector`, `Rect`, `Matrix`) plus `Bounds` and the
// pure helpers. They mirror `skia::{Point, Vector, Rect, Matrix}` semantics and element
// layout exactly, so the migration in render-wasm is a type-swap behind a thin
// Skia<->core conversion boundary, not a behavior change.

#![forbid(unsafe_code)]

pub mod geom;
pub mod model;
