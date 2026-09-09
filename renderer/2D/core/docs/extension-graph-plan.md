# Regions — the piece graph (third formulation, for review)

## The model in one paragraph

Everything the renderer produces is a **piece**: an ordinary DAG node computing one value over
a rect domain at one density, placed on some tiles. The walk emits pieces where taps escape
the frame; finalize resolves numbers on that fixed topology; one scheduler orders everything
under a two-kind edge algebra; the flush is the only execution primitive. There are no frame
rounds and no region rounds — "the frame" is merely the piece chain the allocator coalesced
onto one address all the way down, whose last state is presented.

## Laws

Three laws, everything else is bookkeeping:

1. **One hazard.** A pass never samples the storage it writes — except reads of its own texel
   (which is why in-place `⊕` compositing is legal and kernels are not).
2. **One copy.** There is ONE transport node with domain, side, density and address freedom.
   Its arms — crop (smaller domain), combine (spanning domain), re-side (opposite atlas),
   resample (density change), preserve/rename (address conflict buyout) — are the same node.
   Every conflict in the system is discharged either by an ordering edge or by this node, and
   the choice is priced, never structural. The backdrop snapshot (today's `UnitOp::Reload`)
   is this node's preserve arm with the price forced by law 1: a gather can never sample the
   chain address its own compose writes, so the state it reads is materialized aside — a
   RAW edge `state piece → copy → gather`, ordered by the algebra like any other, no barrier
   special-casing. `Reload` dissolves; the executor's acc-format blit stays as a dispatch arm
   derived from the lease formats, never from an op tag.
3. **Two edge kinds.** RAW (a value before its readers) — mandatory, from the DAG. WAR (a
   reader before the overwrite of its input's address) — exists only where the allocator
   coalesced addresses, and each one is individually tradeable for a copy costing
   min(read-set, write-set). A schedule is any topological order over RAW plus the kept WARs.

## The walk

One DFS in z order over escaping gathers. It only ever **appends** to the one FrameDag —
content piece nodes and per-reader route lists — and never mutates what exists (monotone).

- **Need is local.** At each node the off-frame need is `(reach ⊕ pad) ∖ frame`, computed
  right there; a chain extends its input's rect by its own pad in passing. No demand pass, no
  fixpoint.
- **Never-cut-existing.** Minted pieces are immutable: a later reader never splits or
  reshapes a piece that already exists — that would re-plan work already emitted. Where a new
  need overlaps existing pieces it just reads them as-is; new pieces are minted only for the
  uncovered remainder. The remainder is rect subtraction (≤4 rects per cut), always cut the
  same way (widest horizontal slab first) so a scene always yields the same pieces; tile
  round-out then re-clip absorbs slivers.
- **Sharing = same producer + overlapping domain, nothing else.** A later reader reuses a
  piece only when it wants the exact same input (the same producer node) over an overlapping
  domain. Cross-node equivalence hunting (same op + params over provably equal values — e.g.
  two σ8 blurs fed by different-but-equal states) is deliberately out of scope: where such
  needs overlap, the small overlap is computed twice. No fingerprints, no epsilon.
- **Prefix / z.** An off-frame reader needs the accumulator *state* at its z, and a state is a
  fold over the writers below it. One shared `fold_expressible` predicate — derived from the
  op's own-texel fold structure, never an enumerated effect list — splits those writers in
  two. A fold-expressible writer (its contribution is `state' = f(state)` per texel) gets a
  **step piece** applying `f` over just (writer reach ∩ need): outside that window the state
  is unchanged, so readers read the lower state's pieces directly (the alias partition; zero
  new pixels). Every other writer is simply re-drawn into the piece with its blend baked into
  the recorded draws. The same predicate also decides the sink's run ranges — the Δ244
  corruption class exists exactly when the two disagree, which is why it is one function.
  Nothing in the walk branches on effect identity: pads, reaches and remaps are op data keyed
  on `UnitOp`.
- **Coverage, not routes.** The walk records which pieces cover each reader's need — planner
  bookkeeping only. There is no multi-route machinery anywhere, planner or GPU: coverage
  larger than one piece is discharged at finalize by a combine, and every mark in the lowered
  plan is born with exactly ONE route (the shipped single-route record).

## Finalize — numbers on a fixed topology

Runs once, after the walk; inserts nodes but never re-plans the walk's cuts.

1. **Density.** k is an operation, not an attribute. Every reader carries ONE authored
   number, its **ask** (`acceptable_downscale`, k ∈ (0,1], default 1 = full res): the
   density it wants, a ceiling the planner never exceeds — finer than asked is waste, and
   the planner never grants coarseness on its own. There is no authored floor: a per-effect
   quality bound the emergency squeeze would breach anyway is a hint dressed as a promise.
   Finalize picks each piece's k downward only: the finest ask among its readers; when the
   byte budget doesn't fit, one uniform √ squeeze lowers every k proportionally below the
   asks (hard floor 1/64 — coarse-but-correct beats the edge clamp; a piece is never
   dropped); under unified placement the squeeze is VRAM-only. `Resample{k}` nodes go on k-crossing edges; segments
   between resamples are single-k, so mixed-k reads are impossible by construction. A ≤2:1
   resample fuses into consumer taps exactly (bilinear at the 2×2 block center is the box
   filter); deeper ratios materialize a halving ladder whose last rung fuses. The one
   surviving cross-density read is the frame-boundary serve (route k in the record).
2. **Fragmentation.** A reader (frame mark or piece) whose coverage is more than one piece
   gets a **combine**: one transport assembling its sources into one contiguous lease; the
   reader ends with exactly ONE route. Fold parity puts pieces at odd/even depth on opposite atlas
   sides structurally, so a cross-parity combine needs one re-side first — it always packs
   into an existing round. Priced alternatives the planner may take per node: a combine of
   same-class replay pieces can instead be a fresh replay over the union window; a writer
   step's transport arm doubles as the combine when co-located; placement may lay sources
   grid-adjacent and elide the combine entirely.
3. **Sides.** 2-colouring along sample edges (parity_colours); collisions discharge by law 2.
   A piece pass samples only the non-written atlas (both bound, written one dummy-swapped).
4. **Allocation.** Interval leases from the deaths schedule() already computes. Address
   coalescing: in place iff own-texel (the accumulator chain is the maximal case — N states,
   one address, zero copies); reuse-after-death for everything else. Every coalescing choice
   introduces a WAR edge; law 3 prices its buyout (preserve = snapshot the read set, or
   rename = write aside and blit the write set back after readers drain; the blit is
   deferrable and elidable). Coalesce = cheap memory + rigid order; materialize = free order +
   a lease. A per-state knob, not an architecture.
5. **Route records.** The shipped single rec[5]/rec[6] record per mark, signed slack selecting
   the atlas, k ratio in rec6.z. This step emits data only.

## Scheduling and placement

- **One scheduler.** Rounds are what falls out of the edge algebra; within a round, dispatches
  pack by (same write target, inputs ready, disjoint rects). The presented image is the last
  state of the fully-coalesced chain — the existing accumulator path already implements this
  maximal coalescing and needs no rewrite, only this reinterpretation.
- **One grid.** Viewport tiles + a configurable count of slack rows (possibly zero). The flush
  is the execution primitive — a fence, a record-directed store, a register reset, unlimited
  per tile — so a tile is a general worker and a piece's job is appended to whichever tile's
  list is cheapest (quiet frame tiles or slack rows; cost = schedule coupling the planner can
  see via marker density). Capacity is configuration; placement is planning. This kills the
  hard row ceiling, the hopeless-drop case, and most of the trial-pack ladder.

## Serving (P5 — the records transport, EXECUTED 2026-09-09)

Region serving is one row of the operand-records ABI
(`webgpu-vello/docs/operand-records-abi.md`), not a side channel: record 5 is the OVERFLOW role
— `[SRC_REGION, offset x, offset y, k]` (the affine `atlas = pos * k + offset`) plus the
extension row `[lo, lo, hi, hi]` (the lease's texel rect, clamping strays to lease edge-extend).
`fx_region_serves` = route stamped ∧ position out-of-frame ∧ mapped point in-lease; band
positions are out-of-frame by construction, so piece arms route through the same row. One route
per mark; multi-route serving stays out of scope — crop/combine replaced it (cost basis: bounded
O(area) copies paid rarely beat an über-shader register/occupancy tax paid on every dispatch).

There is ONE lease store (`wv region atlas`), read-only in every dispatch. Region windows write
a staging texture (`wv region back`) and the sink blits each written lease back right after the
dispatch — a dispatch never binds the texture it writes, so any piece may read any lease and the
whole side/parity subsystem (2-colouring, re-side copies, the dual atlas, the sign-selected
route word, the per-dispatch dummy swap) is deleted rather than satisfied. Transports hop
atlas → back → atlas (a same-texture copy is a subresource conflict). Every raw encoder copy
that observes a phased dispatch's writes flushes the deferred dispatch queue first
(`phase_dispatch_flush`) — recorded ahead of that flush it reads the pre-dispatch texels, the
bug that silently degraded the P3/P4 transport blits.

Kernels never know regions; taps are device-space point samples. In-frame and off-frame outputs
partition at the frame edge and stitch by construction (same draws, same σ, same fold on both
sides — the 3σ reach convention makes the seam exact); the only doubled work is a pad-margin
replay where a piece's window dips in-frame, and its priced alternative is a snapshot copy
under law 2.

## What dissolves / what survives

Dissolves: the frame/region lane split; multi-route serving and its gutters; the parallel
extension graph and its realization block; the band functor (already demolished); the 48k-tile
row ceiling; hopeless-drop; most of trial-pack; the mixed-k kernel artifact class; per-op
fallback policy tables; effect-named piece constructors (push_region/push_region_blur) — a
piece is minted by ONE op-generic constructor over any UnitOp, so no planner entry point names
an effect; `UnitOp::Reload` — the backdrop snapshot is the transport node's preserve arm
(law 2), so a gather reads its state piece through an ordinary copy and reader wiring keys on
that copy node; the parity/sides subsystem and the dual chain atlas (P5: the staging write-back
removes the read-while-write hazard the colouring existed to satisfy); the rec5/rec6 route
bolt-on (P5: the route is operand record 5); demand.rs (its squeeze re-fed into finalize).

Survives untouched: RegionTable; pack(); parity_colours() (the draft scratch colouring — its
region user is gone); schedule() and its deaths; wire_region_reader (op-agnostic reader
wiring); the Cell CONTRACT (planner decides everything, executor is a dumb VM, no kind tags);
`fx_bilin_input` stays unhooked (crop-shifted positions — Δ142 when violated).

## CPU-checkable invariants (on the lowered plan)

- No pass samples its write storage (own-texel exception) — structural under the staging
  write-back: region windows write `wv region back`, never the sampled atlas.
- Every read inside its producer's lease interval.
- Every mark/route/lease maps back to a node or edge.
- One node's pieces pairwise disjoint; one route per mark.
- Every kept WAR edge's overwrite follows the old tenant's last reader.

## Worked example — four snapshots

Scene: a frame; z0 background art escaping the left and bottom edges; W (z1, backdrop blur σ8)
straddling the bottom-left corner; A (z2, backdrop blur σ8) straddling the left edge, its need
dipping into W's footprint; G (z3, warp) straddling the left edge higher up, outside W's reach.

1. **Walk output (pieces).** Visiting gathers in z: W mints S0·1 (its left column) and S0·2
   (its bottom slab). A's need overlaps S0·1 — same producer, so it reads it as-is and mints
   only S0·3 for the uncovered remainder. G reads a slice of S0·3 and mints S0·4. A's need
   dips into W's footprint, so W (fold-expressible) gets a step piece over (W reach ∩ A need);
   everywhere else A reads the S0 pieces directly (the state is unchanged there). Coverage
   sets so far are planner data: e.g. G's is {S0·4, S0·3-slice}.
2. **Finalize (transports on the fixed topology).** W's blur input coverage {S0·1, S0·2,
   S0·3-slice} → combine C0. G's {S0·4, S0·3-slice} → combine C2. A's input is state S1:
   {S1 step, S0·1-slice, S0·3-slice} → combine Cᴬ (preceded by one re-side iff fold parity
   put the step on the other atlas). W's chain: X8 = blur-X(C0), Y8 = blur-Y(X8) — the step
   reads the FULL chain, X and Y. A's chain: X8ᴬ = blur-X(Cᴬ) — A re-blurs its own input; it
   does not borrow W's blur (the sharing rule; the recomputed overlap is one small window).
   Every reader ends with ONE route.
3. **Allocation.** The frame states F·S0…F·S3 coalesce onto one address α (own-texel ⊕); the
   kept WAR edges order that chain, each individually buyable out with a snapshot copy. C2's
   lease opens at its combine and lives to G's composite — the longest interval in the plan.
4. **Schedule (one scheduler, 9 rounds).** R1 F·S0@α ∥ S0·1..4 (2 dispatches) · R2 C0 + C2
   (one packed dispatch) · R3 X8 · R4 Y8 · R5 F·S1@α (W ⊕; routes → C0, X8) ∥ S1 step (C0 ⊕
   Y8 ⊗ tint, masked) — the old "lanes" share a round · R6 Cᴬ · R7 X8ᴬ · R8 F·S2@α (A ⊕;
   routes → Cᴬ, X8ᴬ) · R9 F·S3@α (G ⊕; route → C2) → present.

## Build order

Each phase ends at its testable point; the standard gate suite is: oracle 14 (judged vs
reference; overflow docs direct-vs-reference, never vs-tiled), battery 25 vs
`.vello-proofs/levelb-base/`, edge-stale 6/6, units both profiles `--test-threads=1`,
fine.wgsl parse check after any shader-adjacent change (none is planned). No persistent gates
or env switches are left behind.

- **P1 — the walk, CPU only.** Piece emission with local need, never-cut-existing cuts,
  same-producer sharing, step minting with the alias partition, coverage sets. Golden unit
  tests on hand DAGs: L-shaped cut, first-come-keeps-whole, same-producer overlap alias, step
  window at a writer reach, slab determinism. Nothing wired into sink.
- **P2 — finalize, CPU only.** k resolution + Resample insertion, fragmentation discharge
  (combine + parity-forced re-side), side colouring with law-2 copies, interval leases, the
  invariant checker. Golden tests: parity collision, cross-parity combine, coalescing WAR
  edges and their buyout accounting, ladder depth.
- **P3 — the swap.** sink drives walk + finalize and lowers onto the shipped runtime
  vocabulary (shelf allocation initially; marks; single routes; the existing dispatch arms).
  Full gate suite; every oracle case judged equal-or-better vs the recorded clamp baselines.
- **P4 — density live.** Resample fusion ≤2:1, the halving ladder, the budget slide; density
  oracle cases. Requires P3 to measure.
- **P5 — unified placement.** Flush-hosted jobs on frame tiles + slack rows; delete the row
  ceiling and trial-pack; perf teeth on the stress scenes.
- **P6 — coalescing buyouts.** Priced WAR discharge (snapshot / rename-blit). Overlaps the
  queued accumulator-rework arc; lands wherever sequencing says.

## Risks

- The step/fold correctness lives or dies on the shared `fold_expressible` predicate and the
  full chain (X **and** Y) in step inputs — both bitten before, both gated by P1/P2 goldens.
- Combine traffic on pathological scenes (sparse reader, huge fragmented domain) — the
  replay-instead-of-copy arm is the relief valve; priced, visible in the plan.
- Placement cost model quality only affects perf, never correctness (invariants are
  placement-independent).
- Interval reuse turns allocator bugs into read-after-death corruption — the checker's
  interval rule exists precisely so these surface as CPU test failures.
