# Interaction-cost benches: drag / pan / zoom with gather + scatter effects

Adds three categories of CPU-only benches that measure `tile_grid` rebuild cost
**per interaction frame**, not just one-shot scene construction. Complements
the existing `bench_rebuild_full_*` suite (which measures static rebuild only).

## What is measured

Each bench builds a scene with `n_shapes` plain shapes plus `n_gathers` glass
shapes and `n_scatters` texture shapes (same scene scaffolding as
`end_to_end_rebuild_full`), then mutates one shape's `selrect` (drag) or the
`Viewbox` (pan / zoom) **once per frame** and calls `grid.rebuild(&pool, &tv,
scale)`. Reported metric: ms per frame, averaged over 100 frames.

This is the part of an interaction the browser pays on the CPU thread before
any GPU work; the actual Skia paint phase lives in the browser and is not
measured here.

### New benches added (`render-wasm/src/tile_grid.rs`, mod `bench`)

| Bench | Scene | What moves |
|---|---|---|
| `bench_drag_plain_in_scene_baseline` | 1k plain, 0 G, 0 S | a plain shape |
| `bench_drag_plain_in_scene_5_gathers_5_scatters` | 1k plain, 5 G, 5 S | a plain shape |
| `bench_drag_plain_in_scene_20_gathers_20_scatters` | 1k plain, 20 G, 20 S | a plain shape |
| `bench_drag_gather_alone` | 1k plain, 1 G, 0 S | the gather shape itself |
| `bench_drag_gather_with_peers` | 1k plain, 5 G, 5 S | the first gather shape |
| `bench_drag_scatter_with_peers` | 1k plain, 5 G, 5 S | the first scatter shape |
| `bench_pan_sweep_baseline` | 1k plain, 0 G, 0 S | viewbox pan_x −60 px/frame |
| `bench_pan_sweep_with_effects` | 1k plain, 5 G, 5 S | viewbox pan_x −60 px/frame |
| `bench_zoom_sweep_baseline` | 1k plain, 0 G, 0 S | viewbox zoom 0.25× → 4× geometric |
| `bench_zoom_sweep_with_effects` | 1k plain, 5 G, 5 S | viewbox zoom 0.25× → 4× geometric |
| `bench_drag_plain_in_scene_10k_baseline` | 10k plain, 0 G, 0 S | a plain shape |
| `bench_drag_plain_in_scene_10k_5_gathers_5_scatters` | 10k plain, 5 G, 5 S | a plain shape |
| `bench_drag_plain_in_scene_10k_20_gathers_20_scatters` | 10k plain, 20 G, 20 S | a plain shape |
| `bench_drag_gather_with_peers_10k` | 10k plain, 5 G, 5 S | the first gather shape |
| `bench_drag_scatter_with_peers_10k` | 10k plain, 5 G, 5 S | the first scatter shape |
| `bench_pan_sweep_10k_baseline` | 10k plain, 0 G, 0 S | viewbox pan_x −60 px/frame |
| `bench_pan_sweep_10k_with_effects` | 10k plain, 5 G, 5 S | viewbox pan_x −60 px/frame |
| `bench_zoom_sweep_10k_baseline` | 10k plain, 0 G, 0 S | viewbox zoom 0.25× → 4× geometric |
| `bench_zoom_sweep_10k_with_effects` | 10k plain, 5 G, 5 S | viewbox zoom 0.25× → 4× geometric |

A shared `build_drag_scene` helper returns `(pool, plain_ids, gather_ids,
scatter_ids)` so the three groups share an identical scaffold.

### Viewbox sizes (interpretation caveat)

The drag benches use a **6400×6400** viewbox (interest rect covers the whole
test scene), inherited from `end_to_end_rebuild_full`. The pan/zoom benches
use a realistic **1920×1080** browser viewport. Drag numbers are therefore
**pessimistic** — they measure rebuild cost when the interest rect contains
the entire scene. Real drag interactions in the browser pay the cost of
rebuild over the actual viewport (much smaller). Pan/zoom numbers reflect
realistic viewport size. **Compare drag vs. drag, pan vs. pan, zoom vs. zoom;
do not compare drag vs. pan/zoom directly.**

## How they were run

Inside the Penpot devenv container (linux/amd64), release profile, with the
`tile-scheduler` feature enabled (the entire `tile_grid` module is gated on it
via `#![cfg(feature = "tile-scheduler")]`).

```sh
docker run --rm --platform linux/amd64 \
    -e CURRENT_USER_ID=1000 \
    -v $PWD:/home/penpot/penpot:rw \
    -w /home/penpot/penpot/render-wasm \
    penpotapp/devenv:latest bash -lc '
export SKIA_BINARIES_URL="https://github.com/penpot/skia-binaries/releases/download/0.93.1/skia-binaries-319323662b1685a112f5-x86_64-unknown-linux-gnu-gl-svg-textlayout-binary-cache-webp.tar.gz"
export CARGO_BUILD_TARGET="x86_64-unknown-linux-gnu"
cargo test --release --bin render_wasm --features tile-scheduler \
    bench_drag_plain bench_drag_gather bench_drag_scatter \
    bench_pan_sweep bench_zoom_sweep \
    -- --show-output --test-threads=1 --nocapture
'
```

Substring filtering means each filter must be passed as a separate
`cargo test` invocation if you want multiple groups.

Host: Apple Silicon under Rosetta running the linux/amd64 image. Absolute
numbers are platform-dependent; the **deltas** between bench variants are the
useful signal.

## Results — median of 3 runs (ms/frame unless noted)

### 1. Drag a plain shape with gather/scatter peers present

#### 1k scene (viewbox 6400×6400)

| Variant | r1 | r2 | r3 | **median** |
|---|---:|---:|---:|---:|
| 1k plain, 0 G, 0 S | 1.194 | 1.166 | 1.246 | **1.194** |
| 1k plain, 5 G, 5 S | 1.891 | 1.916 | 1.941 | **1.916** |
| 1k plain, 20 G, 20 S | 4.125 | 4.080 | 4.177 | **4.125** |

#### 10k scene (viewbox 6400×6400)

| Variant | r1 | r2 | r3 | **median** |
|---|---:|---:|---:|---:|
| 10k plain, 0 G, 0 S | 50.823 | 51.194 | 53.069 | **51.194** |
| 10k plain, 5 G, 5 S | 51.562 | 51.593 | 55.942 | **51.593** |
| 10k plain, 20 G, 20 S | 59.395 | 59.562 | 59.211 | **59.395** |

At 1k, 5 G + 5 S adds **~0.7 ms/frame** (+60%); 20 G + 20 S adds
**~3 ms/frame** (+245%). Effects add bands roughly linearly; with a 1k
canvas band-construction cost dominates over shape-walk cost.

At 10k, the cost shape changes: baseline is **~51 ms/frame** vs. ~1.2 ms
at 1k — a 43× jump from a 10× shape-count increase. Effect overhead in
relative terms shrinks: 5 G + 5 S adds only **~0.4 ms** (+0.8 %), 20 G +
20 S adds **~8 ms** (+16 %). Dominant cost at 10k is the linear shape walk
in `rebuild`, not the band/gather barrier work. Effects matter less per
shape; per-shape cost matters more.

### 2. Drag the effect shape itself (cache invalidation cost)

#### 1k scene

| Variant | r1 | r2 | r3 | **median** |
|---|---:|---:|---:|---:|
| Drag gather alone (1k plain, 1 G, 0 S) | 1.206 | 1.215 | 1.245 | **1.215** |
| Drag gather (1k plain, 5 G, 5 S) | 1.852 | 1.862 | 1.914 | **1.862** |
| Drag scatter (1k plain, 5 G, 5 S) | 1.867 | 1.898 | 1.919 | **1.898** |

#### 10k scene

| Variant | r1 | r2 | r3 | **median** |
|---|---:|---:|---:|---:|
| Drag gather (10k plain, 5 G, 5 S) | 51.694 | 52.034 | 52.445 | **52.034** |
| Drag scatter (10k plain, 5 G, 5 S) | 52.579 | 53.224 | 52.549 | **52.579** |

Dragging the gather is **not measurably more expensive** than dragging a
plain shape in the same scene at any tested size (1k: 1.86 vs. 1.92;
10k: 52.0 vs. 51.6 — within noise). The schedule rebuild already
recomputes everything from `pool` state, so which shape changed doesn't
add work. Same conclusion for scatter.

Critical finding for the gather/scatter refactor: there is no extra
"moving the gather invalidates a snapshot" tax at the CPU/scheduler
level. Any extra cost would have to come from GPU-side cache invalidation
(snapshot textures), which this CPU bench does not exercise.

### 3. Pan / zoom sweep across the scene (viewbox 1920×1080)

#### 1k scene

| Variant | r1 | r2 | r3 | **median** |
|---|---:|---:|---:|---:|
| Pan-sweep, 1k, 0 G, 0 S | 0.579 | 0.572 | 0.575 | **0.575** |
| Pan-sweep, 1k, 5 G, 5 S | 0.744 | 0.731 | 0.727 | **0.731** |
| Zoom-sweep, 1k, 0 G, 0 S | 0.638 | 0.653 | 0.658 | **0.653** |
| Zoom-sweep, 1k, 5 G, 5 S | 1.092 | 1.062 | 1.061 | **1.062** |

#### 10k scene

| Variant | r1 | r2 | r3 | **median** |
|---|---:|---:|---:|---:|
| Pan-sweep, 10k, 0 G, 0 S | 8.370 | 8.529 | 8.610 | **8.529** |
| Pan-sweep, 10k, 5 G, 5 S | 8.465 | 8.389 | 8.509 | **8.465** |
| Zoom-sweep, 10k, 0 G, 0 S | 12.719 | 13.103 | 12.889 | **12.889** |
| Zoom-sweep, 10k, 5 G, 5 S | 13.137 | 13.874 | 13.398 | **13.398** |

At 10k, pan-sweep is **~8.5 ms/frame** — fits inside the 60 fps budget
(16.6 ms) with margin. Effects do not move the needle (8.46 with effects
vs. 8.53 baseline — within noise; effect-tile-expansion is constant cost
relative to walking 10k shapes through `rebuild`).

Zoom-sweep at 10k is **~13 ms/frame** — still fits 60 fps, but tightly,
and ~50 % more expensive than pan because tile-size changes invalidate
the spiral and the per-zoom-step gather sample-region recomputation
grows. With effects, zoom drops ~3 ms of margin under 16.6 ms.

## Cross-reference: existing benches (run 1, same docker session)

For context with the new numbers:

| Bench | result |
|---|---:|
| `bench_rebuild_full_1k_baseline` | 1.159 ms/iter, 1748 schedule, 24 bands |
| `bench_rebuild_full_1k_5_scatters` | 1.264 ms/iter, 1773 schedule, 27 bands |
| `bench_rebuild_full_1k_5_gathers_5_scatters` | 1.843 ms/iter, 1891 schedule, 71 bands |
| `bench_rebuild_full_10k_baseline` | 50.059 ms/iter, 14020 schedule, 144 bands |
| `bench_rebuild_full_10k_with_effects` (20 G, 20 S) | 57.810 ms/iter, 14691 schedule, 334 bands |
| `bench_tilegrid_single_shape_drag_latency` (raw, no rebuild, 10k) | 0.3 µs/move |

Note `bench_rebuild_full_1k_baseline` (1.16 ms) ≈
`bench_drag_plain_in_scene_baseline` (1.19 ms). The drag bench is, in
effect, "rebuild × N frames" plus a single `selrect` write — the per-frame
extra is dominated by the rebuild. So the existing rebuild benches were
already a fair proxy for drag cost; what was missing was the *interaction
+ effects* combination, where band counts grow.

`bench_tilegrid_single_shape_drag_latency` is a different measurement —
it bypasses `rebuild` and directly mutates the tile index. That's
measuring the lower bound (move-only with zero scheduling work, ~0.3 µs);
the new drag benches measure the realistic path the renderer actually
takes per frame (full rebuild, ~1–4 ms).

## Headline findings

1. **At 1k shapes, effects dominate drag cost; at 10k, the shape walk
   dominates.** At 1k, going from 0/0 → 20/20 effects triples drag cost
   (1.2 → 4.1 ms). At 10k, the same 0/0 → 20/20 step adds only 16 %
   (51 → 59 ms). The shape-iteration in `rebuild` outweighs the
   band/barrier work once shape count gets large.

2. **No extra cost for moving the gather/scatter itself.** Dragging the
   gather costs the same as dragging an adjacent plain shape in the same
   scene at both 1k (1.86 vs 1.92) and 10k (52.0 vs 51.6). The scheduler
   is fully rebuilt from `pool` state per frame; which shape changed
   doesn't matter.

3. **Pan/zoom at 10k still fits 60 fps; drag at 10k does not.** With
   the realistic 1920×1080 viewport, pan-sweep at 10k is ~8.5 ms/frame
   (effects irrelevant), zoom-sweep is ~13 ms/frame (effects negligible).
   Both fit the 16.6 ms budget. Drag at 10k under the pessimistic
   6400×6400 interest rect is ~51–59 ms/frame — way over budget.

4. **10k drag exceeds the 60 fps budget under full-scene rebuild.**
   `rebuild` over a 10k-shape interest-rect is fundamentally ~50 ms;
   per-frame full rebuild during drag is not viable for that size.
   **Implication:** drag on large canvases needs an incremental rebuild
   path (touch only the changed shape's tiles + its gather sample
   region) or a smaller viewport-bound interest rect. The new drag
   benches give the rebuild-per-frame baseline that an incremental path
   must beat.

5. **Pan-sweep at 10k is much cheaper than drag at 10k**, but this is
   partly an artifact of the viewbox sizes the two benches use (1920×1080
   for pan, 6400×6400 for drag). Pan with the same 6400×6400 viewbox would
   pay closer to drag-baseline cost; that bench variant is not currently
   added.

## Reproducing

```sh
# from repo root
docker run --rm --platform linux/amd64 \
    -e CURRENT_USER_ID=1000 \
    -v $PWD:/home/penpot/penpot:rw \
    -w /home/penpot/penpot/render-wasm \
    penpotapp/devenv:latest bash -lc '
export SKIA_BINARIES_URL="https://github.com/penpot/skia-binaries/releases/download/0.93.1/skia-binaries-319323662b1685a112f5-x86_64-unknown-linux-gnu-gl-svg-textlayout-binary-cache-webp.tar.gz"
export CARGO_BUILD_TARGET="x86_64-unknown-linux-gnu"
for f in bench_drag_plain bench_drag_gather bench_drag_scatter \
         bench_pan_sweep bench_zoom_sweep; do
  cargo test --release --bin render_wasm --features tile-scheduler $f \
      -- --show-output --test-threads=1 --nocapture 2>&1 | grep "\[bench\]"
done
'
```

`--features tile-scheduler` is required — the entire `tile_grid` module
is gated on it. Without the feature, the benches do not appear in
`--list` and `cargo test` silently filters them out.
