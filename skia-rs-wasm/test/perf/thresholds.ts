/**
 * Diff thresholds for perf regression detection.
 *
 * Counts are deterministic across runs of the same scene + scenario
 * (same instrumentation, same scheduler decisions). Any drift in a
 * count is a real change in the algorithm — flag immediately.
 *
 * Timings are noisy. Hardware, GPU/SwiftShader variance, OS
 * scheduling jitter — we can only compare ratios against a baseline
 * captured on the same machine. Tags below the noise floor (sub-ms
 * total per run) are ignored to avoid false positives on rounding.
 *
 * Tile cache hit ratio drop is its own bucket: a regression there
 * directly maps to "the cache stopped working" which is the failure
 * mode this whole bench was built to catch.
 */

export const TIMING_NOISE_FLOOR_MS = 1.0
export const TIMING_RATIO_FAIL = 1.10 // > 10% slower fails
export const TIMING_RATIO_WARN = 1.05 // 5–10% warns
export const CACHE_HIT_RATIO_DROP_FAIL_PP = 5 // percentage points
export const CACHE_HIT_RATIO_DROP_WARN_PP = 2

export type Severity = 'fail' | 'warn' | 'ok'
