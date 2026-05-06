import type { ScenarioName } from './page/perf-types'

/**
 * Scenarios driven by the in-page rAF loop. See
 * `test/perf/page/perf-page.tsx::runFrame` for the per-frame work
 * each one performs.
 */
export const SCENARIOS: readonly ScenarioName[] = ['idle', 'pan', 'zoom', 'drag', 'move'] as const
