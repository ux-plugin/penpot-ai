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

export type ScenarioName = 'pan' | 'zoom' | 'drag' | 'idle'

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
