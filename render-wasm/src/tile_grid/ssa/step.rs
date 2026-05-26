//! The flat IR step enum.
//!
//! Each step is self-contained: it carries its own tile context (via
//! `world_origin` / `clip_rect` baked into `Paint`/`Composite`) and an
//! explicit operand list (`read_from` / `write_to`). The dispatcher
//! resolves operands through the `SurfaceAllocator` and executes — no
//! global "current tile" state, no scope stack, no implicit cache lookups.
//!
//! Effect bodies are the legacy `EffectKey` / `LayerPaint` / `GatherFx`
//! enums imported directly from `tile_grid::mod`. They already encode
//! exactly the dispatch information the production sink needs to call
//! into `render::*`. Wrapping them in opaque newtypes would only add
//! indirection.

use skia_safe::{IRect, Point, Rect};

use crate::tiles::Tile;
use crate::uuid::Uuid;

// Re-exported from the legacy scheduler — these data types stay even
// after the legacy code paths around them get deleted, because they
// canonically describe "which renderer to call with what input."
pub use super::super::{EffectKey, GatherFx, LayerPaint};

use super::surface_ref::SurfaceRef;

/// Single step in the SSA schedule. Variants are coarse-grained — one
/// `Paint` step covers a shape's full body (fills + strokes + drop/inner/
/// text shadows) because no downstream consumer wants to read a single
/// pass. See plan §"Granularity rationale".
///
/// Operand discipline:
/// - `reads()` lists every `SurfaceRef` the step consumes
/// - `writes()` lists every `SurfaceRef` the step produces
/// - The validator uses these to enforce SSA invariants
#[derive(Debug, Clone)]
pub enum Step {
    /// Paint a shape's body (all its passes) into one or more logical
    /// surfaces. The per-pass scratches (`shape_fills`, `shape_strokes`,
    /// `drop_shadows`, `inner_shadows`, `text_drop_shadows`) stay as
    /// singletons inside the dispatcher — they're not visible as
    /// `SurfaceRef`s in the IR.
    Paint {
        shape: Uuid,
        effects: Vec<EffectKey>,
        /// World-space clip rect (was `SetTileBand`'s implicit clip).
        clip_rect: Rect,
        /// World-space tile origin (was `RenderState.render_area.origin`).
        world_origin: Point,
        /// Surfaces the paint writes into. Typically 1 (the parent scope)
        /// but `Paint` can fork into multiple writes for pre-population.
        write_to: Vec<SurfaceRef>,
    },

    /// Take an immutable snapshot of a surface's current pixel state in a
    /// sub-region. Produces a fresh `SurfaceRef`. Replaces today's
    /// inline `image_snapshot()` calls scattered through the scheduler.
    Snapshot {
        from: SurfaceRef,
        rect: IRect,
        write_to: SurfaceRef,
    },

    /// Fuse multiple snapshots (from a gather's 3×3 sample neighborhood)
    /// into a single backdrop surface. Replaces `build_gather_backdrop_scoped`.
    ComposeBackdrop {
        shape: Uuid,
        read_from: Vec<SurfaceRef>,
        /// World-space sample extent — the gather's
        /// `GatherKind::extent_world`. Backdrop dimensions derive from
        /// this.
        extent: Rect,
        write_to: SurfaceRef,
    },

    /// Run a gather effect (Glass or BackgroundBlur) reading from the
    /// `backdrop` produced by a preceding `ComposeBackdrop`. Writes into
    /// the destination surface — usually the gather's parent scope.
    PaintGather {
        shape: Uuid,
        backdrop: SurfaceRef,
        effects: Vec<GatherFx>,
        write_to: SurfaceRef,
    },

    /// Composite one surface into another with a paint (opacity, blend,
    /// clip). Replaces the implicit `Composite` work in `EndLayer`,
    /// `Exit`, and `FinalizeBand`. The `erase_after` field folds an
    /// `EraseSurface(from)` into the same step — common for short-lived
    /// intermediates like scope buffers and backdrops.
    Composite {
        from: SurfaceRef,
        to: SurfaceRef,
        paint: LayerPaint,
        rect: Rect,
        erase_after: bool,
    },

    /// Persist a tile's final pixels into the cross-frame tile texture
    /// cache. Replaces the implicit cache-write at `FinalizeBand`.
    WriteTileCache { from: SurfaceRef, tile: Tile },

    /// Explicit kill marker. Optional in the schedule — the liveness
    /// pass (Checkpoint C) derives implicit kills at last-use, and the
    /// validator treats either form as equivalent. Useful for debugging
    /// and for forcing an early surface release in pathological cases.
    EraseSurface(SurfaceRef),
}

impl Step {
    /// All `SurfaceRef`s this step reads from. Empty for steps that only
    /// produce (`Paint` — its inputs are shape data, not surfaces).
    pub fn reads(&self) -> Vec<SurfaceRef> {
        match self {
            Step::Paint { .. } => Vec::new(),
            Step::Snapshot { from, .. } => vec![*from],
            Step::ComposeBackdrop { read_from, .. } => read_from.clone(),
            Step::PaintGather { backdrop, .. } => vec![*backdrop],
            Step::Composite { from, .. } => vec![*from],
            Step::WriteTileCache { from, .. } => vec![*from],
            Step::EraseSurface(_) => Vec::new(),
        }
    }

    /// All `SurfaceRef`s this step writes (produces a fresh value at).
    /// For `Composite` the `to` operand is read-modify-write — treated
    /// separately via `rewrites()` so the validator can permit relaxed
    /// SSA there without weakening the single-producer rule elsewhere.
    pub fn writes(&self) -> Vec<SurfaceRef> {
        match self {
            Step::Paint { write_to, .. } => write_to.clone(),
            Step::Snapshot { write_to, .. } => vec![*write_to],
            Step::ComposeBackdrop { write_to, .. } => vec![*write_to],
            Step::PaintGather { write_to, .. } => vec![*write_to],
            Step::Composite { .. } => Vec::new(),
            Step::WriteTileCache { .. } => Vec::new(),
            Step::EraseSurface(_) => Vec::new(),
        }
    }

    /// Surfaces this step rewrites (read-modify-write). Distinct from
    /// `writes()` so the validator can permit relaxed-SSA on `Composite`
    /// while still enforcing single-producer for everything else.
    pub fn rewrites(&self) -> Vec<SurfaceRef> {
        match self {
            Step::Composite { to, .. } => vec![*to],
            _ => Vec::new(),
        }
    }

    /// Surfaces this step kills. Includes explicit `EraseSurface` and the
    /// `erase_after` fold-in on `Composite`. The liveness pass treats
    /// last-read as an implicit kill in addition to these.
    pub fn kills(&self) -> Vec<SurfaceRef> {
        match self {
            Step::EraseSurface(r) => vec![*r],
            Step::Composite {
                from,
                erase_after: true,
                ..
            } => vec![*from],
            _ => Vec::new(),
        }
    }
}
