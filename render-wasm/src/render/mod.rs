//! Renderer module root.
//!
//! Cfg-routes the orchestrator: V1 (legacy traversal) when
//! `tile-scheduler` is off, V2 (scheduler-native) when on. Submodules
//! below are shared draw helpers — pure per-aspect functions, no
//! traversal state — so both orchestrators call into the same code.
//!
//! See `docs/render-v1-v2-split.md` for the migration plan.

#[cfg(not(feature = "tile-scheduler"))]
mod v1;
#[cfg(not(feature = "tile-scheduler"))]
pub use v1::*;

#[cfg(feature = "tile-scheduler")]
mod v2;
#[cfg(feature = "tile-scheduler")]
pub use v2::*;

// Bridge re-exports so submodules' `super::Foo` / `super::tiles::*`
// paths keep resolving when the orchestrator body lives in `v1.rs` /
// `v2.rs` rather than directly in this file.
pub(crate) use crate::shapes::Shape;
pub(crate) use crate::state::ShapesPoolRef;
pub(crate) use crate::tiles;

pub(crate) mod debug;
mod fills;
pub mod filters;
mod fonts;
#[cfg(feature = "tile-scheduler")]
pub(crate) mod gather;
pub(crate) mod glass;
#[cfg(feature = "tile-scheduler")]
pub(crate) mod local;
mod gpu_state;
pub mod grid_layout;
mod images;
mod noise;
mod options;
mod shadows;
mod strokes;
mod surfaces;
pub mod text;
pub mod text_editor;
pub(crate) mod texture;
pub(crate) mod ui;
