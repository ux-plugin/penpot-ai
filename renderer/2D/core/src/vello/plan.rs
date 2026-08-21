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
/// reduced scale takes a proportionally smaller target, matching what the executor allocates.
#[must_use]
pub fn interpret(passes: &[Pass], size: (u32, u32)) -> OpTable {
    let dim = |v: u32, s: f32| ((v as f32 * s).round().max(1.0)) as u32;
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
            size: (dim(size.0, p.scale), dim(size.1, p.scale)),
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
