# Visual capture harness

Capture-only screenshots of the perf bench scenes for manual visual diff.
No pixel-level assertion — diff is performed by a human (or LLM) reading
the PNGs side-by-side.

## Layout

```
test/visual/
  cells.ts           # (scene, scenario, frame) cells to capture
  runner.spec.ts     # playwright spec — drives perf-page + writes PNG
  baselines/         # committed reference PNGs (golden state)
  screenshots/       # gitignored, working-set output
```

## Workflow

1. After landing a known-good change, regenerate baselines:
   ```sh
   pnpm run visual:baseline
   ```
2. Working iteration:
   ```sh
   pnpm run visual:capture     # writes test/visual/screenshots/
   ```
3. Eyeball diff: open `baselines/<scene>__<scenario>__f<frame>.png` and
   `screenshots/<scene>__<scenario>__f<frame>.png` side-by-side.

Capture takes ~20s for 12 cells.

## Cell selection rationale

Each cell exercises one rendering path:

- `iso_groups_100` × {idle, pan, zoom} — V2c.3 subtree-cache target.
- `iso_text_200` — text render path.
- `iso_svg_50` — SVG render path.
- `iso_masked_50` — masked group two-pass plumbing.
- `iso_opacity_500` × {idle, zoom} — V2c.2 leaf opacity.
- `iso_layer_blur_200` — V2c.1 leaf layer-blur cache.
- `flat_baseline` — sanity baseline.
- `nested_d3_b5_no_fx` — nested-no-fx baseline.
- `mixed_kitchen_sink` — heterogeneous coverage.

## Known broken cells

Several baselines are **blank** (white) on the V2c.2 build. These flag
existing renderer bugs the visual harness surfaced:

| Cell | Status | Root cause |
|---|---|---|
| `iso_opacity_500__idle__f30` | blank | Leaf-opacity slow path in `render_shape` produces no visible pixels under tile-scheduler. Pre-V2c.2 silently dropped alpha; V2c.2 BeginLayer wraps but the blit chain still produces blank. Needs `render_shape` slow-path audit. |
| `iso_opacity_500__zoom__f30` | partial | Zoom invalidates tile cache, fresh schedule renders opaque squares (no opacity composition). Same underlying bug as `idle`, but not from cache. |
| `iso_layer_blur_200__idle__f30` | blank | Likely same `render_shape` slow-path issue (`needs_layer()` true on layer-blur shapes). |
| `iso_masked_50__idle__f30` | blank | Masked group two-pass scheduler integration incomplete. Mask is `children.first()`, currently doesn't clip remaining leaves. |
| `iso_svg_50__idle__f30` | blank | SVG `dom.render()` paints at viewBox origin; no shape transform mapped to selrect. |
| `nested_d3_b5_no_fx__idle__f30` | blank | Container clip + leaf-grid layout puts most leaves outside container selrect. Pre-existing bench layout limitation, no scheduler bug. |
| `mixed_kitchen_sink__idle__f30` | blank | Same nested-layout issue as above plus heterogeneous shadows. |

All of the above are **pre-existing** bugs the visual harness exposes —
not introduced by the visual infra itself. Each is a candidate
follow-up (V2c.2.1: opacity slow-path; V2c.3.4: masked; V2c.3.2: SVG;
container layout cleanup; etc).

## Working cells

The four green cells confirm the harness captures real renderer output
correctly:

- `flat_baseline__idle__f30` — 50 colored rects, vivid.
- `iso_text_200__idle__f30` — "Hello world" grid in colored text.
- `iso_groups_100__{idle,pan,zoom}` — 5 group-containers visible with
  pastel children (opacity = 0.6 on container working).

These are the regression-guard cells. Any V2c.3 work that breaks
opacity composition on groups or text rendering will show up
immediately on `visual:capture`.
