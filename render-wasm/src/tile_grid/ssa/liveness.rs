//! Backward liveness pass — derives implicit `EraseSurface` markers.
//!
//! The schedule builder emits explicit `EraseSurface`s sparingly (only
//! where the surface needs to die mid-schedule for correctness). For
//! the common case where a surface dies at its last natural read,
//! the liveness pass walks backward and records the kill point.
//!
//! The dispatcher uses this output to call `SurfaceMap::release` at
//! the right step boundaries — extending pool retention as far as
//! possible without growing concurrent demand.
//!
//! Per-tile scope (per the SSA IR design) means liveness analysis is
//! strictly per-tile. The pass is O(N) in schedule length: one forward
//! sweep building producer/last-use, no fixpoint needed because SSA
//! guarantees no value is reborn.

use rustc_hash::FxHashMap;

use super::step::Step;
use super::surface_ref::SurfaceRef;

/// One liveness interval per `SurfaceRef`. `first_def` is the step
/// index that produced the value; `last_use` is the last step that
/// reads or rewrites it (inclusive). `kill_after` is the step index
/// after which the dispatcher should release the binding — equal to
/// `last_use` for naturally-dying refs, or the explicit
/// `EraseSurface`/`erase_after` step otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiveInterval {
    pub first_def: usize,
    pub last_use: usize,
    pub kill_after: usize,
    /// `true` if the kill point came from an explicit `EraseSurface`
    /// or `Composite { erase_after: true }` in the schedule, `false`
    /// if it was derived from last-use.
    pub explicit_kill: bool,
}

/// Per-`SurfaceRef` liveness data the dispatcher consumes.
#[derive(Debug, Default)]
pub struct LivenessPass {
    pub intervals: FxHashMap<SurfaceRef, LiveInterval>,
    /// Step → list of refs the dispatcher should release after that
    /// step completes. Derived from `intervals.kill_after`. Pre-built
    /// so the dispatcher's hot loop doesn't have to re-derive.
    pub releases_after: FxHashMap<usize, Vec<SurfaceRef>>,
}

impl LivenessPass {
    pub fn run(schedule: &[Step]) -> Self {
        let mut intervals: FxHashMap<SurfaceRef, LiveInterval> = FxHashMap::default();

        // Forward sweep: record def, update last_use, capture explicit kills.
        for (idx, step) in schedule.iter().enumerate() {
            for r in step.writes() {
                intervals.entry(r).or_insert(LiveInterval {
                    first_def: idx,
                    last_use: idx,
                    kill_after: idx,
                    explicit_kill: false,
                });
            }
            for r in step.rewrites() {
                let e = intervals.entry(r).or_insert(LiveInterval {
                    first_def: idx,
                    last_use: idx,
                    kill_after: idx,
                    explicit_kill: false,
                });
                if idx > e.last_use {
                    e.last_use = idx;
                    e.kill_after = idx;
                }
            }
            for r in step.reads() {
                let e = intervals.entry(r).or_insert(LiveInterval {
                    // Defensive default: should never happen if the
                    // validator passed (define-before-use), but
                    // tolerate by recording the read as a def too.
                    first_def: idx,
                    last_use: idx,
                    kill_after: idx,
                    explicit_kill: false,
                });
                if idx > e.last_use {
                    e.last_use = idx;
                    if !e.explicit_kill {
                        e.kill_after = idx;
                    }
                }
            }
            for r in step.kills() {
                let e = intervals.entry(r).or_insert(LiveInterval {
                    first_def: idx,
                    last_use: idx,
                    kill_after: idx,
                    explicit_kill: true,
                });
                e.kill_after = idx;
                e.explicit_kill = true;
            }
        }

        // Bucket releases by `kill_after`.
        let mut releases_after: FxHashMap<usize, Vec<SurfaceRef>> = FxHashMap::default();
        for (r, interval) in &intervals {
            releases_after
                .entry(interval.kill_after)
                .or_default()
                .push(*r);
        }

        // Deterministic order inside each bucket — helps tests/diff.
        for refs in releases_after.values_mut() {
            refs.sort_by(|a, b| {
                format!("{:?}", a).cmp(&format!("{:?}", b))
            });
        }

        LivenessPass {
            intervals,
            releases_after,
        }
    }

    /// Refs the dispatcher should release after running `step_idx`.
    /// Returns empty slice if none.
    pub fn releases_at(&self, step_idx: usize) -> &[SurfaceRef] {
        self.releases_after
            .get(&step_idx)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    /// True if `r` is live at `step_idx` (i.e. produced, not yet
    /// killed). Used by tests and by allocator-pressure dashboards.
    pub fn is_live(&self, r: SurfaceRef, step_idx: usize) -> bool {
        if let Some(i) = self.intervals.get(&r) {
            i.first_def <= step_idx && step_idx <= i.kill_after
        } else {
            false
        }
    }

    /// Peak concurrent live refs across the schedule. Useful for
    /// allocator pool-cap tuning.
    pub fn peak_concurrent_live(&self, schedule_len: usize) -> usize {
        let mut deltas: Vec<i32> = vec![0; schedule_len + 1];
        for interval in self.intervals.values() {
            deltas[interval.first_def] += 1;
            // kill_after is the last step where the ref is live, so
            // it's released *after* kill_after — i.e. at kill_after+1.
            let kill_slot = interval.kill_after + 1;
            if kill_slot < deltas.len() {
                deltas[kill_slot] -= 1;
            }
        }
        let mut peak = 0i32;
        let mut current = 0i32;
        for d in deltas {
            current += d;
            if current > peak {
                peak = current;
            }
        }
        peak as usize
    }
}
