import type { ScenarioName } from '../perf/page/perf-types'

/**
 * Visual coverage cells.
 *
 * Each cell renders a (scene × scenario) for `frame` rAF ticks, then
 * captures the canvas. Diff is performed manually — `pnpm visual:capture`
 * dumps PNGs into `test/visual/screenshots/` (or `baselines/` when
 * `VISUAL_OUT_DIR=baselines`); the human (or LLM) reads both sets
 * side-by-side and judges.
 *
 * Set is intentionally small — 12 cells, ~1-2s each, ~30s total. Adds
 * one cell per "interesting" path the renderer takes:
 *
 * - V2c.3 target: `iso_groups_100` × {idle, pan, zoom}
 * - Predicate-fallback paths: text, svg, masked
 * - Regression guards: opacity (V2c.2), layer-blur (V2c.1)
 * - Sanity baselines: flat, nested-no-fx
 */
export interface VisualCell {
  /** Scene name from `test/perf/scenes.ts`. */
  scene: string
  /** Scenario from `test/perf/scenarios.ts`. */
  scenario: ScenarioName
  /** Frame index to capture. Higher = more rAF ticks let the harness settle. */
  frame: number
}

export const VISUAL_CELLS: readonly VisualCell[] = [
  { scene: 'iso_groups_100', scenario: 'idle', frame: 30 },
  { scene: 'iso_groups_100', scenario: 'pan', frame: 30 },
  { scene: 'iso_groups_100', scenario: 'zoom', frame: 30 },
  { scene: 'iso_text_200', scenario: 'idle', frame: 30 },
  { scene: 'iso_svg_50', scenario: 'idle', frame: 30 },
  { scene: 'iso_masked_50', scenario: 'idle', frame: 30 },
  { scene: 'iso_opacity_500', scenario: 'idle', frame: 30 },
  { scene: 'iso_opacity_500', scenario: 'zoom', frame: 30 },
  { scene: 'iso_layer_blur_200', scenario: 'idle', frame: 30 },
  { scene: 'flat_baseline', scenario: 'idle', frame: 30 },
  { scene: 'nested_d3_b5_no_fx', scenario: 'idle', frame: 30 },
  { scene: 'mixed_kitchen_sink', scenario: 'idle', frame: 30 },
  // 3 overlapping frames, topmost has glass — the cache-capture spec
  // also dumps every surface snapshot under
  // `screenshots/iso_glass_3frames_overlap__caches/` for this cell.
  { scene: 'iso_glass_3frames_overlap', scenario: 'idle', frame: 30 },
  // Solo glass child of a frame, no siblings — repros the "black glass"
  // bug when the ancestor's body fill isn't reachable via Current at
  // glass time.
  { scene: 'iso_glass_solo_child', scenario: 'idle', frame: 30 },
  // ── SSA Bucket A: gap-fill cells for the IR rewrite ────────────
  { scene: 'iso_offscreen_scope', scenario: 'idle', frame: 30 },
  { scene: 'iso_nested_scopes_2deep_gathers', scenario: 'idle', frame: 30 },
  { scene: 'iso_z_stacked_gathers', scenario: 'idle', frame: 30 },
  { scene: 'iso_sibling_gathers_disjoint', scenario: 'idle', frame: 30 },
  { scene: 'iso_sibling_gathers_overlapping', scenario: 'idle', frame: 30 },
] as const
