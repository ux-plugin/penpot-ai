//! Frame executor — the dumb VM half of the plan/execute split.
//!
//! The scheduler ([`crate::vello::frame_dag`]) decides everything: the ops, their rounds, the barriers,
//! and — via [`crate::vello::plan::colour_stages`] — which atlas each scratch value lives in. This
//! module lowers that decision into a flat [`Program`]: a list of rounds, each a list of [`Step`]s with
//! their surfaces already resolved to `acc` or `atlasN`. The VM decides NOTHING — it walks the program
//! top to bottom, and the one thing left is the per-op wgpu dispatch (see [`Program::describe`] for the
//! command stream it stands in for; the live dispatch is the pixel-gated seam, wired against a device).

use crate::vello::frame_dag::{Barrier, FrameDag, Op, Schedule};

/// A surface a step reads or writes — the frame accumulator (the spine) or one scratch atlas.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Surface {
    Accumulator,
    Atlas(usize),
}

/// One instruction: run `op` for source node `node`, reading `reads`, writing `write`.
#[derive(Clone, Debug)]
pub struct Step {
    pub node: usize,
    pub op: Op,
    pub reads: Vec<Surface>,
    pub write: Surface,
}

/// One dispatch: the barrier that opens it (`None` for round 0), then its steps. Every step in a round
/// is independent of the others in it — they can batch — and the whole round composites in one pass.
#[derive(Clone, Debug)]
pub struct Round {
    pub barrier: Option<Barrier>,
    pub steps: Vec<Step>,
}

/// The executable program: the schedule with every surface resolved. A wgpu loop is exactly
/// `for round in rounds { insert round.barrier; for step in round.steps { dispatch step } }`.
#[derive(Clone, Debug, Default)]
pub struct Program {
    pub rounds: Vec<Round>,
}

/// Lower a scheduled frame graph to its program. `colours` is [`crate::vello::plan::colour_stages`] of
/// [`FrameDag::to_stage_specs`] — the atlas each scratch value takes; a spine node has `None` and
/// writes the accumulator.
#[must_use]
pub fn lower(dag: &FrameDag, sched: &Schedule, colours: &[Option<usize>]) -> Program {
    let surface_of = |i: usize| -> Surface {
        match colours[i] {
            Some(a) => Surface::Atlas(a),
            None => Surface::Accumulator,
        }
    };
    let n_rounds = sched.rounds() as usize;
    let mut rounds: Vec<Round> = (0..n_rounds).map(|_| Round { barrier: None, steps: Vec::new() }).collect();
    for (i, node) in dag.nodes.iter().enumerate() {
        let r = sched.round[i] as usize;
        // Distinct read surfaces: the many accumulator inputs collapse to one `acc` read.
        let mut reads: Vec<Surface> = Vec::new();
        for &j in &node.inputs {
            let s = surface_of(j);
            if !reads.contains(&s) {
                reads.push(s);
            }
        }
        rounds[r].steps.push(Step { node: i, op: node.op, reads, write: surface_of(i) });
        if rounds[r].barrier.is_none() {
            rounds[r].barrier = sched.barrier[i];
        }
    }
    Program { rounds }
}

impl Program {
    /// Total dispatched steps — should equal the node count.
    #[must_use]
    pub fn step_count(&self) -> usize {
        self.rounds.iter().map(|r| r.steps.len()).sum()
    }

    /// A human-readable rendering of the command stream, for the dev dump — the barriers and dispatches
    /// a wgpu encoder would emit, one line per operation.
    #[must_use]
    pub fn describe(&self) -> String {
        let surf = |s: &Surface| match s {
            Surface::Accumulator => "acc".to_string(),
            Surface::Atlas(a) => format!("atlas{a}"),
        };
        let mut out = String::new();
        for (r, round) in self.rounds.iter().enumerate() {
            if let Some(b) = round.barrier {
                out.push_str(&format!("-- barrier: {b:?}\n"));
            }
            out.push_str(&format!("round {r}:\n"));
            for st in &round.steps {
                let reads = st.reads.iter().map(surf).collect::<Vec<_>>().join(",");
                out.push_str(&format!(
                    "  {:>6} <- [{reads}]   {:?}   (n{})\n",
                    surf(&st.write),
                    st.op,
                    st.node,
                ));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vello::frame_dag::{build_frame_dag_installed, TILE_PX};
    use crate::vello::plan::colour_stages;

    fn program_for(load: impl FnOnce()) -> (FrameDag, Program) {
        load();
        let dag = build_frame_dag_installed();
        let sched = dag.schedule(TILE_PX);
        let colours = colour_stages(&dag.to_stage_specs());
        let prog = lower(&dag, &sched, &colours);
        (dag, prog)
    }

    /// The program is a faithful, well-formed lowering: one step per node, rounds match the schedule,
    /// a value is written before it is read, and a spine step writes the accumulator.
    #[test]
    fn program_is_well_formed() {
        let (dag, prog) = program_for(|| {
            crate::vello::abi::load_combined_scene();
        });

        assert_eq!(prog.step_count(), dag.nodes.len(), "one step per node");

        // Where each node's output ends up, by walking the program.
        let mut written: Vec<Option<Surface>> = vec![None; dag.nodes.len()];
        for (r, round) in prog.rounds.iter().enumerate() {
            for st in &round.steps {
                // A spine node writes the accumulator; a scratch node writes an atlas.
                if dag.nodes[st.node].writes_accumulator() {
                    assert_eq!(st.write, Surface::Accumulator);
                } else {
                    assert!(matches!(st.write, Surface::Atlas(_)));
                }
                // Every input was produced in an earlier-or-equal round (topological in time).
                for &j in &dag.nodes[st.node].inputs {
                    let jr = prog
                        .rounds
                        .iter()
                        .position(|rd| rd.steps.iter().any(|s| s.node == j))
                        .expect("input scheduled");
                    assert!(jr <= r, "node {} reads n{j} from a later round", st.node);
                }
                written[st.node] = Some(st.write);
            }
        }
        assert!(written.iter().all(Option::is_some), "every node emitted a step");
    }

    /// Both glass layers reload the backdrop, and the program stays within the two atlases the
    /// allocator coloured. Note the two glass blobs are *disjoint*, so region-split parks both reloads
    /// in ONE round (parallel) — there are two reload *ops*, but only one reload *barrier*.
    #[test]
    fn glass_program_reloads_and_stays_within_two_atlases() {
        let (_dag, prog) = program_for(|| {
            crate::vello::abi::load_stack_glass_scene(2, 0);
        });

        let reload_ops =
            prog.rounds.iter().flat_map(|r| &r.steps).filter(|s| s.op == Op::Reload).count();
        assert_eq!(reload_ops, 2, "two glass layers → two reload ops");
        let reload_rounds =
            prog.rounds.iter().filter(|r| r.barrier == Some(Barrier::Reload)).count();
        assert_eq!(reload_rounds, 1, "disjoint glass → the reloads share one round");

        let max_atlas = prog
            .rounds
            .iter()
            .flat_map(|r| &r.steps)
            .filter_map(|s| match s.write {
                Surface::Atlas(a) => Some(a),
                Surface::Accumulator => None,
            })
            .max()
            .unwrap_or(0);
        assert!(max_atlas <= 1, "the program uses at most two atlases (got {})", max_atlas + 1);
    }
}
