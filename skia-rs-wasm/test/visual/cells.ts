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
] as const
