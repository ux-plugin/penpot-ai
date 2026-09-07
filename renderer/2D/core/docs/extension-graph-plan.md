# Extension graph — the region rewrite plan (draft for review)

## The model

One hazard, stated once: **a pass never writes the storage it reads.** Everything else is
planner bookkeeping over an explicit graph.

- **Domain.** Every DAG node carries the domain its output is computed over: a rect and a
  density `(rect, k)`. Today's nodes implicitly hold "the frame at k=1"; that becomes data.
- **One rewrite rule.** After demand propagation: wherever a node's demanded footprint exceeds
  its domain, insert an **extension node** — same op, domain = spill ⊕ pad — whose inputs are
  the extensions of the original's inputs. Consumers keep their in-domain edge and gain a read
  edge to the extension.
- **Dedup / sharing.** Extensions are keyed by `(node, domain)`. Overlapping demands from
  different readers resolve to ONE extension node with multiple read edges. Sharing is never
  forbidden; whether a shared extension is realized shared or split is a lowering cost call.
- **Roots.**
  - `Rasterize` extends by replaying its recorded draws under the new domain's transform
    (encode once per frame; replay is lease-proportional). Each lease's content is drawn
    **once** — there is no redraw path anywhere in this design.
  - The backdrop extends as a **prefix-composite chain** in z:
    `prefix_0 = ground`, `prefix_i = prefix_{i-1} ⊕ ext(writer_i)` — O(N) in fold depth.
    Any writer whose parts are extensible participates: blur chains, shadows
    (silhouette → blur → colour-over), blend/opacity-grouped bodies (re-emit + pointwise
    compose). This is what closes the ed-fit class without a special case.
- **Copy is a first-class node** with three planner-derived triggers:
  1. *Re-siding* — a pass needs two reads that sit on opposite textures.
  2. *Preservation* — a value will be overwritten (evolving prefix, storage reuse) while a
     later node still reads the old state; snapshot and hold to last reader.
  3. *Pipelining* — decouple execution order from z order: snapshot the state a gather needs
     and let the spine keep drawing (the in-frame `Reload` is exactly this node already).
- **Lowering.** A mechanical pass from graph → runtime plan (leases in the RegionTable, marks,
  routes, texture sides, copy passes, lifetimes). It decides realizations by cost (share vs
  split, where copies go) but invents nothing: every lease, route and mark corresponds to a
  node or edge. Lifetime = liveness: a lease is held until its last reader's pass completes.

## CPU-checkable invariants (on the lowered plan, not the graph)

- No pass writes a texture it reads.
- All reads of one pass are co-sided.
- Every read happens within the producing lease's lifetime.
- Every mark/route/lease maps back to a graph node/edge (nothing hand-built).

The graph itself is unconstrained — the lowering discharges conflicts with copies, so it must
be total: any well-formed graph lowers.

## What dissolves

The band functor; the `BandMark` side-plan; `band_of`, `writes_chain`, `region_draws`,
`region_sil`; the fold's redraw windows and their O(N²) masked-arm replays; the
one-region-per-reader assumption; per-region single k; the `raw_value_substitute`-style
fallback policies (fallback = extension absent, taps fade — decided by the graph, not by op
policy tables).

## Phases

**P1 — graph core, CPU only.** `Domain` on nodes; the rewrite pass as a pure function
(dedup, prefix chain, copy triggers); the lowering to an abstract pass list (sides, copies,
lifetimes); the invariant checker. Golden unit tests on hand DAGs: linear chain, shared
overlap dedup, depth-3 prefix fold, the parity case that forces a re-siding copy, a
preservation hold, forward references. Zero behavior change; nothing wired into sink.
*Testable point: unit suite.*

**P2 — demolition + swap.** Delete the functor and the side-plan maps; sink builds the
rewrite graph and lowers it onto the existing runtime vocabulary (RegionTable leases, marks,
routes, the two atlases). Executor and shaders untouched. Pixels MAY legitimately change on
fold scenes (composite-prefix replaces redraw): each oracle case is judged equal-or-better
against tiled/padded truth, not byte-vs-yesterday; battery re-epochs only with a vs-tiled
justification, per the vpblur precedent.
*Testable point: full gate suite — oracle (all cases ≤ current numbers, stack-deep expected
better), battery, edge-stale, units both profiles.*

**P3 — capabilities the representation unlocks**, each with its own oracle case:
- *Shared extensions live* — two readers with overlapping spill share one extension; expect
  fewer leases and higher k on the editor doc (glass-left Δ24 / bgblur-bottom Δ15 shrink).
- *Per-node k* — trial-pack assigns density per extension; edge-adjacent extensions keep
  k = 1, deep spill degrades first. **k is constant along a chain**: density changes only at
  a reader's boundary read (one bilinear resample total, at the route) — never between hops
  of one chain, where resampling would cascade and compound.
- *Two-input extensions* — knockout/colourless shadows (`EraseBy`): representable now;
  needs a second bound input in the region dispatch (the one executor/shader touch in this
  plan). Case: knockout shadow straddling an edge.
- *Pipelining snapshots* — copy trigger 3 for scheduling freedom; overlaps the queued
  accumulator-rework arc, so it lands there unless sequencing says otherwise.

## Costs

- Nothing new in P1. P2 trades the fold's redraws for lease copies: O(N²) rasterization →
  O(N) composite + one copy where parity demands; measured on the bgblur-stack scenes at P2.
- Sharing (P3) removes today's per-reader ground duplication; its price is copies + lifetime
  holds, chosen per node by the lowering's cost compare.
- The common case stays free: nothing escapes → the rewrite pass finds nothing → no band.

## Risks

- The side-assignment + copy-insertion solver must be total (fallback: copy is always legal),
  and its output is what the invariant checker audits — solver bugs surface as CPU test
  failures, not pixel corruption.
- Share-vs-split needs a policy for partially-overlapping domains (union the rects vs split
  the extension); start with union-if-overlap and let the cost compare veto.
- Composite-prefix changes fold pixels; the oracle's padded truth is itself served on
  overflow docs (ed-fit, stack-deep), so judgments there use the tiled column — already the
  established practice.
- Lease lifetimes are trivial today (shelf is append-only per frame); they become load-bearing
  only if storage reuse lands later — the checker's lifetime rule is written now so that
  change can't silently break reads.

## Decisions (settled with the user)

1. Share-vs-split: **union-if-any-overlap** first; a threshold only if the cost compare later
   earns one with numbers.
2. Pipelining snapshots **stay in this arc** — the accumulator rework is not a sure thing.
3. **No persistent gates.** During development, keep only what is needed to compare a change
   against the immediately previous run for correctness; once the correctness tests cover a
   path, replace outright — no env switches left behind.

## Status

Demolition landed first (per the arc doctrine): the band functor, BandMark side-plan,
`band_of`/`writes_chain`/`region_draws`/`region_sil`, census chain-walkers, route stamping,
the emitter's Region arm and the region-out dispatch arm are gone. Regions never mint; the
oracle's 14 cases PASS on the interior criterion with edge bands reverted to the recorded
clamp baselines (glass-left 80845Δ80, bgblur-bottom 156130Δ80, shadow-right 221647Δ86,
vpblur battery epoch back to clamp, vs-tiled 47456Δ180 — the numbers P2 must beat). Surviving
transport: fine.wgsl serve/tap hooks and permutations, `RegionTable`, the DAG constructors,
`demands()`, `demand.rs`. P1 builds the graph core next.
