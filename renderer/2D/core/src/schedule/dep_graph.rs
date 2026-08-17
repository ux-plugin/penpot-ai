//! Step-level dependency graph + topological sort.
//!
//! Ported from render-wasm's `tile_grid/ssa/dep_graph.rs`. Edges are producer→consumer: a step that
//! writes a `SurfaceRef` precedes every step that reads it. Its two jobs:
//!
//! 1. **Verification** — confirm the builder's natural (parent-before-child, producer-before-
//!    consumer) order satisfies the dependencies, catching builder bugs early.
//! 2. **Reordering for parallelism** — later, drive a work-stealing dispatcher.

use std::collections::HashMap;

use super::step::Step;
use super::surface_ref::SurfaceRef;

/// Adjacency list. `edges[from]` lists the step indices that depend on step `from` finishing.
#[derive(Debug, Default)]
pub struct DepGraph {
    pub edges: HashMap<usize, Vec<usize>>,
    pub in_degree: HashMap<usize, usize>,
    pub node_count: usize,
}

impl DepGraph {
    /// Build the producer→consumer graph from a schedule.
    #[must_use]
    pub fn build(schedule: &[Step]) -> Self {
        let mut graph = DepGraph {
            edges: HashMap::new(),
            in_degree: HashMap::new(),
            node_count: schedule.len(),
        };
        for idx in 0..schedule.len() {
            graph.in_degree.insert(idx, 0);
        }

        // Latest producer of each ref. For relaxed-SSA rewrites (`Target`, layer brackets) this is
        // the "current value" a read should depend on.
        let mut latest_producer: HashMap<SurfaceRef, usize> = HashMap::new();

        for (idx, step) in schedule.iter().enumerate() {
            for r in step.reads() {
                if let Some(&producer) = latest_producer.get(&r) {
                    if producer != idx {
                        graph.add_edge(producer, idx);
                    }
                }
            }
            for r in step.rewrites() {
                if let Some(&producer) = latest_producer.get(&r) {
                    if producer != idx {
                        graph.add_edge(producer, idx);
                    }
                }
                latest_producer.insert(r, idx);
            }
            for r in step.writes() {
                latest_producer.insert(r, idx);
            }
            for r in step.kills() {
                latest_producer.remove(&r);
            }
        }
        graph
    }

    fn add_edge(&mut self, from: usize, to: usize) {
        let entry = self.edges.entry(from).or_default();
        if !entry.contains(&to) {
            entry.push(to);
            *self.in_degree.entry(to).or_insert(0) += 1;
        }
    }

    /// True if every edge `from → to` has `from < to` — i.e. the schedule's natural order already
    /// satisfies the dependencies. The builder emits in dependency order, so this should hold.
    #[must_use]
    pub fn is_topologically_valid(&self) -> bool {
        self.edges
            .iter()
            .all(|(from, tos)| tos.iter().all(|to| from < to))
    }

    /// Kahn's algorithm — a topological order.
    #[must_use]
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

    /// A cycle would mean a builder bug (e.g. a `Composite` into a surface it also reads in a way the
    /// validator missed).
    #[must_use]
    pub fn is_acyclic(&self) -> bool {
        self.topological_sort().len() == self.node_count
    }
}
