import { test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { SCENES } from './scenes'
import { SCENARIOS } from './scenarios'
import { aggregate, type AggregatedCell } from './aggregate'
import type { ScenarioRunResult, ScenarioName } from '../../src/lib/perf/perf-types'

/**
 * Drives the perf harness over the (scene × scenario) matrix.
 *
 * Each cell:
 *   1. Navigate to /perf?scene=<id> (no `scenario=` so the page
 *      builds the scene + primes caches but does not auto-run).
 *   2. Wait for window.perfApi.ready.
 *   3. Run the scenario REPEATS times to smooth out timing noise.
 *   4. Aggregate the samples into a single cell.
 *
 * Output goes to `PERF_OUT` (default `test/perf/.results/perf.json`).
 * The diff CLI consumes that file.
 *
 * Tunables exposed via env so a quick smoke run is:
 *   PERF_FRAMES=20 PERF_REPEATS=2 pnpm perf
 */
const FRAMES = parseInt(process.env.PERF_FRAMES ?? '60', 10)
const REPEATS = parseInt(process.env.PERF_REPEATS ?? '3', 10)
const OUT_PATH = process.env.PERF_OUT ?? 'test/perf/.results/perf.json'

interface PerfFile {
  generated_at: string
  frames_per_run: number
  repeats: number
  cells: AggregatedCell[]
}

/**
 * Persist after every test instead of buffering in memory + writing
 * once in afterAll. Playwright restarts the worker after timeouts,
 * which dropped the in-memory `collected` array on a previous run.
 * Read-modify-write the same JSON file so a worker restart picks up
 * earlier results from disk.
 */
function persistCell(cell: AggregatedCell): void {
  const dir = path.dirname(OUT_PATH)
  fs.mkdirSync(dir, { recursive: true })
  let existing: PerfFile = {
    generated_at: new Date().toISOString(),
    frames_per_run: FRAMES,
    repeats: REPEATS,
    cells: [],
  }
  try {
    const raw = fs.readFileSync(OUT_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as PerfFile
    if (parsed.frames_per_run === FRAMES && parsed.repeats === REPEATS) {
      existing = parsed
    }
  } catch {
    /* fresh run */
  }
  // Replace any prior entry for the same (scene_id, scenario) — useful
  // when re-running after a fix. Append otherwise.
  const idx = existing.cells.findIndex(
    (c) => c.scene_id === cell.scene_id && c.scenario === cell.scenario,
  )
  if (idx >= 0) {
    existing.cells[idx] = cell
  } else {
    existing.cells.push(cell)
  }
  existing.generated_at = new Date().toISOString()
  fs.writeFileSync(OUT_PATH, JSON.stringify(existing, null, 2))
}

for (const scene of SCENES) {
  for (const scenario of SCENARIOS) {
    test(`${scene.name} | ${scenario}`, async ({ page }) => {
      // Pipe browser console to test output for in-flight diagnosis.
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          // eslint-disable-next-line no-console
          console.log(`[browser] ${msg.text()}`)
        }
      })

      await page.goto(`/perf?scene=${scene.id}`)
      await page.waitForFunction(
        () => Boolean((window as unknown as { perfApi?: { ready: boolean } }).perfApi?.ready),
        null,
        { timeout: 60_000 },
      )

      const samples: ScenarioRunResult[] = []
      for (let i = 0; i < REPEATS; i++) {
        const result = await page.evaluate(
          async ([name, frames]: [ScenarioName, number]) => {
            const api = (window as unknown as { perfApi?: { runScenario(n: ScenarioName, f: number): Promise<ScenarioRunResult> } }).perfApi!
            return api.runScenario(name, frames)
          },
          [scenario as ScenarioName, FRAMES] as const,
        )
        samples.push(result as ScenarioRunResult)
      }
      persistCell(aggregate(samples))
    })
  }
}
