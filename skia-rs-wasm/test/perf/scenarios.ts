import type { ScenarioName } from '../../src/lib/perf/perf-types'

/**
 * Scenarios driven by the in-page rAF loop. See
 * `src/lib/perf/perf-page.tsx::runFrame` for the per-frame work each
 * one performs.
 */
export const SCENARIOS: readonly ScenarioName[] = ['idle', 'pan', 'zoom', 'drag'] as const
