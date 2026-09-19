//! Step 7a: the operands every arm reads and the descriptor `fine.wgsl` runs it by, serialised
//! into the plan's one parameter buffer — one descriptor per arm: the 26-float header and the
//! operand records, each a store fact (`[source, x0, y0, x1, y1, dx, dy, decode]`).

use crate::kurbo::Vec2;

use crate::vello::arms::{is_pointwise, Kind, Work};
use crate::vello::bake::{self, Policy, REC_COUNT, REC_STRIDE};
use crate::vello::frame_graph::{BlurAxis, ComposeMode, EdgeClampStyle, NodeId, Op};
use crate::vello::resolve::Resolved;
use crate::vello::schedule::Schedule;
use crate::vello::units::{BlurEdge, UnitOp};

/// Descriptor floats per arm: the 26-float header and the operand records.
const DESC_FLOATS: usize = 26 + REC_COUNT * REC_STRIDE;
/// Operand record sources, as `fine.wgsl` reads them: absent, a store rect, the tile's registers,
/// the marker's silhouette.
const SRC_NONE: f32 = 0.0;
const SRC_STORE: f32 = 1.0;
const SRC_REGS: f32 = 2.0;
const SRC_AREA: f32 = 3.0;
/// Operand record roles.
const REC_VALUE: usize = 0;
const REC_REF: usize = 1;
const REC_COVERAGE: usize = 2;
const REC_DISTANCE: usize = 3;
const REC_OUTPUT: usize = 4;

/// Where an arm reads one operand from.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Operand {
    None,
    /// The tile's own registers: the state the tile holds.
    Regs,
    /// A value, read displaced by `shift` (frame px): its rows in the store, or the marker's own
    /// silhouette for a [`Kind::Silhouette`].
    Value { v: usize, shift: Vec2 },
}

/// One arm's operands, and where its descriptor starts in the buffer.
#[derive(Clone, Copy, Debug)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct Operands {
    pub value: Operand,
    pub reference: Operand,
    pub coverage: Operand,
    pub distance: Operand,
    /// The shape whose silhouette masks the marker when any operand is a silhouette.
    pub mask_shape: Option<u128>,
    pub off: u32,
}

pub(crate) struct Params {
    pub floats: Vec<f32>,
    pub arms: Vec<Operands>,
}

impl Params {
    pub fn bake(cx: &Resolved, work: &Work, s: &Schedule) -> Params {
        let mut p = Params { floats: Vec::new(), arms: Vec::with_capacity(work.arms.len()) };
        for a in 0..work.arms.len() {
            let ops = p.bake_arm(cx, work, s, a);
            p.arms.push(ops);
        }
        p
    }

    /// Where arm `a` reads node `j`: the tile's own registers when a pointwise read of the spine
    /// lands on the rows the arm writes, and the value `j` is held in otherwise (the rows of the
    /// spine it stands on, a leaf, a silhouette, an arm's output).
    fn operand_for(cx: &Resolved, work: &Work, a: usize, j: NodeId, shift: Vec2, pointwise: bool) -> Operand {
        if cx.g.is_spine(j) {
            if pointwise && work.arms[a].compose.is_some() && shift == Vec2::ZERO {
                return Operand::Regs;
            }
            return Operand::Value { v: work.value_of[j].unwrap_or(0), shift };
        }
        match work.value_of[j] {
            Some(v) => Operand::Value { v, shift },
            None => Operand::None,
        }
    }

    fn record(cx: &Resolved, work: &Work, s: &Schedule, op: Operand, decode: f32) -> [f32; REC_STRIDE] {
        let mut r = [0.0f32; REC_STRIDE];
        match op {
            Operand::None => r[0] = SRC_NONE,
            Operand::Regs => r[0] = SRC_REGS,
            Operand::Value { v, .. } if matches!(work.values[v].kind, Kind::Silhouette(_)) => r[0] = SRC_AREA,
            Operand::Value { v, shift } => {
                let rect = s.store_rect(cx, work, v);
                let d = shift * f64::from(cx.res.k[work.values[v].node]) - s.slot[v].place;
                r = [SRC_STORE, rect.x0 as f32, rect.y0 as f32, rect.x1 as f32, rect.y1 as f32, d.x as f32, d.y as f32, decode];
            }
        }
        r
    }

    fn unit_of(cx: &Resolved, i: NodeId) -> Option<UnitOp> {
        Some(match &cx.g.nodes[i].op {
            Op::Blur { sigma, axis, linear, edge_clamp_style, .. } => UnitOp::Blur {
                sigma: *sigma,
                linear: *linear,
                axis: match axis {
                    BlurAxis::X => crate::vello::units::BlurAxis::X,
                    BlurAxis::Y => crate::vello::units::BlurAxis::Y,
                },
                edge: match edge_clamp_style {
                    EdgeClampStyle::Extend => BlurEdge::Backdrop,
                    EdgeClampStyle::Transparent => BlurEdge::Coverage,
                },
            },
            Op::Warp(u) => UnitOp::Warp(bake::payload_at(u, cx.res.k[i])),
            Op::Scatter(u) => UnitOp::Scatter(bake::payload_at(u, cx.res.k[i])),
            Op::Shade(u) => UnitOp::Shade(bake::payload_at(u, cx.res.k[i])),
            Op::MaskMix(u) => UnitOp::MaskMix(bake::payload_at(u, cx.res.k[i])),
            Op::ClipToSource(u) => UnitOp::ClipToSource(u.clone()),
            Op::EraseBy(_) => UnitOp::EraseBy(Vec::new()),
            Op::Colour(_) | Op::Draw(_) | Op::Compose { .. } | Op::Resample { .. } | Op::Halo { .. } => return None,
        })
    }

    /// The decode of the distance leaf operand `op` reads, 0 for anything else.
    fn decode_of(work: &Work, op: Operand) -> f32 {
        match op {
            Operand::Value { v, .. } => match work.values[v].kind {
                Kind::Leaf { decode, .. } => decode,
                _ => 0.0,
            },
            _ => 0.0,
        }
    }

    /// Arm `a`'s operands, its descriptor appended to the buffer.
    fn bake_arm(&mut self, cx: &Resolved, work: &Work, s: &Schedule, a: usize) -> Operands {
        let arm = &work.arms[a];
        let nodes = &arm.nodes;
        let compose = arm.compose;
        let mut value = Operand::None;
        let mut reference = Operand::None;
        let mut coverage = Operand::None;
        let mut distance = Operand::None;
        let mut mask_shape = None;
        let mut tint: Option<[f32; 4]> = None;
        let mut run: Vec<UnitOp> = Vec::new();
        let mut edge_coverage = false;
        let mut blur: Option<(f32, u32, bool, bool)> = None;
        let mut program: Option<f32> = None;
        let mut resample: Option<(f32, f32)> = None;
        for (k, &i) in nodes.iter().enumerate() {
            let node = &cx.g.nodes[i];
            match &node.op {
                Op::Blur { sigma, linear, axis, edge_clamp_style, taps } => {
                    blur = Some((*sigma * cx.res.k[i], *taps, *linear, *axis == BlurAxis::Y));
                    edge_coverage = *edge_clamp_style == EdgeClampStyle::Transparent;
                }
                Op::Resample { .. } => {
                    let j = cx.input(i, 0);
                    let past = if Work::rooted_in_leaf(cx, i) { bake::RESAMPLE_TRANSPARENT } else { bake::RESAMPLE_CLAMP };
                    resample = Some((cx.res.k[j] / cx.res.k[i], past));
                }
                Op::Colour(c) => tint = Some([c[0], c[1], c[2], c[3]]),
                Op::MaskMix(u) if u.get(bake::PAYLOAD_PROGRAM_SLOT).copied() == Some(bake::PROGRAM_RADIAL) => program = Some(bake::PROGRAM_RADIAL),
                Op::Halo { of } => resample = Some((cx.res.k[*of] / cx.res.k[i], bake::RESAMPLE_KEEP)),
                _ => {}
            }
            if let Some(u) = Self::unit_of(cx, i) {
                run.push(u);
            }
            if k == 0 {
                value = match node.op {
                    Op::Halo { of } => Operand::Value { v: work.value_of[of].unwrap_or(0), shift: Vec2::ZERO },
                    _ => Self::operand_for(cx, work, a, cx.input(i, 0), Vec2::ZERO, is_pointwise(&node.op)),
                };
                if let (Op::Warp(_), Some(&sdf)) = (&node.op, node.inputs.get(1)) {
                    distance = Self::operand_for(cx, work, a, cx.res.alias[sdf], Vec2::ZERO, true);
                }
            }
            match &node.op {
                Op::EraseBy(u) => {
                    let shift = Vec2::new(f64::from(u.first().copied().unwrap_or(0.0)), f64::from(u.get(1).copied().unwrap_or(0.0)));
                    reference = Self::operand_for(cx, work, a, cx.input(i, 1), shift, true);
                }
                Op::MaskMix(_) | Op::ClipToSource(_) => {
                    reference = Self::operand_for(cx, work, a, cx.input(i, 1), Vec2::ZERO, true);
                }
                _ => {}
            }
        }
        let mut policy = Policy { raw: compose.is_none(), edge_coverage, ..Policy::default() };
        let silhouette = |j: NodeId| match work.value_of[j].map(|v| &work.values[v].kind) {
            Some(Kind::Silhouette(shape)) => Some(*shape),
            _ => None,
        };
        if let Some(c) = compose {
            let Op::Compose { mode, colour, offset } = &cx.g.nodes[c].op else { unreachable!() };
            let cnode = &cx.g.nodes[c];
            if nodes.is_empty() {
                value = Self::operand_for(cx, work, a, cx.input(c, 1), Vec2::new(f64::from(offset[0]), f64::from(offset[1])), true);
            } else if let Operand::Value { v, .. } = value {
                value = Operand::Value { v, shift: Vec2::new(f64::from(offset[0]), f64::from(offset[1])) };
            }
            if cnode.inputs.len() > 2 {
                coverage = Self::operand_for(cx, work, a, cx.input(c, 2), Vec2::ZERO, true);
            }
            match (mode, colour) {
                (ComposeMode::Over, Some(c)) => {
                    policy.colour_over = true;
                    tint = Some(*c);
                }
                (ComposeMode::Over, None) => policy.value_over = true,
                (ComposeMode::MaskedMix, _) => {}
            }
            for j in cx.inputs(c).into_iter().skip(1) {
                if let Some(shape) = silhouette(j) {
                    mask_shape = Some(shape);
                }
            }
        }
        for &i in nodes {
            for j in cx.inputs(i) {
                if let Some(shape) = silhouette(j) {
                    mask_shape = Some(shape);
                }
            }
        }
        let mut desc = match blur {
            Some((sigma, taps, linear, axis_y)) => bake::blur_arm(sigma, taps, linear, axis_y, policy, tint.filter(|_| policy.colour_over)),
            None => bake::arm_descriptor(&run, policy, program),
        };
        if let Some((ratio, past)) = resample {
            desc[0] = (desc[0] as u32 | bake::bits::RESAMPLE) as f32;
            desc[2] = ratio;
            desc[3] = past;
        }
        if work.snapshot_of(cx, a).is_some() {
            desc[0] = (desc[0] as u32 | bake::bits::SNAPSHOT) as f32;
        }
        if let Some(t) = tint {
            if !policy.colour_over {
                desc[0] = (desc[0] as u32 | bake::bits::TINT) as f32;
            }
            desc[14..18].copy_from_slice(&t);
        }
        let mut rec = [[0.0f32; 4]; 12];
        bake::stamp_field_anchor(&desc, &mut rec);
        let (out_rect, out_place) = match (arm.out, compose) {
            (0, Some(c)) => (cx.dem.out[c], Vec2::ZERO),
            (v, _) => (s.store_rect(cx, work, v), s.slot[v].place),
        };
        let mut records = [[0.0f32; REC_STRIDE]; REC_COUNT];
        records[REC_VALUE] = Self::record(cx, work, s, value, 0.0);
        records[REC_REF] = Self::record(cx, work, s, reference, 0.0);
        records[REC_COVERAGE] = Self::record(cx, work, s, coverage, 0.0);
        records[REC_DISTANCE] = Self::record(cx, work, s, distance, Self::decode_of(work, distance));
        records[REC_OUTPUT] = [SRC_STORE, out_rect.x0 as f32, out_rect.y0 as f32, out_rect.x1 as f32, out_rect.y1 as f32, out_place.x as f32, out_place.y as f32, 0.0];
        records[5][0] = rec[10][0];
        records[5][1] = rec[10][1];
        let off = self.floats.len();
        self.floats.extend_from_slice(&desc);
        for r in &records {
            self.floats.extend_from_slice(r);
        }
        debug_assert_eq!(self.floats.len() - off, DESC_FLOATS);
        Operands { value, reference, coverage, distance, mask_shape, off: off as u32 }
    }
}
