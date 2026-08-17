//! Logical surface identity — the SSA "register name" for a render surface.
//!
//! Ported from render-wasm's `tile_grid/ssa/surface_ref.rs`, adapted for the Vello backend: the
//! tile key is [`crate::tiling::TileKey`] (page-anchored) rather than Skia's device `Tile`, and
//! shape ids are `u128` (the neutral model's id type) rather than `Uuid`. The role vocabulary is
//! the same — that is the point: this is the one scheduler both backends target.
//!
//! A [`SurfaceRef`] is written exactly once (the SSA invariant the validator enforces) and consumed
//! by zero or more downstream steps. Physical surfaces backing these logical refs are allocated by
//! the backend's production sink (a GPU-texture pool in render-vello); many refs typically share one
//! pooled surface across their non-overlapping live ranges.

use crate::tiling::TileKey;

/// Logical surface id. `(role, tile)` is the SSA name; `version` lets a relaxed-SSA producer reissue
/// the same name (a `Composite` folding into `Target` bumps its version). Each `(role, tile,
/// version)` triple is a distinct value to the validator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SurfaceRef {
    pub role: SurfaceRole,
    /// `None` for the roles that are not tile-keyed — `Target` (viewbox-sized) and the built-once
    /// effect surfaces (`RasterEffectOutput`, `Backdrop`), which are page-anchored and blitted into
    /// whichever tiles they overlap. Tile-keyed roles (`ScopeOf`, `Snapshot`, `TileOutput`) carry
    /// their [`TileKey`].
    pub tile: Option<TileKey>,
    pub version: u32,
}

impl SurfaceRef {
    #[must_use]
    pub const fn new(role: SurfaceRole, tile: Option<TileKey>, version: u32) -> Self {
        Self { role, tile, version }
    }

    /// Shorthand for a tile-keyed ref at version 0 — the common case.
    #[must_use]
    pub const fn tile_ref(role: SurfaceRole, tile: TileKey) -> Self {
        Self { role, tile: Some(tile), version: 0 }
    }

    /// The single `Target` ref, version 0. Every viewbox composite folds into this; the validator
    /// special-cases `Target` to allow multiple producers.
    #[must_use]
    pub const fn target() -> Self {
        Self { role: SurfaceRole::Target, tile: None, version: 0 }
    }

    /// A backdrop snapshot's SSA name: an immutable copy of `source_tile`'s pixels at a gather's
    /// z-position, produced by a [`Step::Snapshot`](super::step::Step::Snapshot) and consumed by that
    /// gather's batched pass. Keyed by `(for_shape, source_tile)` so two gathers snapshotting the same
    /// tile get distinct ids. This is the "id" the scheduler assigns and the sink pools + recycles.
    #[must_use]
    pub const fn snapshot(for_shape: u128, source_tile: TileKey) -> Self {
        Self { role: SurfaceRole::Snapshot { for_shape, source_tile }, tile: Some(source_tile), version: 0 }
    }

    /// Bump the version — used when a step rewrites a logical surface in relaxed-SSA mode.
    #[must_use]
    pub fn bump(self) -> Self {
        Self { version: self.version + 1, ..self }
    }

    #[must_use]
    pub fn is_target(&self) -> bool {
        matches!(self.role, SurfaceRole::Target)
    }
}

/// What role a logical surface plays in the schedule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SurfaceRole {
    /// Per-tile scope buffer for a shape that needs isolation (frames, groups, masked containers,
    /// opacity/blend). Children paint into it; on `Composite` it folds into the parent.
    ScopeOf(u128),
    /// Immutable snapshot of another surface's pixel state at a point in time — produced by a
    /// snapshot step, consumed by `ComposeBackdrop`. `(for_shape, source_tile)` keeps cross-tile
    /// snapshots distinct even when they pull from the same logical role.
    Snapshot { for_shape: u128, source_tile: TileKey },
    /// Fused backdrop for a **gather** (Glass / BackgroundBlur) shape — the sample-neighbourhood
    /// composite produced by `ComposeBackdrop`, sized to the gather's sample rect. Lives just long
    /// enough for `PaintGather` to consume it.
    Backdrop(u128),
    /// Pre-rendered output of a **spread** shape (drop/inner shadow, layer blur, glow) — the shape's
    /// body painted once into a surface sized to its `extrect`, then blitted into every tile the
    /// extrect overlaps. The render-vello effect surface.
    RasterEffectOutput(u128),
    /// Per-tile final pixel content, ready to be written into the cross-frame tile cache.
    TileOutput,
    /// The single viewbox-sized accumulator the swapchain presents.
    Target,
}

impl SurfaceRole {
    /// Short tag for debug dumps and validator errors.
    #[must_use]
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

    /// Whether this role is tile-keyed (must carry a [`TileKey`]).
    #[must_use]
    pub fn is_tile_keyed(&self) -> bool {
        matches!(
            self,
            SurfaceRole::ScopeOf(_) | SurfaceRole::Snapshot { .. } | SurfaceRole::TileOutput
        )
    }
}

/// Allocator size buckets. The backend pool keys physical surfaces by these.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SizeClass {
    /// Tile buffer with margins — `TILE_BUFFER²`.
    Tile,
    /// A shape's effect surface, sized to its `extrect` (spread) or sample rect (gather).
    Effect,
    /// Viewbox-sized — only `Target`.
    Viewbox,
}
