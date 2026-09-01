//! Frame value-DAG (Phase C) — the explicit, whole-frame dependency graph, where every node *is* the
//! operation it runs.
//!
//! Today the render order is split across three mechanisms: the tree walk linearises shapes into a
//! draw stream (z-order = array index), per-effect [`crate::effect_graph`] DAGs describe a single
//! effect's passes, and the whole-viewport scheduler (`wv_rounds` + the shadow/stack maps) infers a
//! round order from reach-rectangle overlap. This module builds ONE graph that owns all of it.
//!
//! The point is a *single path*, not a faithful copy of the per-effect ones. Every effect — drop
//! shadow, inner shadow, glass, layer blur, background blur — decomposes into the SAME small alphabet
//! of primitives ([`Op`]): rasterize, blur, sample, erase, custom, reload, compose. There is no
//! "drop path" or "glass path": a frost *is* a blur, a silhouette *is* a rasterize, a lens warp *is* a
//! sample. A node carries its `op` and its `target` (scratch atlas vs. the frame accumulator) — which
//! is exactly a runnable stage (`reads` + `target` + `work`) — and the old node *kind* is a derived
//! view ([`Node::category`]), never a stored tag.
//!
//! Leaves stay coarse: a run of plain shapes is ONE rasterize band, not a node per shape — the tiled
//! rasterizer still owns the per-shape compositing inside a band. Rendering the graph for inspection
//! (Mermaid) lives in the dev harness (`webgpu-vello/examples/frame_dag_dump.rs`), not here.

use crate::kurbo::Rect;

use crate::effect::{effect_stack, Compose, Op as EffectOp};
use crate::model::Scene;
use crate::vello::plan::Target;
use crate::vello::units::{BlurAxis, BlurEdge, ComposeMode, RasterSource, UnitOp};

/// The frame's operation alphabet is [`UnitOp`] — the SAME enum the executor runs, so a DAG node *is*
/// the operation, with no separate scheduler alphabet to translate through. A node carries one atomic
/// unit; a fine arm is a *fused run* of them ([`crate::vello::units::fuse`]). The structural ops
/// (`Rasterize`/`Reload`/`Compose`) express the frame's dependency + barrier structure; the fragment
/// units (`Warp`/`Blur`/`Scatter`/`EraseBy`/`Shade`/`MaskMix`/`Tint`/`Custom`) are the shader math. A
/// separable blur is TWO positional `UnitOp::Blur` nodes (X then Y reading it); the schedule puts Y one
/// barrier after X and `bake` assigns the axis from position. The device GPU uniform is computed by
/// `bake` at draw time (it needs the viewport); the DAG carries structure alone.

/// Where a node's concrete work comes from in the scene — the thread the *executor* follows to build
/// the actual GPU pass (geometry to rasterize, effect config to bake into the uniform). The scheduler
/// never reads it; it exists only so `frame_exec`'s dispatch can resolve an [`Op`] to real work
/// without re-deriving anything.
#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    /// The page background fill.
    Background,
    /// A coalesced run of plain shapes — rasterize their fills, in order.
    Band(Vec<u128>),
    /// The shape's own body (plain fills / text).
    Body(u128),
    /// A pass belonging to one entry of a shape's effect stack: `shape`'s `effect_stack()[slot]`. The
    /// `Op` says which pass within that effect (rasterize the source, blur it, compose it); `slot` says
    /// which effect — so a drop's colour and an inner's colour never get confused.
    Effect { shape: u128, slot: usize },
}

/// The coarse role of a node, DERIVED from its `op` and `target` — a view for display and queries, not
/// a stored tag. (The scheduler branches on `op`/`target`, never on this.)
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Category {
    /// The page background — the first accumulator value (a rasterize with no inputs).
    Background,
    /// A spine rasterize that writes the accumulator: a paint band or a shape body.
    Paint,
    /// A scratch value: any op writing an atlas (silhouette, blur, sample, erase, custom).
    Draft,
    /// The accumulator snapshot a gather samples.
    Reload,
    /// A source-over onto the accumulator.
    Compose,
}

/// One operation in the frame graph. `inputs` are the indices of the nodes whose output this reads;
/// `op` is the primitive it runs; `target` is where its output lives (a scratch atlas, or the frame
/// accumulator — the spine). Together `(inputs, op, target)` is a runnable stage.
#[derive(Clone, Debug)]
pub struct Node {
    pub op: UnitOp,
    pub target: Target,
    /// Back-reference to the scene work this runs — read only by the executor, never the scheduler.
    pub source: Source,
    /// A human-readable name for the dev dump — display only, never branched on.
    pub label: String,
    /// Page-space footprint, for the region-scoped accumulator and tile-vs-footprint barrier test.
    /// `None` for a whole-frame node (the background).
    pub reach: Option<Rect>,
    pub inputs: Vec<usize>,
}

impl Node {
    /// The node's coarse role, derived from `op` + `target` + whether it has inputs.
    #[must_use]
    pub fn category(&self) -> Category {
        match self.op {
            UnitOp::Reload => Category::Reload,
            UnitOp::Compose(_) => Category::Compose,
            UnitOp::Rasterize(_) if self.target == Target::Accumulator => {
                if self.inputs.is_empty() {
                    Category::Background
                } else {
                    Category::Paint
                }
            }
            _ => Category::Draft,
        }
    }

    /// Writes the frame accumulator (a spine node) rather than a scratch atlas.
    #[must_use]
    pub fn writes_accumulator(&self) -> bool {
        self.target == Target::Accumulator
    }
}

/// The whole-frame value-DAG: a flat, topologically-buildable node list (a node only ever cites
/// earlier indices, so the vector order is already a valid topological order).
#[derive(Clone, Debug, Default)]
pub struct FrameDag {
    pub nodes: Vec<Node>,
}

/// The on-chip tile edge in page units. A gather whose source fits inside one tile blurs entirely
/// within a workgroup (no cross-tile read → no barrier); a larger source spans workgroups and must
/// materialize. Matches the fine-pass 16×16 tile.
pub const TILE_PX: f64 = 16.0;

/// The reason a node opens a new round — the only two things that force a GPU-wide barrier (a
/// dispatch boundary). Everything else folds into a neighbouring pass.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Barrier {
    /// A gather reads a freshly-computed draft over a neighbourhood, so that draft must be flushed to
    /// VRAM and its producing dispatch must finish first.
    Materialize,
    /// A gather reads the composited accumulator (the backdrop), so every layer below it must have
    /// composited to VRAM before this dispatch can sample it.
    Reload,
}

/// What one of `fine`'s texture slots holds during a dispatch — the coordinates of a
/// [`BindingShape`]. `Draft(pool)` names which physical draft pool the value lives in TODAY (0 =
/// silhouette-rooted scratch, 1 = backdrop-rooted / blur atlas); the pool coordinate disappears when
/// the shared atlas unifies drafts into lease rects.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Slot {
    /// Nothing bound.
    None,
    /// A rasterized source texture (a silhouette, an SDF).
    Source,
    /// The frame accumulator (directly, or via its reload).
    Backdrop,
    /// A materialized intermediate, tagged with its physical pool.
    Draft(u8),
}

/// The dispatch-binding shape of a node: literally what its pass puts in `fine`'s three texture slots,
/// plus which pipeline permutation reads slot 10. Two nodes may share a round's single dispatch iff
/// their shapes are EQUAL — same bindings, physically shared via co-location/aliasing. Compared only
/// for equality; carries no encoding.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub struct BindingShape {
    /// What `base_in` holds. A composite always reads the accumulator; a materialize reads its chain's
    /// root surface.
    pub base: Slot,
    /// What `input_in`/`draft_in` holds.
    pub input: Slot,
    /// Where `output` points: a scratch draft (`true`) or the accumulator.
    pub to_draft: bool,
    /// A blur's neighbourhood TAPS over a `Draft` input ride the draft-permutation pipeline; a
    /// pointwise read of the same slot rides the input-permutation — different pipelines, so a tapping
    /// and a non-tapping node never share a dispatch even with equal slots.
    pub draft_taps: bool,
}

/// The barrier-aware schedule: each node's round, where a round is one dispatch and consecutive rounds
/// are one barrier apart.
pub struct Schedule {
    /// `round[i]` — the dispatch node `i` runs in. This is node `i`'s BIRTH: the round its output is
    /// written.
    pub round: Vec<u32>,
    /// `barrier[i]` — set when node `i` opens its round across a barrier edge (why it could not fold
    /// into an earlier one); `None` when it shares its inputs' round.
    pub barrier: Vec<Option<Barrier>>,
    /// `death[i]` — the last round any consumer READS node `i`'s output; the round its memory becomes
    /// reclaimable. A node with no consumer dies at its own round (`death[i] == round[i]`). This is the
    /// live interval's end — the allocator packs `[round[i], death[i]]`, and two values may share a slot
    /// only when their intervals are disjoint. Compile-time only: never emitted to the PTCL.
    pub death: Vec<u32>,
    /// `desc[i]` — node `i`'s baked descriptor, the 26 floats `fine` reads. `[0; 26]` for a node that
    /// carries no marker (a structural `Rasterize`/`Reload`/`Compose`, or a plain band). Filled by
    /// [`FrameDag::plan`]; empty from [`FrameDag::schedule`] (which computes structure only).
    pub desc: Vec<[f32; 26]>,
    /// `lease[i]` — the atlas rect node `i` MATERIALIZES into, or `None` when it composites into the
    /// accumulator (or carries no scratch). A consumer reads its input's lease. Filled by [`FrameDag::plan`].
    pub lease: Vec<Option<Lease>>,
    /// `ctl[i]` — node `i`'s control word: [`Schedule::ATOMIC`] when it chains in `fine`'s register (a
    /// pointwise unit), plus [`Schedule::BOUNDARY`] when it closes the chain into the accumulator. `0` for
    /// a materialize pass (a `Blur` axis draft) or a marker-less node. Filled by [`FrameDag::plan`].
    pub ctl: Vec<u32>,
}

impl Schedule {
    /// `ctl` bit: this node's descriptor chains in `fine`'s per-pixel register (a pointwise unit) rather
    /// than starting fresh.
    pub const ATOMIC: u32 = 1;
    /// `ctl` bit: this node closes the register chain — its value composites into the accumulator masked.
    pub const BOUNDARY: u32 = 2;

    /// Round count = one past the deepest round.
    #[must_use]
    pub fn rounds(&self) -> u32 {
        self.round.iter().copied().max().unwrap_or(0) + 1
    }
}

/// A materialized value the allocator must place: its pixel size and the round-interval it is live —
/// `[birth, death]`, inclusive. The packer's input. `birth`/`death` come straight from
/// [`Schedule::round`]/[`Schedule::death`]; `w`/`h` from the node's reach (device pixels at wire time).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LiveRect {
    pub node: usize,
    pub w: u32,
    pub h: u32,
    pub birth: u32,
    pub death: u32,
}

/// The packer's placement for one value: which slab (atlas texture) it lives in and where. `w`/`h` are
/// the value's true size — the slot it occupies may be a rounded size class, but the shader addresses
/// only `w`×`h` inside it (the rest is padding). This is the allocator's whole output; `death` shaped
/// it and is gone. The Sink turns `slab` into a bound texture and `(x, y)` into the fine `scratch_offset`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Lease {
    pub slab: u32,
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// The widest atlas a slab may grow to before slots wrap to a new row. A tunable, not a hard limit —
/// slabs stack rows below it, so a class just gets a taller texture, never a second slab from width.
pub const SLAB_MAX_WIDTH: u32 = 4096;

fn round_up_pow2(n: u32) -> u32 {
    n.max(1).next_power_of_two()
}

/// Place every materialized value into a size-class slab, reusing a slot whose prior occupant died
/// before this value is born. This is the offline packer: it sees all `[birth, death]` intervals up
/// front (the schedule is static), so it is interval-graph colouring, not an online gamble. Each value
/// is rounded up to a power-of-two size class; within a class every slot is identical, so a freed slot
/// serves any later value of that class with ZERO fragmentation — the reuse the round-over-round size
/// changes need. One slab (atlas) per class; slots tile left-to-right up to [`SLAB_MAX_WIDTH`], then
/// wrap. Greedy first-fit in birth order uses exactly `max concurrent live` slots per class (the
/// interval-graph clique number — the true lower bound). Returns one lease per input, input order.
#[must_use]
pub fn pack(items: &[LiveRect]) -> Vec<Lease> {
    use std::collections::HashMap;
    // Process births in order so a slot's stored occupant is always the latest-born; a slot is free for
    // a new value iff that occupant died STRICTLY before this birth (equal rounds share a dispatch — no
    // barrier between them, so no safe reuse).
    let mut order: Vec<usize> = (0..items.len()).collect();
    order.sort_by_key(|&i| (items[i].birth, items[i].node));
    // Per class: each slot's occupied-until (its current occupant's death). One slab id per class.
    let mut slots_of: HashMap<(u32, u32), Vec<u32>> = HashMap::new();
    let mut slab_of: HashMap<(u32, u32), u32> = HashMap::new();
    let mut next_slab = 0u32;
    let mut slot_of = vec![0usize; items.len()];
    let mut class_of = vec![(0u32, 0u32); items.len()];
    for &i in &order {
        let it = items[i];
        let class = (round_up_pow2(it.w), round_up_pow2(it.h));
        class_of[i] = class;
        slab_of.entry(class).or_insert_with(|| {
            let s = next_slab;
            next_slab += 1;
            s
        });
        let slots = slots_of.entry(class).or_default();
        let slot = match slots.iter().position(|&until| until < it.birth) {
            Some(s) => {
                slots[s] = it.death;
                s
            }
            None => {
                slots.push(it.death);
                slots.len() - 1
            }
        };
        slot_of[i] = slot;
    }
    (0..items.len())
        .map(|i| {
            let (cw, ch) = class_of[i];
            let cols = (SLAB_MAX_WIDTH / cw).max(1);
            let s = slot_of[i] as u32;
            let (col, row) = (s % cols, s / cols);
            Lease { slab: slab_of[&class_of[i]], x: col * cw, y: row * ch, w: items[i].w, h: items[i].h }
        })
        .collect()
}

impl FrameDag {
    /// The NAIVE topological depth: `0` for a leaf, else `1 + max(input round)` — a barrier at *every*
    /// edge. The upper bound the real scheduler improves on (it folds the composite spine, which
    /// carries no barrier). Kept only as the baseline to compare [`Self::schedule`] against.
    #[must_use]
    pub fn levels(&self) -> Vec<u32> {
        let mut lv = vec![0u32; self.nodes.len()];
        for (i, n) in self.nodes.iter().enumerate() {
            lv[i] = n.inputs.iter().map(|&j| lv[j] + 1).max().unwrap_or(0);
        }
        lv
    }

    /// Does reading `from`'s output inside `to` require a barrier? The whole schedule reduces to this
    /// predicate, over `op` alone. Two — and only two — edges carry one:
    /// * `to` is a [`UnitOp::Reload`] → the accumulator must flush before it can be sampled (`Reload`).
    /// * `to` is a gather over a *freshly-computed* source that spans tiles → that source must
    ///   materialize first (`Materialize`). A gather over a reload is free (already resident); a gather
    ///   over a source that fits one tile blurs on-chip.
    ///
    /// Every other edge — the composite spine, a body reading the accumulator, a pointwise pass — is
    /// same-tile, same-dispatch and folds.
    fn edge_barrier(&self, from: usize, to: usize, tile: f64) -> Option<Barrier> {
        let (src, dst) = (&self.nodes[from], &self.nodes[to]);
        if dst.op == UnitOp::Reload {
            return Some(Barrier::Reload);
        }
        if dst.op.is_gather() && src.op != UnitOp::Reload {
            let on_chip = src.reach.is_some_and(|r| r.width() <= tile && r.height() <= tile);
            if !on_chip {
                return Some(Barrier::Materialize);
            }
        }
        // A barrier op's output is a materialized draft. Its SINGLE-input consumer chains in the same
        // dispatch's register (the blur's tap loop feeds the fused pointwise tail); but a MULTI-input
        // consumer (an erase reading the punch beside its flood) binds that draft as a texture, and a
        // texture read needs the producing dispatch complete — one round later.
        if src.op.is_barrier() && dst.inputs.len() >= 2 {
            return Some(Barrier::Materialize);
        }
        // A Shade seeded from a materialized head (the scatter/blur draft it reads through slot 10)
        // binds that draft as a texture, so the producing dispatch must complete one round earlier.
        if matches!(dst.op, UnitOp::Shade(_)) && matches!(src.op, UnitOp::Scatter(_) | UnitOp::Blur { .. }) {
            return Some(Barrier::Materialize);
        }
        None
    }

    /// The dispatch-BINDING shape of a node that OWNS a fine dispatch — literally what its pass puts in
    /// `fine`'s three texture slots, derived purely from op + edges, never a name. One dispatch binds one
    /// set, so two nodes may share a round's dispatch iff their shapes are EQUAL — their bindings are
    /// then physically shared (silhouette co-location, draft aliasing). `None` = the node owns no
    /// dispatch: a structural node, an imperative raster source, or a pointwise unit that chains in
    /// `fine`'s register inside another node's pass.
    #[must_use]
    pub fn binding_shape(&self, i: usize) -> Option<BindingShape> {
        let n = &self.nodes[i];
        let mat = self.nodes.iter().any(|m| {
            m.inputs.contains(&i)
                && matches!(m.op, UnitOp::Blur { .. } | UnitOp::Scatter(_) | UnitOp::Warp(_) | UnitOp::EraseBy(_))
        });
        // The chain's root decides what `base_in` holds — a rasterized source texture, or the (reloaded)
        // accumulator — and, for a draft input, which pool that draft physically lives in today.
        let root = |mut j: usize| loop {
            match self.nodes[j].op {
                UnitOp::Rasterize(_) => break Slot::Source,
                UnitOp::Reload => break Slot::Backdrop,
                _ => match self.nodes[j].inputs.first() {
                    Some(&k) => j = k,
                    None => break Slot::Backdrop,
                },
            }
        };
        let shape = |base: Slot, input: Slot, to_draft: bool, draft_taps: bool| {
            Some(BindingShape { base, input, to_draft, draft_taps })
        };
        match &n.op {
            UnitOp::Blur { .. } => match &self.nodes[n.inputs[0]].op {
                UnitOp::Rasterize(_) => shape(Slot::Source, Slot::Source, mat, false),
                UnitOp::Reload => shape(Slot::Backdrop, Slot::None, mat, false),
                _ => {
                    // A materialize reads its chain's root as `base_in`; a composite always reads the
                    // accumulator. The slot-10 permutation follows the PRODUCER: a blur tapping another
                    // BLUR's draft rides the draft permutation; one tapping a head's draft (a frost H
                    // over the warp scratch) rides the input permutation.
                    let r = root(n.inputs[0]);
                    let base = if mat { r } else { Slot::Backdrop };
                    let taps = matches!(self.nodes[n.inputs[0]].op, UnitOp::Blur { .. });
                    shape(base, Slot::Draft(match r { Slot::Source => 0, _ => 1 }), mat, taps)
                }
            },
            UnitOp::EraseBy(_) => {
                let punch = n.inputs[1];
                let input = if matches!(self.nodes[punch].op, UnitOp::Rasterize(_)) {
                    Slot::Source
                } else {
                    Slot::Draft(0)
                };
                shape(Slot::Backdrop, input, false, false)
            }
            UnitOp::Tint(_) if matches!(self.nodes[n.inputs[0]].op, UnitOp::Rasterize(_)) => {
                shape(Slot::Backdrop, Slot::Source, false, false)
            }
            UnitOp::Warp(_) => {
                let input = if n.inputs.len() > 1 { Slot::Source } else { Slot::None };
                shape(Slot::Backdrop, input, mat, false)
            }
            UnitOp::ClipToSource(_) => match root(n.inputs[0]) {
                Slot::Source => shape(Slot::Backdrop, Slot::Source, mat, false),
                _ => None,
            },
            // A body rasterize that carries its OWN mark (a unit-less replaced body): composite the
            // co-located source over the accumulator.
            UnitOp::Rasterize(crate::vello::units::RasterSource::Body { .. })
                if n.inputs.is_empty() && !mat =>
            {
                shape(Slot::Backdrop, Slot::Source, false, false)
            }
            // A scatter always materializes: its consumer is a Shade head that reads it as a draft.
            UnitOp::Scatter(_) => shape(Slot::Backdrop, Slot::Draft(1), true, false),
            // A Shade whose input is a MATERIALIZED link (a scatter or blur draft) heads a new chain in
            // its own dispatch, seeded from that draft; one reading its head's in-register value
            // (a warp) chains inside the head's dispatch. MaskMix always chains.
            UnitOp::Shade(_) if matches!(self.nodes[n.inputs[0]].op, UnitOp::Scatter(_) | UnitOp::Blur { .. }) => {
                shape(Slot::Backdrop, Slot::Draft(1), false, false)
            }
            _ => None,
        }
    }

    /// THE scheduler — one call that decides *when* every node runs (`round`), *where* its scratch lives
    /// (`lease`), and *how* it reads (`desc`/`ctl`). It is a **two-level** schedule of the exact structure
    /// the DAG has once the accumulator is factored out: a **forest of per-effect trees** threaded by a
    /// **region-scoped accumulator spine**.
    ///
    /// * **Level 1 — the spine (region-z).** Group nodes into components: all of one effect's nodes
    ///   (`Source::Effect`) form its build-tree; each plain paint band/body/background is a singleton.
    ///   `fine` walks a tile's effect markers with *strictly-increasing rounds* — two markers a tile sees
    ///   cannot share a round — so two effect components whose (tile-snapped) reaches overlap must occupy
    ///   **disjoint round ranges in paint order**. `base[c] = max over earlier reach-overlapping d of
    ///   base[d] + span[d] + [c is an effect]`. Disjoint components reuse rounds (region-scoping); plain
    ///   paint folds (it emits no marker), so only effect components consume a fresh round.
    /// * **Level 2 — the tree.** Inside a component, `off[i]` is the local barrier depth (a separable blur
    ///   is X then Y one materialize apart; a pointwise chain — glass warp→shade→maskmix — stays at one
    ///   offset so it fuses in `fine`'s register). `span[c] = max off`. `round[i] = base[comp] + off[i]`.
    ///
    /// **Budget.** `budget` (scratch bytes; [`u64::MAX`] = unbounded) caps concurrent live draft scratch:
    /// batch-then-flush over the spine — a component is deferred to a later `base` until its whole span
    /// fits under the budget, so `N` (effects in flight) slides with memory instead of OOM-ing at scale.
    /// Feasibility is free (one effect always fits), so this only ever *raises* rounds; it never fails.
    ///
    /// Then the SSA half: `pack` colours the `[round, death]` live intervals into leases (chordal ⇒
    /// optimal), and each node bakes its `desc` + `ctl`. `tile` is the on-chip edge ([`TILE_PX`]).
    #[must_use]
    pub fn schedule(&self, tile: f64, budget: u64) -> Schedule {
        use crate::vello::bake::{bake_unit, blur_arm, Policy};
        use std::collections::HashMap;
        let n = self.nodes.len();

        // ── Components: the accumulator factored out. One effect's nodes group by `(shape, slot)`; every
        // plain paint node is its own singleton. Inside a component is the effect's build-tree; between
        // components is the region-scoped accumulator spine.
        let mut comp = vec![0usize; n];
        let mut of: HashMap<(u128, usize), usize> = HashMap::new();
        let mut ncomp = 0usize;
        for (i, node) in self.nodes.iter().enumerate() {
            comp[i] = match node.source {
                Source::Effect { shape, slot } => *of.entry((shape, slot)).or_insert_with(|| {
                    let c = ncomp;
                    ncomp += 1;
                    c
                }),
                _ => {
                    let c = ncomp;
                    ncomp += 1;
                    c
                }
            };
        }

        // Per-component: emission rank (first node index), page-space reach (union), whether it emits a
        // marker (an effect occupies its own round range on its tiles), and its peak draft footprint.
        let mut first = vec![usize::MAX; ncomp];
        let mut reach: Vec<Option<Rect>> = vec![None; ncomp];
        let mut is_effect = vec![false; ncomp];
        let mut foot = vec![0u64; ncomp];
        for (i, node) in self.nodes.iter().enumerate() {
            let c = comp[i];
            first[c] = first[c].min(i);
            if matches!(node.source, Source::Effect { .. }) {
                is_effect[c] = true;
            }
            if let Some(r) = node.reach {
                reach[c] = Some(reach[c].map_or(r, |u| u.union(r)));
                if !node.writes_accumulator() {
                    foot[c] += (r.width().max(0.0) * r.height().max(0.0)) as u64 * 4;
                }
            }
        }

        // Level 2 — intra-component barrier depth (only within-component edges; cross-component edges are
        // the spine, handled by `base`). A separable blur's Y is one materialize past its X; a pointwise
        // chain shares its head's offset so it fuses.
        let mut off = vec![0u32; n];
        for (i, node) in self.nodes.iter().enumerate() {
            for &j in &node.inputs {
                if comp[j] == comp[i] {
                    off[i] = off[i].max(off[j] + u32::from(self.edge_barrier(j, i, tile).is_some()));
                }
            }
        }
        let mut span = vec![0u32; ncomp];
        for i in 0..n {
            span[comp[i]] = span[comp[i]].max(off[i]);
        }

        // Level 1 — the spine: base round per component, in paint (emission) order. A component starts
        // after every earlier reach-overlapping component ends; budget defers it further until its span
        // fits. Processing in emission order means a later component always reads its predecessors' FINAL
        // base, so region-z holds and the budget only ever adds separation.
        // Per-component dispatch signature: the (local round, binding class) of every dispatch-owning
        // node. One dispatch binds one input and one output, so a round accepts only ONE class — two
        // disjoint components share a round's dispatch iff their classes there agree (their bindings are
        // then physically shared via co-location/aliasing).
        let mut sig: Vec<Vec<(u32, BindingShape)>> = vec![Vec::new(); ncomp];
        for i in 0..n {
            if let Some(cl) = self.binding_shape(i) {
                sig[comp[i]].push((off[i], cl));
            }
        }

        let mut corder: Vec<usize> = (0..ncomp).collect();
        corder.sort_by_key(|&c| first[c]);
        let mut base = vec![0u32; ncomp];
        let mut load: Vec<u64> = Vec::new();
        let mut shape_at: HashMap<u32, BindingShape> = HashMap::new();
        for idx in 0..corder.len() {
            let c = corder[idx];
            let mut b = 0u32;
            for &d in &corder[..idx] {
                if reach_overlap(reach[c], reach[d], tile) {
                    // Strictly-increasing rounds bind only between two MARKERS: two effects that share a
                    // tile need a fresh round between them. If either side is plain paint (no marker), they
                    // co-exist in one round, ordered by PTCL position — no gap.
                    let gap = u32::from(is_effect[c] && is_effect[d]);
                    b = b.max(base[d] + span[d] + gap);
                }
            }
            loop {
                if !sig[c].iter().all(|&(o, cl)| shape_at.get(&(b + o)).is_none_or(|&e| e == cl)) {
                    b += 1;
                    continue;
                }
                if budget != u64::MAX && foot[c] > 0 {
                    let (lo, hi) = (b as usize, (b + span[c]) as usize);
                    while load.len() <= hi {
                        load.push(0);
                    }
                    // Defer only while something else is already resident in c's span — never past an
                    // EMPTY round. A single effect whose own footprint exceeds the budget then simply takes
                    // its own rounds (a requirements problem, not a hang): feasibility stays guaranteed.
                    let empty = (lo..=hi).all(|r| load[r] == 0);
                    let fits = (lo..=hi).all(|r| load[r] + foot[c] <= budget);
                    if !(fits || empty) {
                        b += 1;
                        continue;
                    }
                }
                break;
            }
            if budget != u64::MAX && foot[c] > 0 {
                let (lo, hi) = (b as usize, (b + span[c]) as usize);
                while load.len() <= hi {
                    load.push(0);
                }
                for r in lo..=hi {
                    load[r] += foot[c];
                }
            }
            for &(o, cl) in &sig[c] {
                shape_at.insert(b + o, cl);
            }
            base[c] = b;
        }

        let mut round = vec![0u32; n];
        for i in 0..n {
            round[i] = base[comp[i]] + off[i];
        }

        // Per-node barrier tag (display + executor): the strongest incoming edge barrier.
        let mut barrier = vec![None; n];
        for (i, node) in self.nodes.iter().enumerate() {
            for &j in &node.inputs {
                if let Some(bar) = self.edge_barrier(j, i, tile) {
                    barrier[i] = Some(match (barrier[i], bar) {
                        (Some(Barrier::Reload), _) | (_, Barrier::Reload) => Barrier::Reload,
                        _ => Barrier::Materialize,
                    });
                }
            }
        }

        // Death — the last round any consumer reads a node's output (its live-interval end).
        let mut death = round.clone();
        for (i, node) in self.nodes.iter().enumerate() {
            for &j in &node.inputs {
                if round[i] > death[j] {
                    death[j] = round[i];
                }
            }
        }

        let mut sched = Schedule { round, barrier, death, desc: Vec::new(), lease: Vec::new(), ctl: Vec::new() };

        // The SSA half: colour the live intervals into leases, then bake each node's descriptor + ctl.
        let lives = self.materialized_lives(&sched);
        let leases = pack(&lives);
        let mut lease = vec![None; n];
        for (lr, le) in lives.iter().zip(&leases) {
            lease[lr.node] = Some(*le);
        }
        let mut feeds_compose = vec![false; n];
        let mut comp_over = vec![false; ncomp];
        for (i, node) in self.nodes.iter().enumerate() {
            if let UnitOp::Compose(mode) = node.op {
                comp_over[comp[i]] = mode == ComposeMode::Over;
                for &j in &node.inputs {
                    feeds_compose[j] = true;
                }
            }
        }
        let mut desc = vec![[0.0f32; 26]; n];
        let mut ctl = vec![0u32; n];
        for (i, node) in self.nodes.iter().enumerate() {
            if !matches!(node.source, Source::Effect { .. }) || node.op.is_structural() {
                continue;
            }
            let writes_acc = node.writes_accumulator();
            match node.op {
                UnitOp::Blur { sigma, linear, axis, edge } => {
                    let edge_coverage = edge == BlurEdge::Coverage;
                    let policy = Policy {
                        colour_over: writes_acc && comp_over[comp[i]],
                        raw: edge_coverage && !writes_acc,
                        edge_coverage,
                        ..Policy::default()
                    };
                    desc[i] = blur_arm(sigma, linear, axis == BlurAxis::Y, policy, None);
                }
                _ => {
                    desc[i] = bake_unit(&node.op, Policy::default());
                    ctl[i] = if lease[i].is_some() {
                        0
                    } else {
                        Schedule::ATOMIC | if feeds_compose[i] { Schedule::BOUNDARY } else { 0 }
                    };
                }
            }
        }
        sched.desc = desc;
        sched.lease = lease;
        sched.ctl = ctl;
        sched
    }

    /// Build the packer's input from a schedule: one [`LiveRect`] per MATERIALIZED value — a node whose
    /// output lives in a scratch atlas (`!writes_accumulator`) and is read ACROSS A BARRIER (a consumer in
    /// a LATER round). A node read only within its own round chains in `fine`'s register (glass
    /// warp→shade→maskmix, an inner band's flood→erase→tint) — it never touches a texture, so it takes no
    /// lease. Its interval is `[round, death]` straight from the schedule; its size is the reach footprint
    /// in PAGE units here — a device-scaled caller multiplies by the view and render-scale before packing.
    /// The accumulator spine carries no lease: it composites in place.
    #[must_use]
    pub fn materialized_lives(&self, sched: &Schedule) -> Vec<LiveRect> {
        let mut crosses_barrier = vec![false; self.nodes.len()];
        for (i, n) in self.nodes.iter().enumerate() {
            for &j in &n.inputs {
                if sched.round[i] > sched.round[j] {
                    crosses_barrier[j] = true;
                }
            }
        }
        self.nodes
            .iter()
            .enumerate()
            .filter_map(|(i, n)| {
                if n.writes_accumulator() || !crosses_barrier[i] {
                    return None;
                }
                let (w, h) = n.reach.map_or((1, 1), |r| {
                    (r.width().ceil().max(1.0) as u32, r.height().ceil().max(1.0) as u32)
                });
                Some(LiveRect { node: i, w, h, birth: sched.round[i], death: sched.death[i] })
            })
            .collect()
    }

    /// Fill each background-blur node's DEVICE sigma — the blur half of the scheduler's viewport pass,
    /// the sibling to [`Self::fill_lens_uniforms`]. For every `Source::Effect` `Blur` node whose shape
    /// `sigma_of` resolves (a pure background blur; the caller returns `None` for a frost blur so it
    /// stays page-space and falls back), replace the page-radius sigma with the device sigma. `arms_for`
    /// then reads it straight into the axis pass's `u[0].z`.
    pub fn fill_blur_uniforms(&mut self, sigma_of: impl Fn(u128) -> Option<f32>) {
        for node in &mut self.nodes {
            let Source::Effect { shape, .. } = node.source else { continue };
            if let UnitOp::Blur { linear, axis, edge, .. } = node.op {
                if let Some(sigma) = sigma_of(shape) {
                    node.op = UnitOp::Blur { sigma, linear, axis, edge };
                }
            }
        }
    }

    /// Elide every `Blur` whose device sigma is negligible (< 0.5 px) — a sub-pixel blur is visually a
    /// no-op, so its consumers are rewired to read the blur's own input instead, and the blur node is left
    /// an orphan (no consumer → no scheduled pass). This is the SCHEDULER's per-frame simplification that
    /// dissolves the sharp-vs-soft-shadow split: a "sharp" shadow is just a soft one whose blur elided, so
    /// its composite's edge lands on the silhouette and it flows through the SAME edge-driven dispatch — no
    /// separate lane. Run AFTER the sigma fills (the sigmas must be device-space). Node indices are
    /// preserved (orphans stay in place), so anything holding an index stays valid.
    pub fn elide_negligible_blurs(&mut self) {
        for i in 0..self.nodes.len() {
            let UnitOp::Blur { sigma, .. } = self.nodes[i].op else { continue };
            if sigma >= 0.5 {
                continue;
            }
            let Some(&src) = self.nodes[i].inputs.first() else { continue };
            for n in &mut self.nodes {
                for inp in &mut n.inputs {
                    if *inp == i {
                        *inp = src;
                    }
                }
            }
        }
    }

    /// Fill a drop shadow's device uniforms — the shadow half of the viewport pass. For every
    /// `Source::Effect` node on a shadow slot, stamp the device sigma into its `Blur` (`sigma_of(shape,
    /// slot)`) and the straight colour into its `Tint` (`tint_of(shape, slot)`, packed as the vec's first
    /// four floats). `Sink::wv_shadow_plan_dag` then reads sigma/colour straight from the filled nodes. A
    /// node whose closure returns `None` (a non-shadow blur/tint) is left as-is.
    pub fn fill_shadow_uniforms(
        &mut self,
        sigma_of: impl Fn(u128, usize) -> Option<f32>,
        tint_of: impl Fn(u128, usize) -> Option<[f32; 4]>,
    ) {
        for node in &mut self.nodes {
            let Source::Effect { shape, slot } = node.source else { continue };
            match node.op {
                UnitOp::Blur { linear, axis, edge, .. } => {
                    if let Some(sigma) = sigma_of(shape, slot) {
                        node.op = UnitOp::Blur { sigma, linear, axis, edge };
                    }
                }
                UnitOp::Tint(_) => {
                    if let Some(c) = tint_of(shape, slot) {
                        node.op = UnitOp::Tint(c.to_vec());
                    }
                }
                _ => {}
            }
        }
    }

    /// Fill each glass unit node's device uniform — the scheduler's viewport pass, the one non-trivial
    /// "baking". For every `Source::Effect` node whose shape carries glass, compute the device field
    /// ([`crate::effect_graph::lens_device_field`] at the whole viewport, origin 0, k=1) and stamp each
    /// unit's own slots onto it: warp's chromatic aberration, scatter's frost, shade's specular. The
    /// caller supplies `geom_of` (it holds the scene + modifiers); frame_dag stays decoupled from the
    /// host types. After this the units carry exactly what the descriptor needs — no separate `bake`.
    pub fn fill_lens_uniforms(
        &mut self,
        viewport: crate::kurbo::Affine,
        w: u32,
        h: u32,
        geom_of: impl Fn(u128) -> Option<(crate::model::Glass, crate::effect_graph::LensGeometry)>,
    ) {
        for node in &mut self.nodes {
            let Source::Effect { shape, .. } = node.source else { continue };
            let Some((g, geom)) = geom_of(shape) else { continue };
            let base = crate::effect_graph::lens_device_field(&g, geom, (w, h), (0.0, 0.0), viewport, 1.0);
            node.op = match &node.op {
                UnitOp::Warp(_) => {
                    let mut u = base.to_vec();
                    u[17] = g.chromatic_aberration;
                    UnitOp::Warp(u)
                }
                UnitOp::Scatter(_) => {
                    let mut u = base.to_vec();
                    u[18] = g.frost;
                    UnitOp::Scatter(u)
                }
                UnitOp::Shade(_) => {
                    let mut u = base.to_vec();
                    u[19] = g.specular_opacity;
                    u[20] = g.specular_saturation;
                    UnitOp::Shade(u)
                }
                UnitOp::MaskMix(_) => UnitOp::MaskMix(base.to_vec()),
                other => other.clone(),
            };
        }
    }

    /// Project each node to the allocator's stage IR ([`crate::vello::plan::StageSpec`]) — the same
    /// object, with the `op` erased, so `colour_stages` / `pack_groups` can place the scratch atlases.
    /// `target` is the node's own; an input is a [`Input::Value`] when its producer wrote an atlas,
    /// else the [`Input::External`] accumulator.
    #[must_use]
    pub fn to_stage_specs(&self) -> Vec<crate::vello::plan::StageSpec> {
        use crate::vello::plan::{Input, StageSpec, ValueId};
        self.nodes
            .iter()
            .map(|n| {
                let reads = n
                    .inputs
                    .iter()
                    .map(|&j| {
                        if self.nodes[j].writes_accumulator() {
                            Input::External(0)
                        } else {
                            Input::Value(ValueId(j))
                        }
                    })
                    .collect();
                StageSpec { reads, target: n.target }
            })
            .collect()
    }
}

/// Does region `a` overlap region `b`? `None` is the whole frame, which overlaps everything. Two
/// finite rects overlap only with positive area — touching edges do not, and since reach rects already
/// include the 3σ blur halo, genuinely-interacting effects have overlapping rects.
fn overlaps(a: Option<Rect>, b: Option<Rect>) -> bool {
    match (a, b) {
        (Some(x), Some(y)) => x.x0 < y.x1 && y.x0 < x.x1 && x.y0 < y.y1 && y.y0 < x.y1,
        _ => true,
    }
}

/// Do two regions share a TILE — the round-separation test for the spine. `fine` walks a tile's effect
/// markers with strictly-increasing rounds, and a marker touches every tile its reach *snapped out to the
/// tile grid* covers, so two effects conflict exactly when their tile-snapped reaches intersect (not their
/// exact rects — sub-tile-apart reaches still land on the same tile). `None` is the whole frame.
fn reach_overlap(a: Option<Rect>, b: Option<Rect>, tile: f64) -> bool {
    let (Some(a), Some(b)) = (a, b) else { return true };
    let snap = |r: Rect| {
        Rect::new(
            (r.x0 / tile).floor() * tile,
            (r.y0 / tile).floor() * tile,
            (r.x1 / tile).ceil() * tile,
            (r.y1 / tile).ceil() * tile,
        )
    };
    let (a, b) = (snap(a), snap(b));
    a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
}

/// Does region `outer` fully contain `inner`? The whole frame contains everything; a finite region
/// never contains the whole frame.
fn covers(outer: Option<Rect>, inner: Option<Rect>) -> bool {
    match (outer, inner) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(o), Some(i)) => o.x0 <= i.x0 && o.y0 <= i.y0 && o.x1 >= i.x1 && o.y1 >= i.y1,
    }
}

/// The region-scoped accumulator: the frontier of spine writers, each tagged with the region it last
/// wrote (`None` = whole frame). A new spine node reads every writer its footprint overlaps, then
/// supersedes the ones it fully covers. So two disjoint effects never depend on each other — only
/// overlapping ones keep a z-order edge — and no edge is lost, because a covered writer is always an
/// input of the node that replaced it (the dependency survives transitively).
#[derive(Default)]
struct Accumulator {
    writers: Vec<(Option<Rect>, usize)>,
}

impl Accumulator {
    fn readers(&self, reach: Option<Rect>) -> Vec<usize> {
        self.writers.iter().filter(|(r, _)| overlaps(*r, reach)).map(|&(_, n)| n).collect()
    }

    fn write(&mut self, reach: Option<Rect>, node: usize) {
        self.writers.retain(|&(r, _)| !covers(reach, r));
        self.writers.push((reach, node));
    }
}

/// A pending run of plain shapes waiting to coalesce into one rasterize band. Carries the union of
/// their bounds so the band's `reach` is its real footprint — not the whole frame — which keeps
/// disjoint bands (e.g. a per-cell background behind each effect) from re-chaining the whole frontier,
/// and the shape ids so the executor can rasterize them.
#[derive(Default)]
struct Band {
    ids: Vec<u128>,
    bounds: Option<Rect>,
}

impl Band {
    fn push(&mut self, id: u128, r: Rect) {
        self.ids.push(id);
        self.bounds = Some(self.bounds.map_or(r, |b| b.union(r)));
    }
    fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }
    fn take(&mut self) -> Vec<u128> {
        self.bounds = None;
        std::mem::take(&mut self.ids)
    }
}

struct Builder {
    dag: FrameDag,
    /// The region-scoped spine frontier — the last writer of each region (see [`Accumulator`]).
    acc: Accumulator,
    /// Per-effect-node counter, for readable labels (`s1`, `s2`, …).
    fx_no: u32,
    /// The source every subsequent `push` stamps onto its node — set once per effect/body/band so the
    /// individual op emitters don't each thread it.
    cur: Source,
}

impl Builder {
    fn push(&mut self, op: UnitOp, target: Target, label: String, reach: Option<Rect>, inputs: Vec<usize>) -> usize {
        let id = self.dag.nodes.len();
        let source = self.cur.clone();
        self.dag.nodes.push(Node { op, target, source, label, reach, inputs });
        id
    }

    /// A scratch draft: writes an atlas, reads its predecessors (or nothing, for a source).
    fn draft(&mut self, op: UnitOp, label: String, reach: Option<Rect>, inputs: Vec<usize>) -> usize {
        self.push(op, Target::Atlas, label, reach, inputs)
    }

    /// A pointwise fragment unit (an empty-uniform structural placeholder — `bake` computes the device
    /// uniform). Reads `cur` (and any extra input, e.g. a mask-mix backdrop or an erase punch).
    fn pointwise(&mut self, op: UnitOp, label: String, reach: Option<Rect>, inputs: Vec<usize>) -> usize {
        self.draft(op, label, reach, inputs)
    }

    /// Lower a separable Gaussian to its two axis passes as two positional [`UnitOp::Blur`] nodes: X
    /// reads `cur`, Y reads X. The schedule puts Y one barrier after X (it gathers a fresh draft); `bake`
    /// assigns the axis from position. Returns the Y tail.
    fn blur(&mut self, radius: f32, linear: bool, cur: usize, reach: Option<Rect>, name: &str, tag: &str) -> usize {
        // The OOB behaviour is fixed by what the blur reads: a chain rooted at its own `Rasterize`
        // (a shadow silhouette, a warped body) fades to transparent; one rooted at a `Reload` (the
        // backdrop, a frost source) is the page. Stamp it here, once, from the chain root — not
        // re-traced at bake.
        let mut r = cur;
        let edge = loop {
            match self.dag.nodes[r].op {
                UnitOp::Rasterize(_) => break BlurEdge::Coverage,
                UnitOp::Reload => break BlurEdge::Backdrop,
                _ => match self.dag.nodes[r].inputs.first() {
                    Some(&j) => r = j,
                    None => break BlurEdge::Backdrop,
                },
            }
        };
        let x = self.draft(UnitOp::Blur { sigma: radius, linear, axis: BlurAxis::X, edge }, format!("{name} {tag} blur-X r{radius:.0}"), reach, vec![cur]);
        self.draft(UnitOp::Blur { sigma: radius, linear, axis: BlurAxis::Y, edge }, format!("{name} {tag} blur-Y r{radius:.0}"), reach, vec![x])
    }

    /// Coalesce a pending run of plain shapes into ONE rasterize band on the spine, scoped to their
    /// union bounds so it only chains with effects it actually overlaps.
    fn flush_band(&mut self, band: &mut Band) {
        if band.is_empty() {
            return;
        }
        let reach = band.bounds;
        let label = format!("paint band · {} shape(s)", band.ids.len());
        let inputs = self.acc.readers(reach);
        self.cur = Source::Band(band.take());
        let id = self.push(UnitOp::Rasterize(RasterSource::Body { offset: [0.0; 2] }), Target::Accumulator, label, reach, inputs);
        self.acc.write(reach, id);
        self.cur = Source::Background;
    }

    /// Lower a chain of effect ops onto a starting value, emitting the atomic units each decomposes to —
    /// NO pointwise gets folded away: a lens emits `Warp` (+ `Blur`/`Scatter` for frost) then explicit
    /// `Shade` + `MaskMix` nodes; a shadow tint emits a `Tint` node; a background blur emits `Blur` (+
    /// `MaskMix`). `fuse` recombines the adjacent ones into fine arms at bake time, so the DAG carries the
    /// exact units the executor runs and `bake` never re-derives them. `linear` selects the blur's light
    /// space. Returns the chain tail. (Inner-shadow erase is a two-input op handled by the caller.)
    fn lower_ops(&mut self, ops: &[EffectOp], start: usize, reach: Option<Rect>, name: &str, tag: &str, linear: bool, sampled: bool) -> usize {
        let mut cur = start;
        for op in ops {
            cur = match op {
                EffectOp::Blur { radius } => self.blur(*radius, linear, cur, reach, name, tag),
                EffectOp::EraseBy { blur, .. } => {
                    // The punch is a blurred copy of the silhouette; the erase is the pointwise dst-out
                    // of `cur` by it. Two units, not one bundled `Erase` — the same Blur every effect uses.
                    let punch = self.blur(*blur, linear, cur, reach, name, "punch");
                    self.pointwise(UnitOp::EraseBy(Vec::new()), format!("{name} {tag} erase"), reach, vec![cur, punch])
                }
                EffectOp::Lens(g) => {
                    // Lens is warp (+ blur → scatter for frost) then the pointwise shade + mask-mix, all
                    // explicit. `fuse` folds sharp glass to one arm ([Warp,Shade,MaskMix]) and frost to
                    // four ([Warp][BlurH][BlurV][Scatter,Shade,MaskMix]). A SHAPE-FOLLOWING (sampled) lens
                    // reads a baked signed-distance field of the outline for its `fieldDistance` — that SDF
                    // is its OWN source node (a `Rasterize` bake, the distance-field analogue of a
                    // silhouette), the warp's second input. The executor bakes the SDF (not coverage)
                    // because a `Warp` reads it; an analytic box lens has no such node.
                    let warp_inputs = if sampled {
                        let sdf = self.draft(UnitOp::Rasterize(RasterSource::Distance { decode: 0.0 }), format!("{name} lens sdf"), reach, vec![]);
                        vec![cur, sdf]
                    } else {
                        vec![cur]
                    };
                    let warp = self.draft(UnitOp::Warp(Vec::new()), format!("{name} lens warp"), reach, warp_inputs);
                    let head = if g.total_blur_sigma() > 0.5 {
                        let blurred = self.blur(g.total_blur_sigma(), false, warp, reach, name, "frost");
                        self.draft(UnitOp::Scatter(Vec::new()), format!("{name} lens scatter"), reach, vec![blurred])
                    } else {
                        warp
                    };
                    let shaded = self.pointwise(UnitOp::Shade(Vec::new()), format!("{name} lens shade"), reach, vec![head]);
                    self.pointwise(UnitOp::MaskMix(Vec::new()), format!("{name} lens mask-mix"), reach, vec![shaded])
                }
                EffectOp::Tint(c) => self.pointwise(
                    UnitOp::Tint(c.components.to_vec()),
                    format!("{name} {tag} tint"),
                    reach,
                    vec![cur],
                ),
                EffectOp::FieldTint(c) => {
                    let tinted = self.pointwise(
                        UnitOp::Tint(c.components.to_vec()),
                        format!("{name} {tag} field-tint"),
                        reach,
                        vec![cur],
                    );
                    let mut u = vec![0.0f32; 24];
                    u[crate::vello::bake::PAYLOAD_PROGRAM_SLOT] = crate::vello::bake::PROGRAM_RADIAL;
                    self.pointwise(UnitOp::MaskMix(u), format!("{name} {tag} field-mask"), reach, vec![tinted])
                }
                EffectOp::NoiseWarp { magnitude, grain, clip } => {
                    let mut u = vec![0.0f32; 24];
                    u[2] = *magnitude;
                    u[3] = *grain;
                    u[21] = f32::from(u8::from(*clip));
                    u[crate::vello::bake::PAYLOAD_PROGRAM_SLOT] = crate::vello::bake::PROGRAM_NOISE;
                    let warp = self.draft(UnitOp::Warp(u), format!("{name} {tag} noise-warp"), reach, vec![cur]);
                    self.pointwise(UnitOp::ClipToSource(Vec::new()), format!("{name} {tag} clip"), reach, vec![warp])
                }
                EffectOp::Offset(_) => cur, // geometry — baked into which silhouette is rasterized, no unit
            };
        }
        cur
    }

    /// Lower one effect-bearing node's whole stack onto the spine, in paint order: drops under the
    /// body, the body, a gather through the coverage, inners over. Each effect is `rasterize/reload
    /// source → units → compose`, differing only in where it sits and whether it reloads.
    fn lower_effect_node(&mut self, shape: u128, node: &crate::model::Node) {
        self.fx_no += 1;
        let name = format!("s{}", self.fx_no);
        let base = node.bounds;
        let stack = effect_stack(node);
        let has_replace = stack.iter().any(|e| e.compose == Compose::Replace);
        let has_paint = !node.fills.is_empty() || node.text.is_some() || !node.strokes.is_empty();

        let mut body_done = false;
        for (slot, e) in stack.iter().enumerate() {
            if !body_done && e.compose != Compose::Under {
                self.emit_body(shape, base, has_replace, has_paint, &name);
                body_done = true;
            }
            let reach = Some(e.footprint(base));
            self.cur = Source::Effect { shape, slot };
            // The Compose unit carries HOW the chain lands, straight from the authored compose:
            // a shadow / replaced body lays its coverage-rooted value source-over; a backdrop
            // gather mixes in masked. Downstream reads the unit, never re-derives.
            let mode = match e.compose {
                Compose::Over | Compose::Under | Compose::Replace => ComposeMode::Over,
                Compose::ThroughCoverage => ComposeMode::MaskedMix,
            };
            let tail = match e.compose {
                // An inner shadow is a two-coverage op — flood MINUS an offset+blurred punch. Both are
                // plain `Rasterize` nodes (the flood is the shape's UNOFFSET coverage — for a Text that
                // is its glyphs, drawn by the silhouette rasterizer), so there is no back-sampling
                // special case: the erase reads the flood and the blurred punch directly.
                Compose::Over => {
                    let analytic = node.text.is_none();
                    let poff = e
                        .ops
                        .iter()
                        .find_map(|o| match o {
                            EffectOp::EraseBy { offset, .. } => Some([offset.x as f32, offset.y as f32]),
                            _ => None,
                        })
                        .unwrap_or([0.0; 2]);
                    let flood = self.draft(
                        UnitOp::Rasterize(RasterSource::Coverage { offset: [0.0; 2], analytic }),
                        format!("{name} inner flood"),
                        reach,
                        vec![],
                    );
                    let punch_sil = self.draft(
                        UnitOp::Rasterize(RasterSource::Coverage { offset: poff, analytic }),
                        format!("{name} inner punch silhouette"),
                        reach,
                        vec![],
                    );
                    let blur = e.ops.iter().find_map(|o| match o {
                        EffectOp::EraseBy { blur, .. } => Some(*blur),
                        EffectOp::Blur { radius } => Some(*radius),
                        _ => None,
                    });
                    let punch = match blur {
                        Some(r) if r > 0.5 => self.blur(r, false, punch_sil, reach, &name, "punch"),
                        _ => punch_sil,
                    };
                    let band = self.pointwise(UnitOp::EraseBy(Vec::new()), format!("{name} inner band"), reach, vec![flood, punch]);
                    self.pointwise(UnitOp::Tint(Vec::new()), format!("{name} inner tint"), reach, vec![band])
                }
                Compose::Under => {
                    let off = e
                        .ops
                        .iter()
                        .find_map(|o| match o {
                            EffectOp::Offset(v) => Some([v.x as f32, v.y as f32]),
                            _ => None,
                        })
                        .unwrap_or([0.0; 2]);
                    let sil = self.draft(
                        UnitOp::Rasterize(RasterSource::Coverage { offset: off, analytic: node.text.is_none() }),
                        format!("{name} drop silhouette"),
                        reach,
                        vec![],
                    );
                    self.lower_ops(&e.ops, sil, reach, &name, "drop", false, false)
                }
                Compose::Replace => {
                    // A replaced body rides fine only when every op lowered faithfully. Any other op
                    // leaves the chain unit-less, which the emitter reads as "the painter renders
                    // this". `Offset` is geometry: it sums into the body rasterization's own
                    // translation (it commutes with the blur), exactly as a drop's offset rides its
                    // `Coverage` payload.
                    let offset = e.ops.iter().fold([0.0f32; 2], |a, o| match o {
                        EffectOp::Offset(v) => [a[0] + v.x as f32, a[1] + v.y as f32],
                        _ => a,
                    });
                    let sil = self.draft(UnitOp::Rasterize(RasterSource::Body { offset }), format!("{name} body-read"), reach, vec![]);
                    let unitable = e.ops.iter().all(|o| {
                        matches!(
                            o,
                            EffectOp::Blur { .. } | EffectOp::NoiseWarp { .. } | EffectOp::Offset(_)
                        )
                    });
                    if unitable {
                        self.lower_ops(&e.ops, sil, reach, &name, "body", true, false)
                    } else {
                        sil
                    }
                }
                Compose::ThroughCoverage => {
                    let reads = self.acc.readers(reach);
                    let reload = self.draft(UnitOp::Reload, format!("{name} read backdrop"), reach, reads);
                    // A background blur mixes in linear light; a lens (its own Blur) mixes in sRGB.
                    let linear = e.ops.iter().any(|o| matches!(o, EffectOp::Blur { .. }));
                    // A path outline → a shape-following (sampled SDF) lens; a box shape → the analytic field.
                    let sampled = node.path.is_some();
                    self.lower_ops(&e.ops, reload, reach, &name, "gather", linear, sampled)
                }
            };
            self.compose(format!("{name} → acc"), reach, tail, mode);
            self.cur = Source::Background;
        }
        if !body_done {
            self.emit_body(shape, base, has_replace, has_paint, &name);
        }
    }

    /// Emit the shape's own body (plain fills/text) onto the spine — unless a Replace effect replaces
    /// it, or it has no paint.
    fn emit_body(&mut self, shape: u128, base: Rect, has_replace: bool, has_paint: bool, name: &str) {
        if has_replace || !has_paint {
            return;
        }
        let reach = Some(base);
        let inputs = self.acc.readers(reach);
        self.cur = Source::Body(shape);
        let id = self.push(UnitOp::Rasterize(RasterSource::Body { offset: [0.0; 2] }), Target::Accumulator, format!("{name} body"), reach, inputs);
        self.acc.write(reach, id);
        self.cur = Source::Background;
    }

    /// Land an effect result (`tail`) onto the region-scoped accumulator: read the writers `reach`
    /// overlaps, add the chain tail, emit the compose, and make it the new writer for `reach`.
    fn compose(&mut self, label: String, reach: Option<Rect>, tail: usize, mode: ComposeMode) {
        let mut inputs = self.acc.readers(reach);
        inputs.push(tail);
        let id = self.push(UnitOp::Compose(mode), Target::Accumulator, label, reach, inputs);
        self.acc.write(reach, id);
    }

    fn walk(&mut self, scene: &Scene, id: u128, band: &mut Band) {
        let Some(node) = scene.get(id) else { return };
        if node.hidden {
            return;
        }
        let has_effects = !effect_stack(node).is_empty();
        let has_paint = !node.fills.is_empty() || node.text.is_some() || !node.strokes.is_empty();
        if !has_effects && node.kind.is_container() {
            // A plain group: its children carry the real paints — recurse.
            for &child in &node.children {
                self.walk(scene, child, band);
            }
            return;
        }
        if !has_effects {
            // A plain leaf shape → coalesce into the pending rasterize band (id + bounds).
            if has_paint {
                band.push(id, node.bounds);
            }
            return;
        }
        // An effect-bearing node breaks the band: flush it, then lower the effects. (v1 treats an
        // effect node as a leaf — nested children of an effect node are a follow-up.)
        self.flush_band(band);
        self.lower_effect_node(id, node);
    }
}

/// Build the whole-frame value-DAG for an installed [`Scene`]. Walks the roots in z-order, threading
/// the region-scoped accumulator; plain shapes coalesce into rasterize bands, effect nodes lower their
/// stack into the shared primitive alphabet.
#[must_use]
pub fn build_frame_dag(scene: &Scene) -> FrameDag {
    let mut b = Builder { dag: FrameDag::default(), acc: Accumulator::default(), fx_no: 0, cur: Source::Background };
    let bg = b.push(UnitOp::Rasterize(RasterSource::Body { offset: [0.0; 2] }), Target::Accumulator, "BG".to_string(), None, vec![]);
    b.acc.write(None, bg);
    let mut band = Band::default();
    for &root in scene.roots() {
        b.walk(scene, root, &mut band);
    }
    b.flush_band(&mut band);
    b.dag
}

/// Convenience: build the DAG for the scene installed in the ABI thread-local.
#[must_use]
pub fn build_frame_dag_installed() -> FrameDag {
    crate::vello::abi::with_scene(|scene, _, _| build_frame_dag(scene))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every node cites only earlier indices, so the node vector is already a valid topological
    /// order — the invariant the whole design leans on (no separate sort, `levels()` is one forward
    /// pass).
    fn assert_topological(dag: &FrameDag) {
        for (i, n) in dag.nodes.iter().enumerate() {
            for &j in &n.inputs {
                assert!(j < i, "node {i} ({}) reads later node {j} — not topological", n.label);
            }
        }
    }

    fn count(dag: &FrameDag, c: Category) -> usize {
        dag.nodes.iter().filter(|n| n.category() == c).count()
    }

    #[test]
    fn combined_dag_is_well_formed() {
        crate::vello::abi::load_combined_scene();
        let dag = build_frame_dag_installed();

        assert_topological(&dag);
        // Exactly one background, node 0, no inputs — the spine root.
        assert_eq!(count(&dag, Category::Background), 1);
        assert_eq!(dag.nodes[0].category(), Category::Background);
        assert!(dag.nodes[0].inputs.is_empty());
        // The scene has effects → drafts and composites, and no backdrop gather → no reloads.
        assert!(count(&dag, Category::Draft) > 0, "expected effect drafts");
        assert!(count(&dag, Category::Compose) > 0, "expected effect composites");
        assert_eq!(count(&dag, Category::Reload), 0);
        // Every compose reads the accumulator + the effect tail (>= 2 inputs).
        for n in dag.nodes.iter().filter(|n| n.category() == Category::Compose) {
            assert!(n.inputs.len() >= 2, "compose '{}' must read acc + tail", n.label);
        }
    }

    #[test]
    fn plain_shapes_coalesce_into_one_band() {
        crate::vello::abi::load_stack_glass_scene(2, 0);
        let dag = build_frame_dag_installed();

        assert_topological(&dag);
        let bands = dag.nodes.iter().filter(|n| n.label.starts_with("paint band")).count();
        assert_eq!(bands, 1, "the checker ground must be ONE band");
        assert!(count(&dag, Category::Reload) > 0, "glass must read the backdrop");
    }

    #[test]
    fn schedule_serializes_overlapping_effects_and_keeps_the_blur_barrier() {
        // Two effects on ONE shape (a drop UNDER + an inner OVER) share every tile, so the strictly-
        // increasing marker law forces them into DISJOINT round ranges — the inner cannot begin until the
        // drop has finished. And inside the drop, its separable blur is one materialize apart (X then Y).
        crate::vello::abi::load_combined_scene();
        let dag = build_frame_dag_installed();
        let sched = dag.schedule(TILE_PX, u64::MAX);
        let round_of = |needle: &str| -> Vec<u32> {
            dag.nodes
                .iter()
                .enumerate()
                .filter(|(_, n)| n.label.starts_with("s1 ") && n.label.contains(needle))
                .map(|(i, _)| sched.round[i])
                .collect()
        };
        let drop_end = round_of("drop").into_iter().max().expect("s1 has a drop shadow");
        let inner_start = round_of("inner").into_iter().min().expect("s1 has an inner shadow");
        assert!(
            inner_start > drop_end,
            "overlapping effects serialize: inner starts at {inner_start}, after the drop ends at {drop_end}",
        );
        let bx = round_of("drop blur-X").into_iter().next().expect("the drop has a blur-X");
        let by = round_of("drop blur-Y").into_iter().next().expect("the drop has a blur-Y");
        assert_eq!(by, bx + 1, "a separable blur's Y is one materialize barrier past its X");
    }

    #[test]
    fn glass_reloads_drops_materialize() {
        crate::vello::abi::load_stack_glass_scene(2, 0);
        let dag = build_frame_dag_installed();
        let sched = dag.schedule(TILE_PX, u64::MAX);

        assert!(
            sched.barrier.iter().any(|b| matches!(b, Some(Barrier::Reload))),
            "a glass gather must reload the backdrop",
        );
        assert!(
            sched.barrier.iter().any(|b| matches!(b, Some(Barrier::Materialize))),
            "a drop shadow's blur must materialize its silhouette",
        );
        let naive = dag.levels().iter().copied().max().unwrap() + 1;
        assert!(sched.rounds() < naive, "still beats naive on the stacked case");
    }

    #[test]
    fn classes_separate_rounds_and_same_class_shares() {
        // The one-dispatch-one-binding law, as a scheduler rule: two DISJOINT effects may share a round
        // only when their dispatch-owning nodes there carry the SAME binding class. The matrix mixes 20
        // heterogeneous effect cells on a disjoint grid — every scheduled round must hold ONE class, and
        // the same-kind cells (several pure soft drops) must still share.
        use std::collections::HashMap;
        crate::vello::abi::load_matrix_scene();
        let dag = build_frame_dag_installed();
        let sched = dag.schedule(TILE_PX, u64::MAX);
        let mut at: HashMap<u32, BindingShape> = HashMap::new();
        let mut shared = 0u32;
        for i in 0..dag.nodes.len() {
            let Some(cl) = dag.binding_shape(i) else { continue };
            match at.get(&sched.round[i]) {
                Some(&e) => {
                    assert_eq!(e, cl, "round {} mixes binding shapes {e:?} and {cl:?}", sched.round[i]);
                    shared += 1;
                }
                None => {
                    at.insert(sched.round[i], cl);
                }
            }
        }
        assert!(shared > 0, "disjoint same-class effects share rounds");
    }

    #[test]
    fn budget_defers_effects_batch_then_flush() {
        // The memory lever: with an unbounded budget every disjoint cell batches into the same rounds; a
        // tight budget can hold only a few drafts at once, so it DEFERS the rest to later rounds (flush).
        // `N` — effects in flight — slides with the budget, and feasibility never fails (one draft fits any
        // real budget), so the tight schedule is finite, just deeper.
        crate::vello::abi::load_matrix_scene();
        let dag = build_frame_dag_installed();
        let roomy = dag.schedule(TILE_PX, u64::MAX).rounds();
        // ~256 KB holds a couple of cell drafts at once but not all of them, so it batches a few then
        // flushes — deeper than unbounded, nowhere near fully serial.
        let tight = dag.schedule(TILE_PX, 256 * 1024).rounds();
        assert!(tight > roomy, "a tight budget defers effects into more rounds ({tight} > {roomy})");
        assert!(tight < 100_000, "the schedule stays finite under any budget (got {tight})");
    }

    #[test]
    fn disjoint_cells_do_not_serialise() {
        // 20-cell grid, each cell a shape with its own effect stack. Region-scoping the spine lets cells
        // that do not share a tile occupy the SAME rounds, so the total stays far below one round-range per
        // effect (full serialization). It is set by the deepest cell plus the few edge-neighbours whose
        // blur halos actually touch — NOT by the effect count.
        use std::collections::HashSet;
        crate::vello::abi::load_matrix_scene();
        let dag = build_frame_dag_installed();
        let rounds = dag.schedule(TILE_PX, u64::MAX).rounds();
        let effects: HashSet<(u128, usize)> = dag
            .nodes
            .iter()
            .filter_map(|n| match n.source {
                Source::Effect { shape, slot } => Some((shape, slot)),
                _ => None,
            })
            .collect();
        // Heterogeneous cells fragment sharing (one class per round), so the honest upper bound is the
        // fully-serial one — one round per dispatch-owning node — which region-scoping must still beat.
        let dispatches = (0..dag.nodes.len()).filter(|&i| dag.binding_shape(i).is_some()).count() as u32;
        assert!(
            rounds < dispatches,
            "region-scoping beats fully-serial: {rounds} rounds for {dispatches} dispatch nodes ({} stacks)",
            effects.len(),
        );
        assert!(rounds >= 7, "the deepest cell's own barrier depth is preserved (got {rounds})");
    }

    #[test]
    fn every_node_resolves_to_real_scene_work() {
        // The executor follows `source` back to the scene; every node must point at work that exists —
        // a band's shape ids, a body's shape, or an effect slot that indexes a real effect stack.
        crate::vello::abi::load_combined_scene();
        let dag = build_frame_dag_installed();

        assert_eq!(dag.nodes[0].source, Source::Background, "node 0 is the background");
        crate::vello::abi::with_scene(|scene, _, _| {
            for n in &dag.nodes {
                match &n.source {
                    Source::Background => {}
                    Source::Band(ids) => {
                        assert!(!ids.is_empty(), "a band names its shapes");
                        for id in ids {
                            assert!(scene.get(*id).is_some(), "band shape {id:x} is in the scene");
                        }
                    }
                    Source::Body(shape) => {
                        assert!(scene.get(*shape).is_some(), "body shape {shape:x} is in the scene");
                    }
                    Source::Effect { shape, slot } => {
                        let node = scene.get(*shape).expect("effect shape is in the scene");
                        assert!(
                            *slot < crate::effect::effect_stack(node).len(),
                            "slot {slot} indexes shape {shape:x}'s effect stack",
                        );
                    }
                }
            }
        });
    }

    #[test]
    fn a_sharp_glass_dag_fills_and_serializes_to_the_descriptor() {
        // The whole scheduler→serialize pipeline on the real DAG: build the sharp-glass graph, let the
        // scheduler fill the lens units' device uniforms, and serialize the arm. It must produce the
        // shipping sharp-glass descriptor shape — bits 56, lens program, real (non-zero) device field.
        use crate::vello::bake::{arm_descriptor, Policy, PROGRAM_ROUNDED_BOX};
        crate::vello::abi::load_stack_glass_scene(1, 0);
        let mut dag = build_frame_dag_installed();
        crate::vello::abi::with_scene(|scene, viewport, modifiers| {
            dag.fill_lens_uniforms(viewport, 400, 400, |id| {
                let n = scene.get(id)?;
                let m = modifiers.get(&id).copied().unwrap_or(crate::kurbo::Affine::IDENTITY);
                crate::effect_graph::lens_geometry(n, m)
            });
        });
        // Sharp glass drops the scatter, so the fused arm is warp + shade + mask-mix, in order.
        let run: Vec<UnitOp> = dag
            .nodes
            .iter()
            .filter(|n| matches!(n.op, UnitOp::Warp(_) | UnitOp::Shade(_) | UnitOp::MaskMix(_)))
            .map(|n| n.op.clone())
            .collect();
        assert_eq!(run.len(), 3, "sharp glass = warp + shade + mask-mix");
        let d = arm_descriptor(&run, Policy::default(), None);
        assert_eq!(d[0], 56.0, "WARP|SHADE|MASKMIX");
        assert_eq!(d[1], PROGRAM_ROUNDED_BOX);
        assert!(d[2] > 0.0 && d[3] > 0.0, "the device field was filled (backdrop resolution present)");
    }

    #[test]
    fn stage_specs_are_executor_ready() {
        use crate::vello::plan::{atlases_needed, colour_stages, Target};
        crate::vello::abi::load_combined_scene();
        let dag = build_frame_dag_installed();
        let specs = dag.to_stage_specs();

        assert_eq!(specs.len(), dag.nodes.len());
        let colours = colour_stages(&specs);
        // A3/A4: a blur reads its silhouette so it takes a different atlas, but disjoint drafts reuse
        // atlases — the frame-wide count stays a small constant, not one-per-draft.
        let atlases = atlases_needed(&colours);
        assert!((2..=4).contains(&atlases), "disjoint drafts must reuse atlases (got {atlases})");
        // Every spine node writes the accumulator and takes no atlas colour.
        for (i, n) in dag.nodes.iter().enumerate() {
            if n.writes_accumulator() {
                assert_eq!(specs[i].target, Target::Accumulator);
                assert!(colours[i].is_none(), "accumulator stage must not be coloured");
            }
        }
    }

    /// The packer's core invariant: two values whose live intervals overlap (neither dies strictly
    /// before the other is born) must never occupy overlapping rects in the same slab.
    fn assert_no_live_overlap(items: &[LiveRect], leases: &[Lease]) {
        for a in 0..items.len() {
            for b in (a + 1)..items.len() {
                let (ia, ib) = (items[a], items[b]);
                if ia.death < ib.birth || ib.death < ia.birth {
                    continue; // disjoint in time — sharing a slot is legal
                }
                let (la, lb) = (leases[a], leases[b]);
                if la.slab != lb.slab {
                    continue;
                }
                let overlap = la.x < lb.x + lb.w && lb.x < la.x + la.w && la.y < lb.y + lb.h && lb.y < la.y + la.h;
                assert!(!overlap, "live values {a} and {b} overlap in slab {}", la.slab);
            }
        }
    }

    #[test]
    fn pack_reuses_a_freed_slot_and_keeps_live_rects_apart() {
        let items = vec![
            LiveRect { node: 0, w: 16, h: 16, birth: 0, death: 2 },
            LiveRect { node: 1, w: 16, h: 16, birth: 0, death: 2 }, // live WITH 0
            LiveRect { node: 2, w: 16, h: 16, birth: 3, death: 4 }, // born after 0 and 1 die
        ];
        let leases = pack(&items);
        assert_eq!(leases[0].slab, leases[1].slab, "same size class shares a slab");
        assert_ne!((leases[0].x, leases[0].y), (leases[1].x, leases[1].y), "co-live values take distinct slots");
        assert!(
            (leases[2].x, leases[2].y) == (leases[0].x, leases[0].y)
                || (leases[2].x, leases[2].y) == (leases[1].x, leases[1].y),
            "a value born after the cohort dies must REUSE a freed slot, not mint a third",
        );
        assert_no_live_overlap(&items, &leases);
    }

    #[test]
    fn pack_uses_exactly_max_concurrency_slots() {
        // Peak of three live at once (rounds 0-1: 0,1,2 — rounds 2-3: 0,3,4) → exactly three slots.
        let items = vec![
            LiveRect { node: 0, w: 8, h: 8, birth: 0, death: 5 },
            LiveRect { node: 1, w: 8, h: 8, birth: 0, death: 1 },
            LiveRect { node: 2, w: 8, h: 8, birth: 0, death: 1 },
            LiveRect { node: 3, w: 8, h: 8, birth: 2, death: 3 },
            LiveRect { node: 4, w: 8, h: 8, birth: 2, death: 3 },
        ];
        let leases = pack(&items);
        let distinct: std::collections::HashSet<(u32, u32)> = leases.iter().map(|l| (l.x, l.y)).collect();
        assert_eq!(distinct.len(), 3, "peak concurrency is 3, so the packer mints exactly 3 slots");
        assert_no_live_overlap(&items, &leases);
    }

    #[test]
    fn pack_segregates_size_classes_into_distinct_slabs() {
        let items = vec![
            LiveRect { node: 0, w: 16, h: 16, birth: 0, death: 1 },
            LiveRect { node: 1, w: 40, h: 40, birth: 0, death: 1 }, // rounds up to the 64 class
        ];
        let leases = pack(&items);
        assert_ne!(leases[0].slab, leases[1].slab, "different size classes live in different slabs");
        assert_eq!((leases[1].w, leases[1].h), (40, 40), "the lease reports the TRUE size inside its class slot");
    }

    #[test]
    fn schedule_death_tracks_the_last_reader_on_a_real_shadow() {
        // A drop shadow is silhouette → blur-H (draft) → blur-V: the H draft is a gather source that
        // spans tiles, so V reads it across a MATERIALIZE barrier one round later. That draft's death is
        // therefore strictly past its birth — the proof death propagates from a later-round consumer.
        crate::vello::abi::load_path_shadow_scene();
        let dag = build_frame_dag_installed();
        let sched = dag.schedule(TILE_PX, u64::MAX);
        assert_eq!(sched.death.len(), dag.nodes.len());
        for (i, n) in dag.nodes.iter().enumerate() {
            assert!(sched.death[i] >= sched.round[i], "node {i} ({}) dies before it is born", n.label);
        }
        let lives = dag.materialized_lives(&sched);
        assert!(!lives.is_empty(), "a drop shadow has materialized drafts");
        assert!(
            lives.iter().any(|l| l.death > l.birth),
            "the blur H draft must be read a round later than it is written",
        );
        // The real drafts pack to valid, non-overlapping leases.
        let leases = pack(&lives);
        assert_no_live_overlap(&lives, &leases);
    }

    #[test]
    fn plan_folds_descriptor_lease_and_ctl_per_node() {
        use crate::vello::units::UnitOp;
        crate::vello::abi::load_path_shadow_scene();
        let dag = build_frame_dag_installed();
        let sched = dag.schedule(TILE_PX, u64::MAX);
        let n = dag.nodes.len();
        assert_eq!(sched.desc.len(), n);
        assert_eq!(sched.lease.len(), n);
        assert_eq!(sched.ctl.len(), n);
        // A lease sits on exactly the materialized nodes — the same set `materialized_lives` reports.
        let want: std::collections::HashSet<usize> =
            dag.materialized_lives(&dag.schedule(TILE_PX, u64::MAX)).iter().map(|l| l.node).collect();
        for i in 0..n {
            assert_eq!(sched.lease[i].is_some(), want.contains(&i), "lease presence wrong at node {i}");
        }
        // Every Blur is a materialize axis pass (ctl 0, blur bit set); every pointwise unit chains
        // (ATOMIC); the composite that lays the shadow closes a chain (BOUNDARY).
        let (mut saw_blur, mut saw_boundary) = (false, false);
        for (i, node) in dag.nodes.iter().enumerate() {
            if !matches!(node.source, Source::Effect { .. }) || node.op.is_structural() {
                continue;
            }
            match node.op {
                UnitOp::Blur { .. } => {
                    saw_blur = true;
                    assert_eq!(sched.ctl[i], 0, "a blur axis pass does not chain");
                    assert_ne!((sched.desc[i][0] as u32) & 64, 0, "blur descriptor carries the blur bit");
                }
                _ => {
                    assert_ne!(sched.ctl[i] & Schedule::ATOMIC, 0, "a pointwise unit chains in the register");
                    saw_boundary |= sched.ctl[i] & Schedule::BOUNDARY != 0;
                }
            }
        }
        assert!(saw_blur, "a drop shadow has blur axis passes");
        assert!(saw_boundary, "the composite that lays the shadow closes a chain");
    }

    #[test]
    fn plan_leases_only_barrier_crossing_drafts_and_never_overlaps() {
        use crate::vello::units::UnitOp;
        use std::collections::HashMap;
        crate::vello::abi::load_combined_scene();
        let dag = build_frame_dag_installed();
        let sched = dag.schedule(TILE_PX, u64::MAX);
        assert!(sched.lease.iter().any(Option::is_some), "a drop+inner frame has materialized drafts");
        // A leased node is read across a barrier (a later round). A same-round register chain — e.g. the
        // Y-blur's output flowing into its Tint — takes no lease.
        for (i, l) in sched.lease.iter().enumerate() {
            if l.is_some() {
                let later = dag.nodes.iter().enumerate().any(|(ci, c)| c.inputs.contains(&i) && sched.round[ci] > sched.round[i]);
                assert!(later, "leased node {i} must be read in a later round");
            }
        }
        // Every Blur's INPUT is a leased texture (a neighbourhood tap needs a real surface).
        for (i, node) in dag.nodes.iter().enumerate() {
            if matches!(node.op, UnitOp::Blur { .. }) {
                let src = node.inputs[0];
                assert!(
                    sched.lease[src].is_some() || matches!(dag.nodes[src].op, UnitOp::Reload),
                    "blur node {i} taps node {src} which is neither leased nor the backdrop reload",
                );
            }
        }
        // No two nodes sharing a rect have overlapping live intervals.
        let mut by_rect: HashMap<(u32, u32, u32), Vec<usize>> = HashMap::new();
        for (i, l) in sched.lease.iter().enumerate() {
            if let Some(le) = l {
                by_rect.entry((le.slab, le.x, le.y)).or_default().push(i);
            }
        }
        for occupants in by_rect.values() {
            for a in 0..occupants.len() {
                for b in (a + 1)..occupants.len() {
                    let (x, y) = (occupants[a], occupants[b]);
                    assert!(
                        sched.death[x] < sched.round[y] || sched.death[y] < sched.round[x],
                        "nodes {x},{y} share a rect but their live intervals overlap",
                    );
                }
            }
        }
    }
}
