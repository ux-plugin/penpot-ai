//! Phase 0 of the unified plan: **interpretation**.
//!
//! A lowered chain already carries its dataflow — every [`Pass`] names its inputs as
//! [`Src::Input`] / [`Src::Pass`], and [`crate::footprint::execution_groups`] has already decided
//! which passes materialise. So "which op writes which surface, at what size" is a pure function of
//! the chain; it does not need the GPU, and it does not need execution to have happened. Today that
//! answer is only ever discovered *while* rendering, as the pool hands out textures, which is why
//! nothing can ask whether two ops write the same place.
//!
//! This module answers it up front. It produces the op table the coalescer will group over, and for
//! now that table is an **oracle**: nothing executes from it, it is asserted against the frame the
//! existing executor actually produces. A wrong answer here shows up as a failed assert rather than
//! as wrong pixels.
//!
//! Allocation follows the rules the plan fixed: a value lives from its producer to its last consumer
//! (A1); two values share an atlas when their rects are disjoint or their live ranges do not overlap
//! (A2); and a draw never writes the atlas it reads (A3), which is the constraint that forces a
//! colour change rather than merely a different rect.

use super::graph::Pass;
use crate::effect_graph::Src;

/// A materialised intermediate: one op's output, and the input of zero or more later ops.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ValueId(pub usize);

/// Where a value's pixels live once allocated. `atlas` is the colour; the rect is its region.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Region {
    pub atlas: usize,
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// An input to an op: either a surface the planner owns, or one it only references — the frame
/// accumulator and the source strip are produced elsewhere and outlive any single chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Input {
    Value(ValueId),
    External(usize),
}

/// One entry of the op table: a draw, before anything has been merged into it.
#[derive(Debug, Clone)]
pub struct Op {
    /// Index of the lowered pass this came from, so a predicted op can be matched against the real
    /// one when the table is checked against a frame.
    pub pass: usize,
    pub inputs: Vec<Input>,
    pub output: ValueId,
    /// Target size in device pixels, after the pass's own render scale.
    pub size: (u32, u32),
    pub scale: f32,
}

/// The interpreted chain: its ops in dependency order, and the values they produce.
#[derive(Debug, Clone, Default)]
pub struct OpTable {
    pub ops: Vec<Op>,
    /// Allocation per value, once [`OpTable::colour`] has run. Empty before that.
    pub regions: Vec<Region>,
}

/// Interpret one lowered chain into ops. `size` is the chain's full-resolution surface; a pass at
/// reduced scale takes a proportionally smaller target.
///
/// Sizing goes through [`crate::effect_graph::pass_dim`] — the same call the executor makes — rather
/// than reimplementing the arithmetic. An oracle that rounds differently from the thing it predicts
/// is worse than no oracle, and f32-vs-f64 rounding is exactly how that happens.
#[must_use]
pub fn interpret(passes: &[Pass], size: (u32, u32)) -> OpTable {
    let ops = passes
        .iter()
        .enumerate()
        .map(|(i, p)| Op {
            pass: i,
            inputs: p
                .inputs
                .iter()
                .map(|src| match src {
                    Src::Pass(j) => Input::Value(ValueId(*j)),
                    Src::Input(k) => Input::External(*k),
                })
                .collect(),
            output: ValueId(i),
            size: (
                crate::effect_graph::pass_dim(size.0, p.scale),
                crate::effect_graph::pass_dim(size.1, p.scale),
            ),
            scale: p.scale,
        })
        .collect();
    OpTable { ops, regions: Vec::new() }
}

/// Half-open live range of each value: from the op that produces it to the last op that reads it.
/// A value nothing reads still lives for its own op, so it is allocated somewhere real.
#[must_use]
pub fn live_ranges(table: &OpTable) -> Vec<(usize, usize)> {
    let mut ranges: Vec<(usize, usize)> = (0..table.ops.len()).map(|i| (i, i + 1)).collect();
    for (i, op) in table.ops.iter().enumerate() {
        for input in &op.inputs {
            if let Input::Value(ValueId(v)) = input {
                if *v < ranges.len() {
                    ranges[*v].1 = ranges[*v].1.max(i + 1);
                }
            }
        }
    }
    ranges
}

impl OpTable {
    /// Assign every value an atlas and a rect.
    ///
    /// The colouring obeys A3 — an op's target atlas differs from every atlas it reads *in that op*
    /// — which is the only hard constraint, since reading and writing one texture in a single draw
    /// has no defined ordering. Values whose live ranges do not overlap may reuse a colour freely;
    /// that is what keeps the atlas count at two for an ordinary ping-ponging chain rather than one
    /// per intermediate.
    ///
    /// Rects are stacked vertically per atlas here. Real packing is Phase 2's job; what Phase 0 has
    /// to get right is the *colour*, because that is what a coalescer would group on.
    pub fn colour(&mut self, pad: u32) {
        let mut atlas_of: Vec<usize> = vec![usize::MAX; self.ops.len()];
        let mut cursor: Vec<u32> = Vec::new();
        let mut regions = Vec::with_capacity(self.ops.len());
        for (i, op) in self.ops.iter().enumerate() {
            let reads: Vec<usize> = op
                .inputs
                .iter()
                .filter_map(|input| match input {
                    Input::Value(ValueId(v)) => atlas_of.get(*v).copied().filter(|a| *a != usize::MAX),
                    Input::External(_) => None,
                })
                .collect();
            let mut atlas = 0;
            while reads.contains(&atlas) {
                atlas += 1;
            }
            atlas_of[i] = atlas;
            if cursor.len() <= atlas {
                cursor.resize(atlas + 1, 0);
            }
            let y = cursor[atlas];
            cursor[atlas] = y + op.size.1 + pad;
            regions.push(Region { atlas, x: 0, y, w: op.size.0, h: op.size.1 });
        }
        self.regions = regions;
    }

    /// Number of distinct atlases the colouring needs.
    #[must_use]
    pub fn atlas_count(&self) -> usize {
        self.regions.iter().map(|r| r.atlas + 1).max().unwrap_or(0)
    }

    /// Every op writes an atlas it does not read (A3). The invariant a coalescer depends on.
    #[must_use]
    pub fn targets_never_alias_sources(&self) -> bool {
        self.ops.iter().enumerate().all(|(i, op)| {
            let target = self.regions[i].atlas;
            op.inputs.iter().all(|input| match input {
                Input::Value(ValueId(v)) => self.regions[*v].atlas != target,
                Input::External(_) => true,
            })
        })
    }
}

/// What a frame stage writes to. An atlas is the planner's to assign; the accumulator is the frame's
/// and outlives every chain in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Atlas,
    Accumulator,
}

/// One stage of the frame's batch schedule before its surfaces are chosen: what it reads (an earlier
/// stage's output, or a surface the plan does not own) and what kind of surface it writes.
#[derive(Debug, Clone)]
pub struct StageSpec {
    pub reads: Vec<Input>,
    pub target: Target,
}

/// Assign each stage the atlas it writes — `None` for the ones that write the accumulator.
///
/// The rule is A3 and nothing else: a stage takes the lowest atlas index it does not read *in that
/// same draw*, because reading and writing one texture in a single draw has no defined ordering.
/// Everything the batch used to hardcode falls out of it — the blur pair ping-pongs 0 → 1 because
/// the second blur reads the first, and the erase lands back in 0 because it reads only 1 — and a
/// chain that reads two live surfaces at once takes a third atlas without anyone widening a constant.
///
/// A2 needs no work here: every stage in a frame writes a rect its group owns, and two groups' rects
/// are disjoint by construction (see [`pack_groups`]), so values may share an atlas freely.
#[must_use]
pub fn colour_stages(stages: &[StageSpec]) -> Vec<Option<usize>> {
    let mut atlas_of: Vec<Option<usize>> = Vec::with_capacity(stages.len());
    for stage in stages {
        if stage.target == Target::Accumulator {
            atlas_of.push(None);
            continue;
        }
        let reads: Vec<usize> = stage
            .reads
            .iter()
            .filter_map(|r| match r {
                Input::Value(ValueId(v)) => atlas_of.get(*v).copied().flatten(),
                Input::External(_) => None,
            })
            .collect();
        let mut atlas = 0;
        while reads.contains(&atlas) {
            atlas += 1;
        }
        atlas_of.push(Some(atlas));
    }
    atlas_of
}

/// Number of distinct atlases a stage colouring needs — A4, the chromatic number, read off rather
/// than declared.
#[must_use]
pub fn atlases_needed(colours: &[Option<usize>]) -> usize {
    colours.iter().flatten().map(|a| a + 1).max().unwrap_or(0)
}

/// A2 + A5: one rect per co-located group, shelf-packed, `pad` pixels apart.
///
/// A *group* is a cell and every intermediate it owns. They all take the SAME rect, in different
/// atlases — which is what lets a stage read and write the same coordinates and is why the atlas
/// colour, not the rect, is what separates a chain's steps. Two groups get disjoint rects, so A2 is
/// satisfied for every pair regardless of live range.
///
/// A5 asks for padding at least as wide as the largest tap any consumer takes. The batch's blur
/// clamps its taps to the instance's own rect ([`super::batch`]), so a tap cannot reach a neighbour
/// whatever the gap is and the requirement is *zero*; `pad` here is slack, not correctness, and
/// exists so a sampler grazing half a texel past a cell finds transparent black rather than the next
/// cell's ink. A consumer that ever samples unclamped would have to raise it to its own reach.
#[must_use]
pub fn pack_groups(sizes: &[(u32, u32)], pad: u32, target_w: u32, max_dim: u32) -> Option<crate::atlas::Packing> {
    crate::atlas::shelf_pack(sizes, pad, target_w, max_dim)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effect_graph::Src;
    use crate::vello::graph::PassKind;

    fn blur(inputs: Vec<Src>, scale: f32) -> Pass {
        Pass { kind: PassKind::Blur { sigma: 3.0, linear: false }, inputs, scale }
    }

    /// The dataflow is already in the chain, so interpretation is a rename, not a discovery: pass i
    /// produces value i, and `Src::Pass(j)` is a read of value j.
    #[test]
    fn a_chain_interprets_to_one_op_per_pass() {
        let t = interpret(
            &[blur(vec![Src::Input(0)], 1.0), blur(vec![Src::Pass(0)], 1.0)],
            (256, 256),
        );
        assert_eq!(t.ops.len(), 2);
        assert_eq!(t.ops[0].inputs, vec![Input::External(0)]);
        assert_eq!(t.ops[1].inputs, vec![Input::Value(ValueId(0))]);
        assert_eq!(t.ops[1].output, ValueId(1));
    }

    /// A reduced-scale pass takes a proportionally smaller target — the same sizing the executor
    /// allocates, which is what makes the predicted table checkable against a real frame.
    #[test]
    fn a_reduced_pass_takes_a_smaller_target() {
        let t = interpret(&[blur(vec![Src::Input(0)], 0.5)], (256, 200));
        assert_eq!(t.ops[0].size, (128, 100));
    }

    /// A2/A3: consecutive ops must not share a colour, but the third is free to reuse the first's.
    /// This is the ping-pong the existing code hardcodes as Atlas(0)/Atlas(1), arrived at by rule.
    #[test]
    fn a_linear_chain_ping_pongs_between_two_atlases() {
        let mut t = interpret(
            &[
                blur(vec![Src::Input(0)], 1.0),
                blur(vec![Src::Pass(0)], 1.0),
                blur(vec![Src::Pass(1)], 1.0),
                blur(vec![Src::Pass(2)], 1.0),
            ],
            (64, 64),
        );
        t.colour(0);
        let atlases: Vec<usize> = t.regions.iter().map(|r| r.atlas).collect();
        assert_eq!(atlases, vec![0, 1, 0, 1]);
        assert_eq!(t.atlas_count(), 2);
        assert!(t.targets_never_alias_sources());
    }

    /// An op reading two live values needs a colour distinct from BOTH — the inner shadow's erase,
    /// which reads its tinted band and its blurred punch at once.
    #[test]
    fn an_op_reading_two_values_avoids_both_their_atlases() {
        let mut t = interpret(
            &[
                blur(vec![Src::Input(0)], 1.0),
                blur(vec![Src::Pass(0)], 1.0),
                blur(vec![Src::Pass(0), Src::Pass(1)], 1.0),
            ],
            (64, 64),
        );
        t.colour(0);
        let a: Vec<usize> = t.regions.iter().map(|r| r.atlas).collect();
        assert_eq!(a, vec![0, 1, 2]);
        assert!(t.targets_never_alias_sources());
    }

    /// A1: a value lives until its LAST reader, not its first.
    #[test]
    fn a_value_lives_until_its_last_reader() {
        let t = interpret(
            &[
                blur(vec![Src::Input(0)], 1.0),
                blur(vec![Src::Pass(0)], 1.0),
                blur(vec![Src::Pass(0)], 1.0),
            ],
            (64, 64),
        );
        let r = live_ranges(&t);
        assert_eq!(r[0], (0, 3), "value 0 is read by op 2");
        assert_eq!(r[1], (1, 2), "value 1 is read by nobody and lives for its own op");
    }

    /// External inputs — the accumulator, the source strip — are referenced, never allocated, so
    /// they place no constraint on colouring beyond not being values.
    #[test]
    fn external_inputs_are_not_allocated() {
        let mut t = interpret(&[blur(vec![Src::Input(0), Src::Input(1)], 1.0)], (64, 64));
        t.colour(0);
        assert_eq!(t.regions.len(), 1, "one op, one allocated value");
        assert_eq!(t.regions[0].atlas, 0);
        assert!(t.targets_never_alias_sources());
    }
}

#[cfg(test)]
mod frame_allocation_tests {
    use super::*;

    fn atlas(reads: Vec<Input>) -> StageSpec {
        StageSpec { reads, target: Target::Atlas }
    }

    /// The whole-viewport batch's surface assignment used to be four constants: blur-H to atlas 0,
    /// blur-V to atlas 1, the erase back to 0, and the composite reading 1 and 0. Every one of them
    /// is A3 applied to what the stage reads — so the constants can go.
    #[test]
    fn the_batch_ping_pong_falls_out_of_a3() {
        let colours = colour_stages(&[
            atlas(vec![Input::External(0)]),
            atlas(vec![Input::Value(ValueId(0))]),
            atlas(vec![Input::Value(ValueId(1)), Input::Value(ValueId(1))]),
            StageSpec {
                reads: vec![Input::Value(ValueId(1)), Input::Value(ValueId(2))],
                target: Target::Accumulator,
            },
        ]);
        assert_eq!(colours, vec![Some(0), Some(1), Some(0), None]);
        assert_eq!(atlases_needed(&colours), 2);
    }

    /// A stage reading two surfaces that live in different atlases cannot write either — the third
    /// atlas appears on its own, which is what a hardcoded ping-pong could never do.
    #[test]
    fn a_stage_reading_two_live_atlases_takes_a_third() {
        let colours = colour_stages(&[
            atlas(vec![Input::External(0)]),
            atlas(vec![Input::Value(ValueId(0))]),
            atlas(vec![Input::Value(ValueId(0)), Input::Value(ValueId(1))]),
        ]);
        assert_eq!(colours, vec![Some(0), Some(1), Some(2)]);
        assert_eq!(atlases_needed(&colours), 3);
    }

    /// Reading only surfaces the plan does not own constrains nothing: the accumulator and the
    /// source strip are never a stage's target, so a stage that reads them starts back at atlas 0.
    #[test]
    fn external_reads_do_not_consume_a_colour() {
        let colours = colour_stages(&[atlas(vec![Input::External(0), Input::External(1)])]);
        assert_eq!(colours, vec![Some(0)]);
    }

    /// A2 by construction: distinct groups never share a rect, so nothing has to reason about live
    /// ranges to let them share an atlas.
    #[test]
    fn packed_groups_get_disjoint_rects() {
        let p = pack_groups(&[(64, 32), (64, 32), (900, 40)], 4, 200, 4096).expect("packs");
        for (i, a) in p.cells.iter().enumerate() {
            for b in &p.cells[i + 1..] {
                let apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
                assert!(apart, "groups {a:?} and {b:?} overlap");
            }
        }
    }
}
