# V2c.3 — Container Subtree Cache

> Status: planned. Builds on V2c.1 (leaf layer-blur cache), V2c.2 (BeginLayer/EndLayer scaffold).

## Goal

Snapshot composited container subtree (children rendered + opacity/blend applied) into bbox-bounded scratch once per frame. Cache cross-frame in `effect_cache`. Per-tile = blit cached image. Eliminates per-tile children re-render for unchanged subtrees with opacity/blend.

Same pattern as V2c.1 (leaf layer-blur) extended to recursive containers.

## Why now

V2c.2 externalized `save_layer` for containers but the per-tile schedule still re-renders every child inside the layer per band/tile. Designer files contain many groups with opacity (panels, modals, cards). Pan / idle / zoom-hold should run ~free for unchanged subtrees.

## Scope (V2c.3 cut 1)

In:
- Containers (Frame/Group) with `shape_qualifies_for_external_layer(shape)` (opacity<1 or blend≠SrcOver, no masked, no frame-clip blur, no bg_blur, no glass)
- Subtree fits Filter scratch capacity at current scale
- Subtree is "pure": leaf-only (depth-1), no scatter/gather/text/SVG/inherited-blur descendants

Out (deferred to V2c.3.x phases):

| Excluded category | Reason | Follow-up phase |
|---|---|---|
| `bg_blur` / `glass` (gather) inside subtree | Backdrop dependency. Subtree-cache scratch has empty backdrop; gather would sample transparent pixels. **Hard exclusion** — only fix is embedding gather build inside the subtree cache build (snapshot backdrop too). | V2c.4 |
| Text leaves | Hash key complexity (font + style + content + paragraph config). Render path itself works (`render_shape` handles `Type::Text` into Filter). | V2c.3.1 |
| SVGRaw leaves | Hash key complexity (DOM-equivalent fingerprint). Render path works. | V2c.3.2 |
| Scatter (texture) leaves | Nested cache build inside subtree build (scatter has its own `render_to_image`). Plumbing. | V2c.3.3 |
| Masked groups | Two-pass content+mask DstIn plumbing must run on Filter target. Restructure of `render_shape_enter`/`exit` two-pass logic. | V2c.3.4 |
| Frame-clip layer-blur containers | Same shape as opacity layer + extra blur image filter. Cache key must include sigma. | V2c.3.5 |
| Inherited blur (parent layer-blur, child rendered with it) | Cache key must include ancestor blur stack. State threading at emit time. | V2c.3.6 |
| Nested recursive subtrees (depth-N qualified container inside qualified container) | Recursion depth handling, per-level extent budgeting. | V2c.3.7 |

Each follow-up = one phase, each measurable, each shippable independent. V2c.3 cut 1 hits the dominant designer pattern (panels, cards) at ~80% real-world coverage.

## Design

### Types

```rust
pub enum CacheKind {
    Scatter(Uuid),
    Gather(Uuid),
    LocalBlur(Uuid),
    Subtree(Uuid),       // NEW
}

pub enum LocalFx {
    ShapeBody,
    LayerBlur,
    SubtreeBlit,         // NEW
}
```

### `render::subtree` module (mirrors `render::local`)

```rust
pub enum SubtreeKind<'a> {
    OpacityComposite { layer: LayerPaint, _shape: &'a Shape },
}

impl<'a> SubtreeKind<'a> {
    pub fn from_shape(shape: &'a Shape, tree: ShapesPoolRef) -> Option<Self>;
    pub fn extent_world(&self, shape: &Shape, tree: ShapesPoolRef) -> skia::Rect;
    pub fn params_hash(&self, shape: &Shape, tree: ShapesPoolRef) -> u64;
    pub fn render_to_image(&self, state: &mut RenderState, shape: &Shape, tree: ShapesPoolRef) -> Option<(skia::Image, skia::Rect)>;
    pub fn paint_cached(state: &mut RenderState, image: &skia::Image, world_bbox: skia::Rect, output: SurfaceId);
}

pub fn shape_qualifies_for_subtree_cache(shape: &Shape, tree: ShapesPoolRef) -> bool;
fn subtree_has_uncacheable(shape: &Shape, tree: ShapesPoolRef) -> bool;
```

### Predicate

```rust
fn subtree_has_uncacheable(shape: &Shape, tree: ShapesPoolRef) -> bool {
    for cid in shape.children_ids(false) {
        let Some(c) = tree.get(&cid) else { continue };
        if c.is_recursive() { return true; }  // V2c.3 cut 1: depth-1 only
        if matches!(c.shape_type, Type::Text(_) | Type::SVGRaw(_)) { return true; }
        if c.background_blur.is_some_and(|b| !b.hidden) { return true; }
        if c.glass.as_ref().is_some_and(|g| !g.hidden) { return true; }
        if c.texture.as_ref().is_some_and(|t| !t.hidden && t.radius > 0.0) { return true; }
        if matches!(&c.shape_type, Type::Group(g) if g.masked) { return true; }
        if c.has_frame_clip_layer_blur() { return true; }
        if c.blur.is_some_and(|b| !b.hidden && b.value > 0.0) { return true; }
    }
    false
}
```

### Hash key

```rust
fn hash_subtree(shape: &Shape, tree: ShapesPoolRef, h: &mut impl Hasher) {
    shape.id.hash(h);
    shape.transform.hash(h);
    shape.opacity.to_bits().hash(h);
    (shape.blend_mode.0 as u8).hash(h);
    hash_shape_geometry(shape, h);
    for cid in shape.children_ids(false) {
        if let Some(c) = tree.get(&cid) {
            hash_leaf_full(c, h);  // depth-1 in cut 1
        }
    }
}
```

Cost: O(subtree size) per emit. Mitigation if hot: per-shape `dirty_revision: u64` bumped on edit, parent fold of children's revisions. Same pattern as `scene_revision`.

### Schedule emission

In `emit_shape_steps_checked` container path:

```rust
if shape_qualifies_for_subtree_cache(shape, tree) {
    let has_band_content = subtree_has_band_shape(shape, tree, band_shapes)
        || band_shapes.contains(&shape_id);
    if has_band_content {
        self.emit_cache_build_for_shape(shape_id, shape);  // adds Subtree(id)
        self.schedule.push(RenderStep::Paint {
            shape: shape_id,
            actions: vec![PaintAction::Render {
                input: SurfaceInput::None,
                output: SurfaceId::Current,
                effects: vec![EffectKey::Local(LocalFx::SubtreeBlit)],
            }],
        });
        return true;
    }
    return false;
}
// existing legacy recursive emit (BeginLayer/Enter/.../Exit/EndLayer)
```

`emit_cache_build_for_shape` adds `Subtree(id)` LAST (after gather/scatter/local-blur — those can't appear in a cacheable subtree per predicate).

### Dispatcher

```rust
CacheKind::Subtree(id) => { /* effect_cache lookup, render_to_image on miss, store via surfaces.insert_subtree_output */ }

EffectKey::Local(LocalFx::SubtreeBlit) => {
    if let Some((image, bounds)) = self.surfaces.get_subtree_output(id) {
        SubtreeKind::paint_cached(self, &image, bounds, output);
    } else {
        // Defensive fallback: legacy recursive emit was skipped at schedule
        // build time, so re-render inline. Mirrors LocalFx::LayerBlur fallback.
        self.render_subtree_inline(id, tree, output)?;
    }
}

CacheKind::Subtree(id) => self.surfaces.remove_subtree_output(id), // FreeCache arm
```

### Critical implementation gotcha

`render_shape` writes to per-aspect `Fills` / `Strokes` / `InnerShadows` surfaces, then `apply_drawing_to_render_canvas` composites onto target.

For subtree cache rendering into Filter:
- Either: reuse aspect surfaces, then composite onto Filter.
- Or: bypass aspect surfaces, draw directly to Filter (matches V2c.1 layer-blur pattern).

V2c.1 uses the direct path. V2c.3 needs to recurse children's render. Cleanest = factor `render_shape_into_target(shape, target)` that pipes everything to a single target surface. New helper. Maintain legacy path.

## Validation

### Correctness
- All existing perf scenes 95/95 pass
- Visual diff: render `iso_groups_50` frame, compare scheduler-cached vs legacy. Pixel-for-pixel match required (see Visual Regression section below).
- Edit propagation: modify a leaf inside a cached group, confirm `params_hash` differs → cache rebuild.

### Perf
- `iso_groups_50` idle/pan: -60-80% frame_TOTAL (cache hit, blit-only)
- `iso_groups_50` zoom: small win or neutral (cache miss on scale change, but still avoids per-tile re-render of 5 children × ~16 tiles)
- Real-file test: load designer file with many groups, compare V2c.2 vs V2c.3

## Bench scenes

### New scenes for V2c.3

| Id | Name | Shape | Purpose |
|---|---|---|---|
| 19 | `iso_groups_50` | 50 groups × 5 leaves, group `opacity = 0.6` | Direct V2c.3 target — all groups should hit Subtree cache |
| 20 | `iso_text_200` | 200 text leaves | Text rendering coverage. Currently no iso text scene exists. |
| 21 | `iso_svg_200` | 200 SVGRaw leaves | SVG rendering coverage. Currently no iso SVG scene exists. |
| 22 | `iso_masked_50` | 50 masked groups | Masked group coverage. Validates V2c.3 falls back correctly when predicate excludes. |

`iso_text_200` and `iso_svg_200` are independently valuable — they cover code paths the current bench doesn't touch.

### Existing scenes (no new coverage needed)

- `iso_drop_shadow_200` (id 10) — drop shadows
- `iso_inner_shadow_200` (id 11) — inner shadows
- `iso_layer_blur_200` (id 12) — layer blur (V2c.1 target)
- `iso_bg_blur_100` (id 13) — bg_blur gather
- `iso_glass_100` (id 14) — glass gather
- `iso_texture_200` (id 15) — scatter
- `iso_gradient_500` (id 16) — gradient fills
- `iso_stroke_500` (id 17) — stroke geometry
- `iso_opacity_500` (id 18) — leaf opacity (V2c.2 target)

## Visual regression

### Current state

`render-wasm/docs/visual_regression_tests.md` documents Penpot frontend's visual regression infra under `frontend/playwright/ui/render-wasm-specs/`. Runs against full Penpot UI, not synthetic perf scenes. **No pixel-diff infrastructure exists for the perf bench scenes today**.

### Gap

V2c.3 changes how rendering composites (cached image vs per-tile re-render). Pixel-for-pixel parity required. Current perf bench measures timing only — won't catch silent visual regressions.

### Plan

Add a `visual` subdirectory mirroring `test/perf/` structure:

```
skia-rs-wasm/test/visual/
  runner.spec.ts         # render each (scene × scenario) → screenshot at frame N
  baselines/             # committed reference PNGs (git-LFS or compressed)
  scenes.ts              # imports same SCENES list
```

### Workflow

1. Generate baselines once on V2c.2 commit (`pnpm run visual:bless`)
2. On V2c.3 commit, `pnpm run visual` renders each cell, pixel-diffs against baseline
3. Tolerance: 0 pixels default, configurable per scene for known anti-aliasing variance
4. CI gate: any pixel diff fails the run

### Scope of visual tests for V2c.3

Required cells (smallest set that exercises the cache + fallback paths):

- `iso_groups_50` × { idle, pan, zoom } — direct target, verify cached render matches legacy
- `iso_text_200` × { idle } — confirms text fallback (predicate excludes) renders unchanged
- `iso_svg_200` × { idle } — confirms SVG fallback unchanged
- `iso_masked_50` × { idle } — confirms masked group fallback unchanged
- `iso_opacity_500` × { idle, zoom } — V2c.2 target, regression guard
- `iso_layer_blur_200` × { idle } — V2c.1 target, regression guard
- `mixed_kitchen_sink` × { idle } — heterogeneous coverage

12 cells × 1-2s each = ~30s visual run.

### Bless workflow

```sh
# After landing a known-good change:
pnpm run visual:bless              # regenerate all baselines
git add test/visual/baselines/     # commit
```

### Implementation skeleton

```ts
// test/visual/runner.spec.ts
import { test, expect } from '@playwright/test'
import { SCENES } from '../perf/scenes'

const VISUAL_CELLS = [
  { scene: 'iso_groups_50', scenario: 'idle', frame: 30 },
  { scene: 'iso_groups_50', scenario: 'pan', frame: 30 },
  // ...
]

for (const cell of VISUAL_CELLS) {
  test(`visual: ${cell.scene} | ${cell.scenario}@${cell.frame}`, async ({ page }) => {
    const scene = SCENES.find(s => s.name === cell.scene)!
    await page.goto(`/perf?scene=${scene.id}`)
    await page.waitForFunction(() => Boolean((window as any).perfApi?.ready))
    await page.evaluate(([n, f]: [string, number]) => (window as any).perfApi.runScenario(n, f), [cell.scenario, cell.frame] as const)
    await expect(page.locator('canvas')).toHaveScreenshot(`${cell.scene}-${cell.scenario}-${cell.frame}.png`, {
      maxDiffPixels: 0,
    })
  })
}
```

Playwright's built-in `toHaveScreenshot` handles bless mode (`--update-snapshots`) and pixel diff reporting.

## Rollout

1. Add `iso_text_200`, `iso_svg_200`, `iso_masked_50` scenes (preset ids 20, 21, 22)
2. Build visual regression skeleton + bless V2c.2 baselines
3. Plumbing: `CacheKind::Subtree`, `LocalFx::SubtreeBlit`, `SubtreeKind` module
4. Predicate `shape_qualifies_for_subtree_cache` + recursive check
5. Hash function `hash_subtree`
6. `surfaces.subtree_output_cache` + insert/get/remove
7. Schedule emission (replace recursive emit when qualified)
8. Dispatcher BuildCache(Subtree) + SubtreeBlit + FreeCache(Subtree) arms
9. `render_shape_into_target` helper for clean child recursion
10. `iso_groups_50` scene + `IsolatedFx::OpacityGroups`
11. Build + perf:quick
12. Visual regression run — must be 0-pixel-diff
13. Full perf bench → diff vs v2c2 baseline
14. Commit

## LOC estimate

- New: ~500 (subtree module, schedule emission, dispatcher arms, hash, surface cache, scene)
- Modified: ~50 (CacheKind/LocalFx variants, emit_cache_build_for_shape extension)
- Visual regression infra: ~150 (runner, scene table, baseline mgmt)

## Estimated impact

| Scene | V2c.2 (est) | V2c.3 (est) | Δ |
|---|---|---|---|
| `iso_groups_50` idle | TBD | TBD × 0.3 | -70% |
| `iso_groups_50` zoom | TBD | TBD × 0.7 | -30% |
| `iso_opacity_500` (leaves, not groups) | unchanged | unchanged | 0 |
| `nested_d3_b5_no_fx` (no opacity) | unchanged | unchanged | 0 |
| Real designer file with grouped panels | varies | varies | -10-30% |

## Risks

- **Hash compute cost**: O(subtree size) per emit per band per tile. For 50 groups × ~144 tiles × 1 band = 7200 hash compute calls per frame. At ~200ns each = 1.4 ms/frame overhead. Acceptable but borderline. Mitigation: memoize per (shape_id, scene_revision).
- **Bbox overflow**: groups bigger than Filter scratch (e.g. full-screen panel at 3x DPI) fail predicate, fall back. Document expected fallback rate.
- **Children's drop_shadows**: child shadows extend OUTSIDE child selrect. Subtree extent must include shadow bleeds. Use `shape.extrect()` not `selrect`.
- **CTM stack mismatch**: Filter scratch has its own canvas state. Children's `render_shape` writes per-aspect surfaces by default. Need `render_shape_into_target` helper or accept extra blit per child.
- **Visual diff false positives**: anti-aliasing variance across GPU drivers. Configure `maxDiffPixels` per scene if needed.

## Follow-up phase queue

Each one ships independent, each one measurable:

- **V2c.3.1** — Text leaves inside subtree cache. Add `hash_text` (font + style + content + paragraph config).
- **V2c.3.2** — SVGRaw leaves inside subtree cache. Add SVG DOM hash.
- **V2c.3.3** — Scatter (texture) leaves inside subtree cache. Nested scatter cache build during subtree build.
- **V2c.3.4** — Masked groups inside / as subtree cache. Two-pass content+mask plumbing on Filter target.
- **V2c.3.5** — Frame-clip layer-blur containers. Cache key includes sigma.
- **V2c.3.6** — Inherited blur threading. Cache key includes ancestor blur stack.
- **V2c.3.7** — Nested recursive subtrees (depth-N).
- **V2c.4** — Gather inside subtree (bg_blur, glass). Embed gather build inside subtree build, snapshot backdrop too.
