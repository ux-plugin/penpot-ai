/**
 * Snapshot schema mirrored on the Rust side. See
 * `render-wasm/src/perf_trace.rs::snapshot_json`.
 *
 * Counts are deterministic across runs of the same scene + scenario;
 * timings are not. Diff thresholds in `test/perf/thresholds.ts`
 * exploit that — counts strict, timings ratio.
 */
export interface PerfStat {
  tag: string
  count: number
  total_ms: number
  max_ms: number
}

export interface PerfCacheCounters {
  tile_hits: number
  tile_misses: number
  tile_writes: number
}

export interface PerfSnapshot {
  frames: number
  wall_ms: number
  cache: PerfCacheCounters
  stats: PerfStat[]
}

/**
 * Scenarios mirror the in-page rAF loop branches in `perf-page.tsx`.
 *
 *   idle  — `_render(t)` only, no input. Tile cache should hit
 *           steadily (baseline for "nothing changed" frames).
 *   pan   — viewbox shifts 8px/frame. Exercises tile cache
 *           invalidation + uncached Enter renders.
 *   zoom  — geometric 0.5×→2× over the run. Forces full retile +
 *           rescaled effect filters every frame.
 *   drag  — pan with a smaller delta (placeholder for when "move"
 *           wasn't yet wired). Kept around so a single scenario
 *           name doesn't drop out of historical baselines.
 *   move  — mutates the first leaf shape's translation each frame
 *           via `_set_modifiers` + `_render(t)`. Exercises the
 *           per-shape touched-tile rebuild + scatter cache miss
 *           on the moved shape.
 */
export type ScenarioName = 'pan' | 'zoom' | 'drag' | 'idle' | 'move'

export interface ScenarioRunResult {
  scenario: ScenarioName
  sceneId: number
  sceneName: string
  frames: number
  wallMs: number
  snapshot: PerfSnapshot
}

export interface PerfApi {
  ready: boolean
  presetCount: number
  buildScene(sceneId: number): Promise<void>
  runScenario(name: ScenarioName, frames: number): Promise<ScenarioRunResult>
  snapshot(): PerfSnapshot
  clear(): void
}

declare global {
  interface Window {
    perfApi?: PerfApi
  }
}
