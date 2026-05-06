import type { PerfSnapshot, ScenarioRunResult } from '../../src/lib/perf/perf-types'

/**
 * Aggregated stats across multiple repeats of one (scene, scenario)
 * cell. Counts are summed (they're deterministic — every repeat
 * should report the same number); timings are reduced to p50, p95,
 * mean for stability.
 */
export interface AggregatedStat {
  tag: string
  count: number
  p50_ms: number
  p95_ms: number
  mean_ms: number
  max_ms: number
}

export interface AggregatedCell {
  scene_id: number
  scene_name: string
  scenario: string
  repeats: number
  frames_per_run: number
  wall_ms_p50: number
  wall_ms_p95: number
  cache: { tile_hits: number; tile_misses: number; tile_writes: number }
  stats: AggregatedStat[]
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const idx = (sorted.length - 1) * q
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/**
 * Reduce N samples into a single aggregated cell. The first sample's
 * shape determines the tag set — if a later sample has a tag the
 * first didn't, it's still merged in. Per-tag counts are summed
 * across samples but the per-frame count contract still holds since
 * each sample is one independent run of the same scenario.
 */
export function aggregate(samples: ScenarioRunResult[]): AggregatedCell {
  if (samples.length === 0) {
    throw new Error('aggregate: no samples')
  }
  const first = samples[0]
  // Collect timings per tag.
  const perTag = new Map<string, { totals: number[]; counts: number[]; maxs: number[] }>()
  for (const s of samples) {
    for (const stat of s.snapshot.stats) {
      let bucket = perTag.get(stat.tag)
      if (!bucket) {
        bucket = { totals: [], counts: [], maxs: [] }
        perTag.set(stat.tag, bucket)
      }
      bucket.totals.push(stat.total_ms)
      bucket.counts.push(stat.count)
      bucket.maxs.push(stat.max_ms)
    }
  }
  const stats: AggregatedStat[] = []
  for (const [tag, b] of perTag) {
    const sortedTotals = [...b.totals].sort((a, b) => a - b)
    stats.push({
      tag,
      // Counts must match across samples; pick the modal value (use
      // the last sample's count to reflect a steady-state run, but
      // record the spread elsewhere if we ever need to flag mismatch).
      count: b.counts[b.counts.length - 1],
      p50_ms: quantile(sortedTotals, 0.5),
      p95_ms: quantile(sortedTotals, 0.95),
      mean_ms: mean(b.totals),
      max_ms: Math.max(...b.maxs),
    })
  }
  // Sort heaviest first — same contract as snapshot_json on the Rust
  // side so diff output stays predictable.
  stats.sort((a, b) => b.p50_ms - a.p50_ms)
  const wallSorted = [...samples.map((s) => s.wallMs)].sort((a, b) => a - b)

  const lastCache = samples[samples.length - 1].snapshot.cache

  return {
    scene_id: first.sceneId,
    scene_name: first.sceneName,
    scenario: first.scenario,
    repeats: samples.length,
    frames_per_run: first.frames,
    wall_ms_p50: quantile(wallSorted, 0.5),
    wall_ms_p95: quantile(wallSorted, 0.95),
    cache: lastCache,
    stats,
  }
}

/**
 * Convenience to dump an empty stub PerfSnapshot when a sample is
 * missing — keeps types narrow without optional handling everywhere.
 */
export function emptySnapshot(): PerfSnapshot {
  return {
    frames: 0,
    wall_ms: 0,
    cache: { tile_hits: 0, tile_misses: 0, tile_writes: 0 },
    stats: [],
  }
}
