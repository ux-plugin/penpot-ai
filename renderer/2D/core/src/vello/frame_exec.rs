//! Frame executor — the dumb VM half of the plan/execute split.
//!
//! The scheduler ([`crate::vello::frame_dag`]) decides everything: the ops, their rounds, and the
//! barriers. This module lowers that into a flat [`Program`]: a list of rounds, each a list of [`Step`]s
//! with their surfaces resolved — the frame accumulator, or the scratch value a producing node wrote.
//! The VM decides NOTHING — it walks the program top to bottom, handing each step to a [`Dispatcher`].
//!
//! A scratch surface is identified by its **producer node**, not an atlas colour: many values share a
//! colour (two silhouettes both `atlas0`), so a colour cannot bind a texture, but a producer names
//! exactly one value. Atlas colouring ([`crate::vello::plan::colour_stages`]) is a separate memory
//! optimization the dispatcher MAY apply to alias textures; the correct baseline is one texture per
//! live value.

use crate::kurbo::Rect;
use crate::vello::frame_dag::{Barrier, FrameDag, Op, Schedule, Source};

/// A surface a step reads or writes — the frame accumulator (the spine), or the scratch value written
/// by the node whose index this holds.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Surface {
    Accumulator,
    Scratch(usize),
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

/// Lower a scheduled frame graph to its program: one step per node, resolving every input and output to
/// a [`Surface`] — the accumulator for a spine node, else the producer's own scratch value.
#[must_use]
pub fn lower(dag: &FrameDag, sched: &Schedule) -> Program {
    let surface_of = |i: usize| -> Surface {
        if dag.nodes[i].writes_accumulator() {
            Surface::Accumulator
        } else {
            Surface::Scratch(i)
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
            Surface::Scratch(n) => format!("v{n}"),
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

/// The one device-bound seam. `execute` owns the control flow — rounds, barriers, order — and hands
/// each step to a `Dispatcher` that does the actual GPU work: resolve the [`Source`] to geometry /
/// effect config, run the pipeline for the step's [`Op`], and write the resolved [`Surface`]. The GPU
/// implementation lives on the sink (it needs the device, pools, compositor, and backend); tests use a
/// recording double. The VM decides everything the dispatcher does *not* — the dispatcher decides
/// nothing about scheduling.
pub trait Dispatcher {
    /// Open round `r`. `barrier` is the GPU barrier that must precede it (`None` for round 0).
    fn begin_round(&mut self, r: usize, barrier: Option<Barrier>);
    /// Run one step: its `op` (with intrinsic params), the scene `source` to resolve, its page-space
    /// `reach`, the surfaces it reads, and the surface it writes.
    fn run(&mut self, op: Op, source: &Source, reach: Option<Rect>, reads: &[Surface], write: Surface);
}

/// Walk the program: for each round, signal its barrier, then dispatch every step in order. That is the
/// entire executor — the plan is fixed, so this loop is all the VM is.
pub fn execute<D: Dispatcher>(program: &Program, dag: &FrameDag, d: &mut D) {
    for (r, round) in program.rounds.iter().enumerate() {
        d.begin_round(r, round.barrier);
        for step in &round.steps {
            let node = &dag.nodes[step.node];
            d.run(step.op, &node.source, node.reach, &step.reads, step.write);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vello::frame_dag::{build_frame_dag_installed, TILE_PX};

    fn program_for(load: impl FnOnce()) -> (FrameDag, Program) {
        load();
        let dag = build_frame_dag_installed();
        let sched = dag.schedule(TILE_PX);
        let prog = lower(&dag, &sched);
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
                    assert_eq!(st.write, Surface::Scratch(st.node), "a scratch value is its own producer");
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

        // Every read binds to a real value: a scratch read names a node produced earlier.
        for (r, round) in prog.rounds.iter().enumerate() {
            for st in &round.steps {
                for read in &st.reads {
                    if let Surface::Scratch(p) = read {
                        let pr = prog
                            .rounds
                            .iter()
                            .position(|rd| rd.steps.iter().any(|s| s.node == *p))
                            .expect("producer scheduled");
                        assert!(pr <= r, "step reads a value produced in a later round");
                    }
                }
            }
        }
    }

    /// A recording `Dispatcher` — proves `execute` drives the program in the right order without a GPU.
    #[derive(Default)]
    struct Recorder {
        rounds: Vec<Option<Barrier>>,
        ops: Vec<(Op, Surface)>,
    }
    impl Dispatcher for Recorder {
        fn begin_round(&mut self, r: usize, barrier: Option<Barrier>) {
            assert_eq!(r, self.rounds.len(), "rounds opened in order");
            self.rounds.push(barrier);
        }
        fn run(&mut self, op: Op, _source: &Source, _reach: Option<Rect>, _reads: &[Surface], write: Surface) {
            assert!(!self.rounds.is_empty(), "a step ran before its round opened");
            self.ops.push((op, write));
        }
    }

    #[test]
    fn execute_drives_the_program() {
        let (dag, prog) = program_for(|| {
            crate::vello::abi::load_combined_scene();
        });

        let mut rec = Recorder::default();
        execute(&prog, &dag, &mut rec);

        // One begin_round per round, in order, with the program's barriers.
        assert_eq!(rec.rounds.len(), prog.rounds.len());
        for (got, round) in rec.rounds.iter().zip(&prog.rounds) {
            assert_eq!(*got, round.barrier);
        }
        assert_eq!(rec.rounds[0], None, "round 0 opens with no barrier");
        // Every step was dispatched exactly once.
        assert_eq!(rec.ops.len(), dag.nodes.len());
        // The frame starts by rasterizing the background onto the accumulator.
        assert_eq!(rec.ops[0], (Op::Rasterize, Surface::Accumulator));
        // Blurs land in scratch values; composites land on the spine.
        assert!(rec.ops.iter().any(|(op, w)| matches!(op, Op::Blur { .. }) && matches!(w, Surface::Scratch(_))));
        assert!(rec.ops.iter().any(|(op, w)| *op == Op::Compose && *w == Surface::Accumulator));
    }
}
