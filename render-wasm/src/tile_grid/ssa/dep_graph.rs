//! Step-level dependency graph + topological sort.
//!
//! Generalizes the legacy `build_dependency_graph` (which operated on
//! band nodes) to step nodes. Edges:
//!
//! - **Producer → consumer.** A step that writes `R` precedes every
//!   step that reads `R`. This is the only edge kind needed in the
//!   pure-SSA case because each `R` has exactly one producer.
//! - **Composite chain.** Because `Composite` rewrites `to` (relaxed
//!   SSA for `Target` and read-modify-write for everything else), the
//!   *previous* composite into `to` must precede the next one. Each
//!   composite reads the prior composite's output.
//! - **Tile-output ordering.** `WriteTileCache(from, tile)` for a
//!   given tile must follow every step that contributes to `from`'s
//!   final pixels. Producer→consumer edges already enforce this
//!   transitively; no extra constraint needed.
//!
//! The schedule builder constructs steps in a natural order (parent
//! before child, source tile before consumer tile) that's already
//! topologically valid. This module's purpose is twofold:
//!
//! 1. **Verification** — confirm the natural order satisfies the deps,
//!    catching schedule-builder bugs early.
//! 2. **Reordering for parallelism** — when the dispatcher gains async
//!    tile interleaving (Step 3 tuning), this graph drives the work-
//!    stealing scheduler.

use rustc_hash::FxHashMap;

use super::step::Step;
use super::surface_ref::SurfaceRef;

/// Adjacency list. `edges[from]` is the list of step indices that
/// depend on step `from` finishing.
#[derive(Debug, Default)]
pub struct DepGraph {
    pub edges: FxHashMap<usize, Vec<usize>>,
    pub in_degree: FxHashMap<usize, usize>,
    pub node_count: usize,
}

impl DepGraph {
    /// Build the producer→consumer graph from a schedule.
    pub fn build(schedule: &[Step]) -> Self {
        let mut graph = DepGraph {
            edges: FxHashMap::default(),
            in_degree: FxHashMap::default(),
            node_count: schedule.len(),
        };

        // Map each ref to its producer step index. For Target (relaxed
        // SSA), we map to the *latest* producer seen so far — that's
        // the "current value" reads should depend on.
        let mut latest_producer: FxHashMap<SurfaceRef, usize> = FxHashMap::default();

        for idx in 0..schedule.len() {
            graph.in_degree.insert(idx, 0);
        }

        for (idx, step) in schedule.iter().enumerate() {
            // Read dependencies: each ref read must have a producer.
            for r in step.reads() {
                if let Some(&producer) = latest_producer.get(&r) {
                    if producer != idx {
                        graph.add_edge(producer, idx);
                    }
                }
            }
            // Rewrite dependencies: a step that rewrites `R` reads
            // the prior producer of `R` (the existing pixels) AND
            // becomes the new producer.
            for r in step.rewrites() {
                if let Some(&producer) = latest_producer.get(&r) {
                    if producer != idx {
                        graph.add_edge(producer, idx);
                    }
                }
                latest_producer.insert(r, idx);
            }
            // Fresh writes set the new producer for `R`.
            for r in step.writes() {
                latest_producer.insert(r, idx);
            }
            // Kills update the producer map: nothing produces `R`
            // anymore until a fresh write.
            for r in step.kills() {
                latest_producer.remove(&r);
            }
        }

        graph
    }

    fn add_edge(&mut self, from: usize, to: usize) {
        // De-duplicate: a single step may read the same ref via
        // multiple operands (e.g. ComposeBackdrop's read_from list).
        let entry = self.edges.entry(from).or_default();
        if !entry.contains(&to) {
            entry.push(to);
            *self.in_degree.entry(to).or_insert(0) += 1;
        }
    }

    /// True if `schedule[..]` is topologically consistent with this
    /// graph. The schedule builder emits steps in natural order, so
    /// this should always be true — used as a debug-build sanity check.
    pub fn is_topologically_valid(&self, _schedule_len: usize) -> bool {
        // For every edge `from → to`, `from < to` must hold (since the
        // schedule walks in order). Verify.
        for (from, tos) in &self.edges {
            for to in tos {
                if from >= to {
                    return false;
                }
            }
        }
        true
    }

    /// Kahn's algorithm. Returns a topological order. For schedules
    /// emitted by `ScheduleBuilder` this should match the natural
    /// order; reordering is for the future async dispatcher.
    pub fn topological_sort(&self) -> Vec<usize> {
        let mut in_degree = self.in_degree.clone();
        let mut queue: std::collections::VecDeque<usize> = (0..self.node_count)
            .filter(|i| *in_degree.get(i).unwrap_or(&0) == 0)
            .collect();
        let mut out = Vec::with_capacity(self.node_count);

        while let Some(idx) = queue.pop_front() {
            out.push(idx);
            if let Some(successors) = self.edges.get(&idx) {
                for &succ in successors {
                    let d = in_degree.entry(succ).or_insert(0);
                    *d = d.saturating_sub(1);
                    if *d == 0 {
                        queue.push_back(succ);
                    }
                }
            }
        }

        out
    }

    /// True if the graph is acyclic. A cycle would indicate a schedule-
    /// builder bug — `Snapshot` reads of self, `Composite` into a
    /// surface it reads from in a way the SSA validator missed.
    pub fn is_acyclic(&self) -> bool {
        self.topological_sort().len() == self.node_count
    }
}
