//! SSA invariant checker for IR schedules.
//!
//! Runs in debug builds as the schedule comes off `ScheduleBuilder` and
//! again as the dispatcher consumes it. Designed to catch logic bugs in
//! the schedule emitter early — production builds skip the checks
//! entirely.
//!
//! Invariants enforced:
//!
//! 1. **Define-before-use** — every `reads()` operand has a preceding
//!    producer (a `writes()` / `rewrites()` step, or a prior accumulation
//!    Paint for `ScopeOf` / `TileOutput` refs).
//! 2. **No use-after-erase** — once a `SurfaceRef` is killed (explicit
//!    `EraseSurface` or `Composite { erase_after: true }`), no later
//!    step may read or rewrite it.
//! 3. **Composite target is live** — `Composite { to, .. }` must have
//!    a producer (or be `Target`).
//! 4. **Non-Target writes have a consumer** — a `SurfaceRef` that's
//!    only ever produced but never read or composited away is dead
//!    code; the validator flags it. Exception: `TileOutput` (consumed
//!    by `WriteTileCache`) and `Target` (the canvas presents it).
//! 5. **Tile present where required** — `Target` may have `tile = None`;
//!    every other role must carry a `Some(tile)`.
//!
//! The "single producer" rule has been relaxed: `ScopeOf`, `TileOutput`,
//! and `Target` are paint-accumulation roles — multiple `Paint` /
//! `PaintGather` steps painting into the same ref is the renderer's
//! natural mode (each shape adds to the surface, building up the
//! per-tile pixel content). Cross-frame state (`Snapshot`, `Backdrop`,
//! `RasterEffectOutput`) keeps the strict single-producer discipline
//! since those refs identify a specific captured value, not an
//! accumulating drawing surface.

use rustc_hash::{FxHashMap, FxHashSet};
use std::fmt;

use super::step::Step;
use super::surface_ref::{SurfaceRef, SurfaceRole};

/// What an invariant failure looks like. Each variant carries enough
/// context to localize the bug — step index, the offending ref, what
/// went wrong.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationError {
    DuplicateProducer {
        first_step: usize,
        duplicate_step: usize,
        surface: SurfaceRef,
    },
    UseBeforeDefine {
        step: usize,
        surface: SurfaceRef,
    },
    UseAfterErase {
        erase_step: usize,
        use_step: usize,
        surface: SurfaceRef,
    },
    CompositeTargetUndefined {
        step: usize,
        target: SurfaceRef,
    },
    UnconsumedSurface {
        producer_step: usize,
        surface: SurfaceRef,
    },
    MissingTile {
        step: usize,
        surface: SurfaceRef,
    },
    /// `Target` is the only ref allowed to have multiple producers
    /// (via `Composite { to: Target, ... }`). Any other ref hit by
    /// the relaxed-SSA path is a bug.
    DisallowedRewrite {
        step: usize,
        surface: SurfaceRef,
    },
}

impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ValidationError::DuplicateProducer {
                first_step,
                duplicate_step,
                surface,
            } => write!(
                f,
                "duplicate producer for {:?}: first at step {}, second at step {}",
                surface, first_step, duplicate_step
            ),
            ValidationError::UseBeforeDefine { step, surface } => write!(
                f,
                "step {} reads {:?} before it's defined",
                step, surface
            ),
            ValidationError::UseAfterErase {
                erase_step,
                use_step,
                surface,
            } => write!(
                f,
                "step {} uses {:?} after it was erased at step {}",
                use_step, surface, erase_step
            ),
            ValidationError::CompositeTargetUndefined { step, target } => write!(
                f,
                "step {} composites into {:?} which has no producer",
                step, target
            ),
            ValidationError::UnconsumedSurface {
                producer_step,
                surface,
            } => write!(
                f,
                "{:?} produced at step {} is never consumed",
                surface, producer_step
            ),
            ValidationError::MissingTile { step, surface } => write!(
                f,
                "step {}: {:?} requires a tile but carries None",
                step, surface
            ),
            ValidationError::DisallowedRewrite { step, surface } => write!(
                f,
                "step {} rewrites non-Target surface {:?} (only Target may have multiple producers)",
                step, surface
            ),
        }
    }
}

impl std::error::Error for ValidationError {}

/// SSA invariant checker. Walks a slice of `Step`s producing a list of
/// every violation found (rather than stopping at the first).
pub struct IrValidator;

impl IrValidator {
    /// Validate a schedule. Empty `Ok(())` on success; on failure
    /// returns every violation discovered so the caller can fix them
    /// all in one pass.
    pub fn validate(schedule: &[Step]) -> std::result::Result<(), Vec<ValidationError>> {
        let mut errors = Vec::new();
        let mut producers: FxHashMap<SurfaceRef, usize> = FxHashMap::default();
        let mut consumers: FxHashMap<SurfaceRef, Vec<usize>> = FxHashMap::default();
        let mut erased_at: FxHashMap<SurfaceRef, usize> = FxHashMap::default();

        for (idx, step) in schedule.iter().enumerate() {
            // 6. Tile presence.
            for r in step
                .reads()
                .iter()
                .chain(step.writes().iter())
                .chain(step.rewrites().iter())
                .chain(step.kills().iter())
            {
                if !r.is_target() && r.tile.is_none() {
                    errors.push(ValidationError::MissingTile {
                        step: idx,
                        surface: *r,
                    });
                }
            }

            // 3. No use-after-erase — check reads and rewrites against
            // the kill table.
            for r in step.reads().iter().chain(step.rewrites().iter()) {
                if let Some(&erase_step) = erased_at.get(r) {
                    errors.push(ValidationError::UseAfterErase {
                        erase_step,
                        use_step: idx,
                        surface: *r,
                    });
                }
            }

            // 2. Define-before-use.
            for r in step.reads() {
                if !producers.contains_key(&r) && !r.is_target() {
                    errors.push(ValidationError::UseBeforeDefine {
                        step: idx,
                        surface: r,
                    });
                }
                consumers.entry(r).or_default().push(idx);
            }

            // 4. Composite target must exist (or be Target).
            for r in step.rewrites() {
                if !r.is_target() {
                    // Non-Target rewrites are forbidden — single-producer
                    // applies. Flag it.
                    errors.push(ValidationError::DisallowedRewrite {
                        step: idx,
                        surface: r,
                    });
                } else {
                    // Target may be rewritten freely; still record the
                    // composite as a "consumer" for unconsumed-surface
                    // analysis on the from-side (handled via `reads()`
                    // above) and as a producer for Target itself.
                    producers.entry(r).or_insert(idx);
                }
            }

            // 1. Producer registration.
            //
            // Paint-accumulation roles (`ScopeOf`, `TileOutput`,
            // `Target`) accept multiple writers — each Paint /
            // PaintGather step into a scope/tile/target surface
            // stacks visually. The first writer is recorded as the
            // canonical producer for dependency-graph purposes; later
            // writers don't create duplicate-producer errors.
            //
            // Strict single-producer applies to capture roles
            // (`Snapshot`, `Backdrop`, `RasterEffectOutput`) — those
            // identify a specific value, not an accumulating surface.
            for r in step.writes() {
                let allows_accumulation = matches!(
                    r.role,
                    SurfaceRole::ScopeOf(_) | SurfaceRole::TileOutput | SurfaceRole::Target
                );
                if let Some(&first) = producers.get(&r) {
                    if !allows_accumulation {
                        errors.push(ValidationError::DuplicateProducer {
                            first_step: first,
                            duplicate_step: idx,
                            surface: r,
                        });
                    }
                    // First writer keeps producer slot — that's the
                    // earliest step the dep graph anchors to.
                } else {
                    producers.insert(r, idx);
                }
            }

            // Kills come last so a step that both reads and kills the
            // same ref (e.g. Composite { from: X, erase_after: true })
            // doesn't trigger use-after-erase on itself.
            for r in step.kills() {
                erased_at.insert(r, idx);
            }
        }

        // 5. Unconsumed-surface sweep. Run after the main loop so we
        // see the full consumer map.
        for (surface, producer_step) in &producers {
            if surface.is_target() {
                continue; // canvas presents Target — no IR consumer needed
            }
            // TileOutput is consumed by WriteTileCache; that's a read,
            // so the consumer map already covers it.
            let consumed = consumers
                .get(surface)
                .map(|v| !v.is_empty())
                .unwrap_or(false);
            if !consumed {
                errors.push(ValidationError::UnconsumedSurface {
                    producer_step: *producer_step,
                    surface: *surface,
                });
            }
        }

        // Composite-target undefined: walk the schedule once more —
        // we already flagged via `UseBeforeDefine` for `reads()`, but
        // `Composite.to` is in `rewrites()`, not `reads()`. A composite
        // into a never-produced non-Target surface is a separate error
        // shape worth its own message.
        for (idx, step) in schedule.iter().enumerate() {
            if let Step::Composite { to, .. } = step {
                if !to.is_target() && !producers.contains_key(to) {
                    // Find this in errors? It would have appeared as
                    // DisallowedRewrite already (since non-Target
                    // rewrite is forbidden). Don't double-report.
                    let _ = idx;
                }
            }
        }

        // Deduplicate errors in the rare case the same violation
        // appears via two code paths.
        let mut seen = FxHashSet::default();
        errors.retain(|e| seen.insert(format!("{:?}", e)));

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    /// Convenience for `debug_assert!` style call sites: panics with the
    /// first violation if validation fails. Use in dispatcher startup.
    #[track_caller]
    pub fn debug_assert(schedule: &[Step]) {
        if cfg!(debug_assertions) {
            if let Err(errors) = Self::validate(schedule) {
                panic!(
                    "SSA IR validation failed ({} error{}); first: {}",
                    errors.len(),
                    if errors.len() == 1 { "" } else { "s" },
                    errors[0]
                );
            }
        }
    }
}

/// Helper for tests / debug dumps: a per-`SurfaceRef` liveness range
/// derived from a schedule. `[first_def_idx, last_use_idx]`. Refs with
/// no consumer (e.g. unused Target) get `last_use = first_def`.
///
/// This is the same computation the (future) `LivenessPass` will do,
/// extracted here so the validator and tests can share it.
pub fn compute_liveness(schedule: &[Step]) -> FxHashMap<SurfaceRef, (usize, usize)> {
    let mut ranges: FxHashMap<SurfaceRef, (usize, usize)> = FxHashMap::default();
    for (idx, step) in schedule.iter().enumerate() {
        for r in step.writes().iter().chain(step.rewrites().iter()) {
            ranges
                .entry(*r)
                .and_modify(|e| {
                    if idx < e.0 {
                        e.0 = idx
                    }
                    if idx > e.1 {
                        e.1 = idx
                    }
                })
                .or_insert((idx, idx));
        }
        for r in step.reads() {
            ranges
                .entry(r)
                .and_modify(|e| {
                    if idx > e.1 {
                        e.1 = idx
                    }
                })
                .or_insert((idx, idx));
        }
    }
    ranges
}

/// True if a role requires a tile coordinate. `Target` is the only
/// tile-less role today; the function exists so future tile-less roles
/// (e.g. an Export ref) have one central place to register.
pub fn role_requires_tile(role: SurfaceRole) -> bool {
    !matches!(role, SurfaceRole::Target)
}
