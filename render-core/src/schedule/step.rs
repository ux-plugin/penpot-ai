//! The flat schedule IR — one `Step` per unit of scheduler work.
//!
//! Ported from render-wasm's `tile_grid/ssa/step.rs`. Each step is self-contained: it carries its
//! own tile context and an explicit operand list (`reads` / `writes` / `rewrites` / `kills`), so the
//! dependency graph and the backend production sink need no global "current tile" state. Neutral
//! types throughout — `u128` shape ids, [`TileKey`] tiles, `kurbo` rects — so both backends can
//! execute the same schedule.
//!
//! Effect *bodies* (which fills/strokes/shadows/gathers a `Paint` runs) are not encoded here: they
//! live on the neutral `Node` the `shape` id points at, and the sink reads them. The schedule only
//! encodes *structure* — which surface each shape paints into, and how surfaces compose.

use kurbo::Rect;

use super::surface_ref::SurfaceRef;

/// Opacity + blend for a `Composite` / layer bracket. Clip is carried by the node.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayerPaint {
    /// 1.0 = fully opaque.
    pub opacity: f32,
    pub blend: peniko::BlendMode,
}

impl LayerPaint {
    #[must_use]
    pub fn opaque() -> Self {
        Self { opacity: 1.0, blend: peniko::BlendMode::default() }
    }

    /// Whether this is a plain opaque `SrcOver` (no isolation needed).
    #[must_use]
    pub fn is_trivial(&self) -> bool {
        self.opacity >= 1.0 && self.blend == peniko::BlendMode::default()
    }
}

/// One instruction inside a `Paint`'s body stream. A `Paint` executes these in order into a single
/// backend pass (one Vello scene → one submit), so a `PushLayer`/`PopLayer` bracket isolates an
/// opacity/blend group **without** a separate raster surface — the whole plain subtree stays in one
/// submission. Layer params (opacity/blend) are read from the node the id points at, exactly as
/// `Body` reads its fills/strokes. The bracket must open and close inside the *same* `Paint`, because
/// a backend layer cannot span two scene renders; the builder only lowers a group to a layer when its
/// subtree has no batch-breaking effect (see `builder::subtree_needs_surface`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PaintOp {
    /// Draw this shape's body (fills + strokes + drop/inner shadows + filter graph).
    Body(u128),
    /// Open an opacity/blend group layer for this container; paired with a later `PopLayer`.
    PushLayer(u128),
    /// Close the most recently opened layer.
    PopLayer,
}

/// One step in the flat schedule. Variants are coarse-grained: one `Paint` covers a shape's full
/// body (fills + strokes + drop/inner shadows) because no downstream consumer reads a single pass.
#[derive(Debug, Clone)]
pub enum Step {
    /// Execute a run of `PaintOp`s into `write_to`, in z-order, in a single pass — a tile's
    /// `TileOutput` directly (no isolation), a `ScopeOf` scope buffer, or a single shape's own
    /// `RasterEffectOutput` surface (a spread effect, sized to the shape's extrect). The builder
    /// emits one op per `Paint`, then `coalesce` merges consecutive paints into the same tile/scope
    /// surface into one — collapsing per-shape passes into one pass per run (a spread or gather
    /// between two plain runs breaks the merge, preserving z). Plain opacity/blend groups fold in as
    /// `PushLayer`/`PopLayer` ops rather than their own surface. `clip` is the tile's page-space clip;
    /// effect details come from each node.
    Paint {
        ops: Vec<PaintOp>,
        clip: Rect,
        write_to: SurfaceRef,
    },

    /// Immutable snapshot of a surface's current pixels — the below-z-order content a gather samples.
    /// Produces a fresh `Snapshot`-role ref.
    Snapshot {
        from: SurfaceRef,
        write_to: SurfaceRef,
    },

    /// Fuse snapshots from a gather's sample neighbourhood into one backdrop surface, sized to the
    /// gather's world-space `extent` (its `Backdrop` role). Sizing to the extent — not a tile — is
    /// what keeps the gather from cropping and fading on zoom-in.
    ///
    /// `reach` is the effect's page-space reach (how far `extent` grew past the shape). The sink caps
    /// the backdrop's device resolution so `reach · zoom` never exceeds one tile — keeping every
    /// gather's read/write inside the current tile's one-tile ring, then upscaling the result.
    ComposeBackdrop {
        shape: u128,
        read_from: Vec<SurfaceRef>,
        extent: Rect,
        reach: f64,
        /// Cap the backdrop's device resolution unconditionally (from any zoom), not only once the
        /// reach exceeds a tile. Set for a *custom* WGSL effect, whose reach/cost can't be reasoned
        /// about — so its surface is bounded to the one-tile ring from the get-go.
        always_cap: bool,
        write_to: SurfaceRef,
    },

    /// Run a gather effect (Glass / BackgroundBlur) reading `backdrop`, writing the destination.
    /// `clip` is the shape's page-space silhouette rect — the blurred backdrop shows only through it.
    PaintGather {
        shape: u128,
        backdrop: SurfaceRef,
        clip: Rect,
        write_to: SurfaceRef,
    },

    /// Composite one surface into another with opacity/blend/clip. `erase_after` folds an
    /// `EraseSurface(from)` into the same step for short-lived intermediates.
    Composite {
        from: SurfaceRef,
        to: SurfaceRef,
        paint: LayerPaint,
        rect: Rect,
        erase_after: bool,
    },

    /// Persist a tile's final pixels into the cross-frame tile cache.
    WriteTileCache {
        from: SurfaceRef,
        tile: crate::tiling::TileKey,
    },

    /// Clear the cross-frame cache region for a tile that no longer has content (a shape moved away),
    /// so it does not ghost. References no logical surface.
    ClearTileCacheRegion {
        tile: crate::tiling::TileKey,
        rect: Rect,
    },

    /// Push a layer (opacity + blend) onto `write_to`, paired with a later `EndLayer`. Wraps a
    /// shape's body so its passes composite onto the parent as one image.
    BeginLayer {
        shape: u128,
        write_to: SurfaceRef,
        paint: LayerPaint,
    },

    /// Pop the layer pushed by `BeginLayer`.
    EndLayer {
        shape: u128,
        write_to: SurfaceRef,
    },

    /// Explicit kill marker (liveness also derives implicit last-use kills).
    EraseSurface(SurfaceRef),
}

impl Step {
    /// Every `SurfaceRef` this step reads. Empty for `Paint` — its inputs are shape data, not
    /// surfaces (the property that makes spread effects independent of the backdrop).
    #[must_use]
    pub fn reads(&self) -> Vec<SurfaceRef> {
        match self {
            Step::Paint { .. } => Vec::new(),
            Step::Snapshot { from, .. } => vec![*from],
            Step::ComposeBackdrop { read_from, .. } => read_from.clone(),
            Step::PaintGather { backdrop, .. } => vec![*backdrop],
            Step::Composite { from, .. } => vec![*from],
            Step::WriteTileCache { from, .. } => vec![*from],
            Step::ClearTileCacheRegion { .. }
            | Step::BeginLayer { .. }
            | Step::EndLayer { .. }
            | Step::EraseSurface(_) => Vec::new(),
        }
    }

    /// Every `SurfaceRef` this step produces a fresh value at. `Composite`'s `to` is read-modify-write
    /// — see [`Step::rewrites`].
    #[must_use]
    pub fn writes(&self) -> Vec<SurfaceRef> {
        match self {
            Step::Paint { write_to, .. } => vec![*write_to],
            Step::Snapshot { write_to, .. } => vec![*write_to],
            Step::ComposeBackdrop { write_to, .. } => vec![*write_to],
            Step::PaintGather { write_to, .. } => vec![*write_to],
            Step::Composite { .. }
            | Step::WriteTileCache { .. }
            | Step::ClearTileCacheRegion { .. }
            | Step::BeginLayer { .. }
            | Step::EndLayer { .. }
            | Step::EraseSurface(_) => Vec::new(),
        }
    }

    /// Surfaces this step read-modify-writes — distinct from [`Step::writes`] so the validator can
    /// permit relaxed SSA on `Composite`/layer brackets while enforcing single-producer elsewhere.
    #[must_use]
    pub fn rewrites(&self) -> Vec<SurfaceRef> {
        match self {
            Step::Composite { to, .. } => vec![*to],
            Step::BeginLayer { write_to, .. } | Step::EndLayer { write_to, .. } => vec![*write_to],
            _ => Vec::new(),
        }
    }

    /// Surfaces this step kills (explicit `EraseSurface` + `Composite { erase_after: true }`).
    #[must_use]
    pub fn kills(&self) -> Vec<SurfaceRef> {
        match self {
            Step::EraseSurface(r) => vec![*r],
            Step::Composite { from, erase_after: true, .. } => vec![*from],
            _ => Vec::new(),
        }
    }
}
