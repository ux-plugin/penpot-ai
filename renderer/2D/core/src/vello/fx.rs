//! The unit-based effect representation: one `Op` type that replaces the three the pipeline carries
//! today (`GraphPass` IR, `Pass` lowered, `Stage`+`Inst` batch schedule). An `Op` is a fused run of
//! [`UnitOp`]s over one [`FieldProgram`], applied to N cells as `instances`. `instances.len() == 1`
//! is a single shape; `> 1` is a batch — the same type, so "does it batch?" is an outcome, not a gate.
//!
//! Everything that used to be a stored field and drift out of sync is DERIVED here: `key` (batch and
//! pipeline identity), `reads_dst` (the dependency signal, was `is_glass`/`reads_backdrop`), and
//! `region` (the footprint). Ordering is the position of an `Op` in the [`FxSchedule`], not a tag.
//!
//! Backend-neutral. A backend realises an `Op` through [`FxBackend`]; WebGPU binds the instances as a
//! storage array, WebGL2 as an instance-step vertex buffer plus a field data-texture — the only place
//! the two diverge.

use std::hash::{Hash, Hasher};
use std::rc::Rc;

use crate::effect_graph::Src;
use crate::field::FieldProgram;
use crate::kurbo::Rect;
use crate::vello::batch::FieldUniform;
use crate::vello::units::UnitOp;

/// One cell an [`Op`] draws: where it lands (`dst`), what slice of the input it reads (`src`), the UV
/// clamp confining that read to its own cell in a shared atlas, its per-cell field parameters, and
/// the render-scale fraction its target was allocated at (carried so a reduced pass upsamples).
#[derive(Clone)]
#[allow(dead_code, reason = "wired in step 4 (executor swap)")]
pub struct Instance {
    pub dst: Rect,
    pub src: Rect,
    pub clamp: Rect,
    pub field: FieldUniform,
    pub scale: f32,
}

/// A fused run of units over one field, applied to `instances` cells. Intrinsic data only — see the
/// module docs for what is derived.
#[derive(Clone)]
#[allow(dead_code, reason = "wired in step 4 (executor swap)")]
pub struct Op {
    pub units: Vec<UnitOp>,
    pub field: Rc<FieldProgram>,
    pub inputs: Vec<Src>,
    pub target: Target,
    pub instances: Vec<Instance>,
    /// Composite (`SrcOver`) onto the target rather than replace it.
    pub blend: bool,
}

/// Where an [`Op`] writes: a fresh transient the executor allocates, or the frame accumulator.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(dead_code, reason = "wired in step 4 (executor swap)")]
pub enum Target {
    /// A private surface, sized to the op's region — a materialisation.
    Transient,
    /// The frame accumulator — a composite into the scene.
    Accumulator,
}

#[allow(dead_code, reason = "wired in step 4 (executor swap)")]
impl Op {
    /// Whether this op reads the destination/backdrop — the ONE dependency signal. An input bound to
    /// `Src::Input` is the assembled backdrop, so the op must run after whatever painted it.
    #[must_use]
    pub fn reads_dst(&self) -> bool {
        self.inputs.iter().any(|s| matches!(s, Src::Input(_)))
    }

    /// The device rect this op touches — the union of its instances' destinations.
    #[must_use]
    pub fn region(&self) -> Rect {
        self.instances
            .iter()
            .map(|i| i.dst)
            .reduce(|a, b| a.union(b))
            .unwrap_or(Rect::ZERO)
    }

    /// Batch- and pipeline-identity: two ops with the same key run the same pipeline and can instance
    /// together. It is the unit composition plus the field program — never the effect family.
    #[must_use]
    pub fn key(&self) -> u64 {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for u in &self.units {
            std::mem::discriminant(u).hash(&mut h);
        }
        // The field program has no Hash; its Debug form is the stable identity the batch cache
        // already keys on (`batch::program_key`).
        format!("{:?}", self.field).hash(&mut h);
        self.blend.hash(&mut h);
        h.finish()
    }
}

/// One frame's effect work, in dependency order. Position encodes rounds: a `reads_dst` op sits after
/// its producers.
#[allow(dead_code, reason = "wired in step 4 (executor swap)")]
pub type FxSchedule = Vec<Op>;

/// What a backend must provide to run an [`FxSchedule`] — the only API-aware seam. `plan` and
/// `execute` are written against this, so a backend chooses its own instancing mechanism (WebGPU
/// storage array, WebGL2 vertex-attr + data-texture) and its own capacity limits without the planner
/// knowing.
#[allow(dead_code, reason = "impls land in steps 4 (WebGPU) and 5 (WebGL2)")]
pub trait FxBackend {
    /// The backend's scheduling limits — how many instances one draw may carry.
    fn caps(&self) -> Caps;
}

/// Backend capability limits the planner coalesces against.
#[derive(Clone, Copy, Debug)]
#[allow(dead_code, reason = "consumed by coalesce() in step 3")]
pub struct Caps {
    /// Maximum instances one draw can carry. `usize::MAX` for storage-buffer backends (WebGPU);
    /// the attribute/UBO array bound for WebGL2 — `coalesce` splits an over-cap op.
    pub max_instances: usize,
}
