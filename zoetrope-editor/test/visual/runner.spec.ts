import { test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { SCENES } from '../perf/scenes'
import { VISUAL_CELLS } from './cells'
import type { ScenarioName, ScenarioRunResult } from '../perf/page/perf-types'

/**
 * Capture-only runner. Each cell renders a scene + scenario for
 * `frame` rAF ticks, then writes a PNG of the canvas to
 * `screenshots/<scene>__<scenario>__f<frame>.png`. Override the
 * destination via `VISUAL_OUT_DIR=baselines` for the bless workflow.
 *
 * Diff is performed manually by reading the PNGs side-by-side. No
 * pixel-level assertion in this spec.
 */
const OUT_DIR = process.env.VISUAL_OUT_DIR ?? 'screenshots'

function outPath(cell: { scene: string; scenario: string; frame: number }): string {
  const dir = path.join('test/visual', OUT_DIR)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${cell.scene}__${cell.scenario}__f${cell.frame}.png`)
}

for (const cell of VISUAL_CELLS) {
  test(`visual: ${cell.scene} | ${cell.scenario} @ f${cell.frame}`, async ({ page }) => {
    const scene = SCENES.find((s) => s.name === cell.scene)
    if (!scene) throw new Error(`unknown scene: ${cell.scene}`)

    await page.goto(`/perf?scene=${scene.id}`)
    await page.waitForFunction(
      () => Boolean((window as unknown as { perfApi?: { ready: boolean } }).perfApi?.ready),
      null,
      { timeout: 60_000 },
    )

    // Run the scenario to drive the rAF loop forward `frame` ticks.
    // Result is discarded — visual capture only cares about the
    // final canvas pixels. Two extra rAF ticks settle any deferred
    // tile-cache promotion before readback.
    await page.evaluate(
      async ([name, frames]: [ScenarioName, number]) => {
        const api = (window as unknown as {
          perfApi?: { runScenario(n: ScenarioName, f: number): Promise<ScenarioRunResult> }
        }).perfApi!
        await api.runScenario(name, frames)
        await new Promise<void>((r) => requestAnimationFrame(() => r()))
        await new Promise<void>((r) => requestAnimationFrame(() => r()))
      },
      [cell.scenario as ScenarioName, cell.frame] as const,
    )

    // The perf page initializes WebGL2 with `preserveDrawingBuffer: true`,
    // so the canvas's backing store retains the last drawn frame. Read
    // it directly via `canvas.toDataURL` (avoids both the element-level
    // screenshot blank-canvas footgun and compositor timing races on
    // page.screenshot).
    const dataUrl = await page.evaluate(() => {
      const c = document.querySelector('canvas') as HTMLCanvasElement | null
      if (!c) throw new Error('no canvas in DOM')
      return c.toDataURL('image/png')
    })
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
    fs.writeFileSync(outPath(cell), Buffer.from(base64, 'base64'))
  })
}
