//! **Frame allocation**: where the surfaces a frame's stages read and write actually live.
//!
//! A lowered chain already carries its dataflow — every [`crate::vello::graph::Pass`] names its
//! inputs as [`Src::Input`] / [`Src::Pass`] — so "which stage writes which surface" is a pure
//! function of the chain. It does not need the GPU, and it does not need execution to have
//! happened. It used to be discovered only *while* rendering, as the pool handed out textures,
//! which is why nothing could ask whether two stages wrote the same place.
//!
//! Allocation follows the rules the plan fixed: a value lives from its producer to its last consumer
//! (A1); two values share an atlas when their rects are disjoint or their live ranges do not overlap
//! (A2); a draw never writes the atlas it reads (A3), which is the constraint that forces a colour
//! change rather than merely a different rect; the atlas count is the chromatic number (A4); and the
//! padding is the largest consumer's tap radius (A5).
//!
//! This module carried a second, larger half: an `interpret`/`OpTable` oracle that predicted the
//! frame and was asserted against it. The assertion it ended up making was tautological — it
//! compared `pass_dim(w, scale)` against an op table that computes `pass_dim(w, scale)` — so it
//! proved nothing and cost an O(n²) re-interpretation per pass. Its real job, planning the frame
//! rather than predicting it, belongs to the executor's own table, not to a shadow of one.


/// A materialised intermediate: one op's output, and the input of zero or more later ops.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ValueId(pub usize);

/// An input to a stage: either a surface the planner owns, or one it only references — the frame
/// accumulator and the source strip are produced elsewhere and outlive any single chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Input {
    Value(ValueId),
    External(usize),
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
