//! Renderer module root.
//!
//! Orchestrator lives in `v2.rs` — the legacy `v1.rs` traversal was
//! deleted along with the `tile-scheduler` feature gate (Phase A of
//! the legacy-deletion plan). Submodules below are shared draw helpers
//! — pure per-aspect functions, no traversal state.

mod v2;
pub use v2::*;

// Bridge re-exports so submodules' `super::Foo` / `super::tiles::*`
// paths keep resolving when the orchestrator body lives in `v2.rs`
// rather than directly in this file.
pub(crate) use crate::shapes::Shape;
pub(crate) use crate::state::ShapesPoolRef;
pub(crate) use crate::tiles;

pub(crate) mod debug;
mod fills;
pub mod filters;
pub(crate) mod fonts;
pub(crate) mod glass;
pub(crate) mod local;
pub(crate) mod gpu_state;
pub mod grid_layout;
pub(crate) mod images;
pub(crate) use images::{get_dest_rect, get_source_rect};
pub(crate) mod noise;
pub(crate) mod options;
mod shadows;
mod strokes;
pub(crate) mod surfaces;
pub mod text;
pub mod text_editor;
pub(crate) mod texture;
pub(crate) mod ui;

// SSA-native renderers — explicit per-call context.
pub(crate) mod ssa;
