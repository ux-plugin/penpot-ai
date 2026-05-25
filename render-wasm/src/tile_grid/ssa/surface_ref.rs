//! Logical surface identity.
//!
//! A `SurfaceRef` is the SSA-style "register name" for a render surface.
//! Each ref is written exactly once (the SSA invariant the validator
//! enforces) and consumed by zero or more downstream steps. Physical
//! Skia surfaces backing these logical refs are allocated lazily by
//! `SurfaceAllocator` based on liveness — many refs typically share one
//! pooled surface across their non-overlapping live ranges.
//!
//! Refs are strictly **per-tile**: `ScopeOf(F, T00)` and `ScopeOf(F, T10)`
//! are distinct logical IDs even when they belong to the same logical
//! frame. Cross-tile reads always go through explicit `Snapshot` steps —
//! which produce their own `Snapshot`-role ref — so a tile's local
//! schedule never depends on another tile's mutable surface state.

use crate::tiles::Tile;
use crate::uuid::Uuid;

/// Logical surface ID. The pair `(role, tile)` is the SSA name; `version`
/// lets a relaxed-SSA producer reissue the same name (e.g. a `Composite`
/// folding into `Target` bumps `Target`'s version). The validator treats
/// each `(role, tile, version)` triple as a distinct value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SurfaceRef {
    pub role: SurfaceRole,
    /// `None` for `Target` (viewbox-sized, not tile-keyed). All other
    /// roles must carry a tile.
    pub tile: Option<Tile>,
    pub version: u32,
}

impl SurfaceRef {
    pub const fn new(role: SurfaceRole, tile: Option<Tile>, version: u32) -> Self {
        Self {
            role,
            tile,
            version,
        }
    }

    /// Shorthand for tile-keyed refs at version 0 — the common case.
    pub const fn tile_ref(role: SurfaceRole, tile: Tile) -> Self {
        Self {
            role,
            tile: Some(tile),
            version: 0,
        }
    }

    /// The (single) `Target` ref, version 0. Every viewbox composite folds
    /// into this. Versioning bumps as repeated composites land — but the
    /// validator special-cases `Target` to allow multiple producers.
    pub const fn target() -> Self {
        Self {
            role: SurfaceRole::Target,
            tile: None,
            version: 0,
        }
    }

    /// Bump the version. Used when a step rewrites a logical surface in
    /// the relaxed-SSA mode (currently only `Target`).
    pub fn bump(self) -> Self {
        Self {
            version: self.version + 1,
            ..self
        }
    }

    /// True if this ref is the single viewbox-sized accumulator.
    pub fn is_target(&self) -> bool {
        matches!(self.role, SurfaceRole::Target)
    }
}

/// What role a logical surface plays in the schedule. Each role carries
/// the data needed to disambiguate it from siblings of the same role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SurfaceRole {
    /// Per-tile scope buffer for a shape that needs isolation (frames,
    /// groups, masked containers). Children paint into this; on `Composite`
    /// it folds into the parent.
    ScopeOf(Uuid),
    /// Immutable snapshot of another surface's pixel state at a point in
    /// time. Produced by `Snapshot`, consumed by `ComposeBackdrop`. The
    /// `(producer_shape, source_tile)` disambiguator keeps cross-tile
    /// snapshots distinct even when they pull from the same logical role.
    Snapshot {
        for_shape: Uuid,
        source_tile: Tile,
    },
    /// Fused backdrop for a gather (Glass / BackgroundBlur) shape — the
    /// 3×3 sample-neighborhood composite produced by `ComposeBackdrop`.
    /// Lives just long enough for `PaintGather` to consume it.
    Backdrop(Uuid),
    /// Pre-rendered output of a scatter (texture) shape or a layer-blurred
    /// leaf — built once, blitted per-tile. Replaces today's
    /// `scatter_output_cache` and `local_blur_output_cache`.
    RasterEffectOutput(Uuid),
    /// Per-tile final pixel content, ready to be written into the
    /// cross-frame tile texture cache via `WriteTileCache`.
    TileOutput,
    /// The single viewbox-sized accumulator. Composited into by tile-level
    /// `Composite` steps; the canvas presents it.
    Target,
}

impl SurfaceRole {
    /// Tag used in human-readable debug dumps and validator errors. Short
    /// to keep schedule prints scannable.
    pub fn tag(&self) -> &'static str {
        match self {
            SurfaceRole::ScopeOf(_) => "Scope",
            SurfaceRole::Snapshot { .. } => "Snap",
            SurfaceRole::Backdrop(_) => "Bd",
            SurfaceRole::RasterEffectOutput(_) => "Rast",
            SurfaceRole::TileOutput => "Tile",
            SurfaceRole::Target => "Tgt",
        }
    }
}

/// Allocator size buckets. The pool is keyed by exact `(width, height)`
/// for now (Checkpoint A); Step 3 tuning may collapse close sizes into
/// these classes if profiling shows allocation churn from off-by-one
/// dimensions (e.g. tile_with_margins ± 1 px on neighbor tiles).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SizeClass {
    /// Tile-sized with the renderer's `TILE_SIZE_MULTIPLIER` margins
    /// applied (today's `Surfaces.current` dimensions).
    Tile,
    /// Scope buffer — usually tile-sized but may grow to fit a child
    /// shape's extrect when the scope's gather sample radius exceeds
    /// the tile margin.
    Scope,
    /// Viewbox-sized — only `Target` uses this class.
    Viewbox,
}
