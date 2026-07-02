//! SSA-native renderers.
//!
//! Per-effect rendering code re-implemented to take an explicit
//! `PaintCtx` instead of `&mut RenderState + SurfaceId`. Designed for
//! the SSA scheduler (`tile_grid::ssa`) which carries the per-step
//! tile context (`world_origin`, `clip_rect`, `tile`) directly on
//! each `Step::Paint`.
//!
//! ## Why a parallel module instead of an in-place refactor
//!
//! - The legacy renderers (`render::fills`, `render::strokes`, ...) stay
//!   untouched and known-working throughout the cutover.
//! - Deletion at cutover-end is `git rm` on the legacy files — no
//!   surgical extraction of bug-fix history baked into individual lines.
//! - Each renderer can be ported and pixel-diff-verified independently;
//!   parity is bisectable.
//!
//! See `docs/ssa-surface-ir-plan.md` and the conversation log for the
//! design rationale.
//!
//! ## Module layout
//!
//! - `ctx`         — `PaintCtx` (explicit per-call context type)
//! - `fills`       — `pub fn render(ctx, shape, fills, antialias, outset)`
//! - `strokes`     — `pub fn render(ctx, shape, strokes, antialias, outset)`
//! - `shadows`     — fill/stroke/text inner shadow paths
//! - `shape_body`  — composition: fills + strokes + inner shadows
//! - `dispatch`    — routes `EffectKey` to the right renderer
//!
//! Components arriving as the port progresses (`text`, `svg`, `scatter`,
//! `local`, `gather`, `glass`) get added under this module without
//! disturbing what's here.

pub mod ctx;
pub mod dispatch;
pub mod filter;
pub mod fills;
pub mod gather;
pub mod glass;
pub mod local;
pub mod mask;
pub mod material;
pub mod noise;
pub mod shadows;
pub mod scatter;
pub mod shape_body;
pub mod strokes;
pub mod svg;
pub mod text;

pub use ctx::PaintCtx;
pub use dispatch::dispatch_effect;
