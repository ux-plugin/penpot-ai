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
use crate::vello::units::UnitOp;

/// One fused run's field parameters — the same 24-float composed uniform the per-shape pipeline binds
/// ([`super::units`]), carried per instance so every cell in a coalesced op has its own. `align(16)`
/// matches the WGSL `array<vec4<f32>, 6>` a backend maps it to.
#[repr(C, align(16))]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct FieldUniform {
    pub u: [f32; 24],
}

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
pub struct Caps {
    /// Maximum instances one draw can carry. `usize::MAX` for storage-buffer backends (WebGPU);
    /// the attribute/UBO array bound for WebGL2 — `coalesce` splits an over-cap op.
    pub max_instances: usize,
}

/// Merge ops that run the same pipeline into instanced draws — the "batch across shapes" step, as a
/// `Vec<Op> → Vec<Op>` transform. Ops sharing a [`Op::key`] collapse into one op carrying all their
/// instances (preserving first-seen order); a group over `caps.max_instances` splits into as many
/// draws as it takes. `instances.len() == 1` survivors are single shapes — the same type, so nothing
/// downstream distinguishes "batched" from "not".
///
/// The shared atlas the merged instances read is allocated at execute time, where each instance's
/// `src`/`clamp` is rewritten to its cell; coalesce only decides the grouping.
#[must_use]
#[allow(dead_code, reason = "wired when the batched planner emits Ops")]
pub fn coalesce(ops: Vec<Op>, caps: Caps) -> FxSchedule {
    let mut order: Vec<u64> = Vec::new();
    let mut groups: std::collections::HashMap<u64, Op> = std::collections::HashMap::new();
    for op in ops {
        let k = op.key();
        if let Some(acc) = groups.get_mut(&k) {
            acc.instances.extend(op.instances);
        } else {
            order.push(k);
            groups.insert(k, op);
        }
    }
    let cap = caps.max_instances.max(1);
    let mut out = Vec::new();
    for k in order {
        let op = groups.remove(&k).expect("key was inserted with its op");
        if op.instances.len() <= cap {
            out.push(op);
        } else {
            for chunk in op.instances.chunks(cap) {
                out.push(Op { instances: chunk.to_vec(), ..op.clone() });
            }
        }
    }
    out
}

#[cfg(test)]
mod coalesce_tests {
    use super::{coalesce, Caps, FieldUniform, Instance, Op, Target};
    use crate::kurbo::Rect;
    use crate::vello::units::UnitOp;

    fn field() -> std::rc::Rc<crate::field::FieldProgram> {
        std::rc::Rc::new(crate::field::FieldProgram { nodes: Vec::new(), outputs: Vec::new() })
    }

    fn inst(x: f64) -> Instance {
        Instance {
            dst: Rect::new(x, 0.0, x + 10.0, 10.0),
            src: Rect::new(0.0, 0.0, 1.0, 1.0),
            clamp: Rect::new(0.0, 0.0, 1.0, 1.0),
            field: FieldUniform { u: [0.0; 24] },
            scale: 1.0,
        }
    }

    fn op(units: Vec<UnitOp>, x: f64) -> Op {
        Op { units, field: field(), inputs: Vec::new(), target: Target::Transient, instances: vec![inst(x)], blend: false }
    }

    fn no_cap() -> Caps { Caps { max_instances: usize::MAX } }

    /// Three shapes with the same unit chain collapse into ONE op carrying three instances — the whole
    /// "batch across shapes" idea, as an outcome of matching keys.
    #[test]
    fn same_key_ops_merge_into_one_instanced_op() {
        let ops = vec![op(vec![UnitOp::Tint(vec![])], 0.0), op(vec![UnitOp::Tint(vec![])], 20.0), op(vec![UnitOp::Tint(vec![])], 40.0)];
        let out = coalesce(ops, no_cap());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].instances.len(), 3);
    }

    /// Different unit chains keep separate draws.
    #[test]
    fn different_keys_stay_separate() {
        let ops = vec![op(vec![UnitOp::Tint(vec![])], 0.0), op(vec![UnitOp::Blur { sigma: 4.0, linear: true, axis: Default::default(), edge: Default::default() }], 20.0)];
        let out = coalesce(ops, no_cap());
        assert_eq!(out.len(), 2);
    }

    /// A group past the backend's instance cap splits into multiple draws — WebGL2's attribute limit
    /// expressed as data, not a special case.
    #[test]
    fn an_over_cap_group_splits() {
        let ops = vec![op(vec![UnitOp::Tint(vec![])], 0.0), op(vec![UnitOp::Tint(vec![])], 20.0), op(vec![UnitOp::Tint(vec![])], 40.0)];
        let out = coalesce(ops, Caps { max_instances: 2 });
        assert_eq!(out.len(), 2, "3 instances at cap 2 => 2+1");
        assert_eq!(out[0].instances.len(), 2);
        assert_eq!(out[1].instances.len(), 1);
    }
}
