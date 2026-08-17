/**
 * Gather-backdrop capture for the `iso_glass_3frames_overlap` scene.
 *
 * Drives the scene through the same playwright + perf-page plumbing
 * the standard visual runner uses, but additionally installs
 * `globalThis.__gatherBackdropSink` BEFORE the renderer initializes
 * so every call to `build_gather_backdrop_scoped` on the Rust side
 * dumps its composed snapshot (Target ⊕ enclosing-scopes ⊕ scope_F
 * ⊕ Current) to disk as a PNG.
 *
 * Output layout:
 *
 *   screenshots/iso_glass_3frames_overlap__idle__f30.png
 *     ↑ the final canvas pixels (this spec also writes them; the
 *       standard runner.spec.ts produces the same file via cells.ts)
 *
 *   screenshots/iso_glass_3frames_overlap__idle__f30__backdrops/
 *     ├── 0001__shape-00000000_aaa3_…__scope-…__tile_0_0.png
 *     ├── 0002__shape-00000000_aaa3_…__scope-…__tile_1_0.png
 *     ├── …
 *     └── _events.json   (manifest: shape, scope, clipped rect, tile)
 *
 * Each PNG is one composed backdrop snapshot. Index prefix preserves
 * the emission order so flipping through the directory shows backdrop
 * evolution per tile / per cycle.
 */
import { test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { SCENES } from '../perf/scenes'
import type { ScenarioName, ScenarioRunResult } from '../perf/page/perf-types'

const OUT_DIR = process.env.VISUAL_OUT_DIR ?? 'screenshots'

interface GatherBackdropEvent {
  shape: string
  scope: string
  clipped: [number, number, number, number]
  tile: [number, number]
  open_scopes: number
  png_b64: string
}

const SCENE_NAME = 'iso_glass_3frames_overlap'
const SCENARIO: ScenarioName = 'idle'
const FRAMES = 30

function backdropsDir(): string {
  const base = path.join('test/visual', OUT_DIR)
  fs.mkdirSync(base, { recursive: true })
  return path.join(base, `${SCENE_NAME}__${SCENARIO}__f${FRAMES}__backdrops`)
}

test(`gather-backdrop-capture: ${SCENE_NAME} | ${SCENARIO} @ f${FRAMES}`, async ({ page }) => {
  const scene = SCENES.find((s) => s.name === SCENE_NAME)
  if (!scene) throw new Error(`unknown scene: ${SCENE_NAME}`)

  // Install the gather-backdrop sink BEFORE the renderer initializes.
  // Rust emits via `crate::run_script!(...)` whenever a glass shape
  // gets its backdrop composed; the function call is gated by a
  // `typeof globalThis.__gatherBackdropSink === 'function'` check, so
  // when no sink is present the cost is just one JS engine entry.
  await page.addInitScript(() => {
    const buf: GatherBackdropEvent[] = []
    ;(window as unknown as { __gatherBackdropBuf?: GatherBackdropEvent[] }).__gatherBackdropBuf = buf
    ;(window as unknown as {
      __gatherBackdropSink?: (e: GatherBackdropEvent) => void
    }).__gatherBackdropSink = (e) => {
      buf.push(e)
    }
  })

  await page.goto(`/perf?scene=${scene.id}`)
  await page.waitForFunction(
    () => Boolean((window as unknown as { perfApi?: { ready: boolean } }).perfApi?.ready),
    null,
    { timeout: 60_000 },
  )

  // Run the scenario for `FRAMES` rAF ticks so the renderer dispatches
  // the schedule at least once and any glass gathers fire.
  const runResult = await page.evaluate(
    async ([name, frames]: [ScenarioName, number]) => {
      const api = (window as unknown as {
        perfApi?: { runScenario(n: ScenarioName, f: number): Promise<ScenarioRunResult> }
      }).perfApi!
      const r = await api.runScenario(name, frames)
      await new Promise<void>((r2) => requestAnimationFrame(() => r2()))
      await new Promise<void>((r2) => requestAnimationFrame(() => r2()))
      return r
    },
    [SCENARIO, FRAMES] as const,
  )
  console.log(
    `[gather-backdrop-capture] snapshot.cache=${JSON.stringify(runResult.snapshot.cache)} ` +
    `wallMs=${runResult.wallMs.toFixed(1)} frames=${runResult.frames}`
  )

  // Final canvas snapshot — same convention/filename as runner.spec.ts
  // so the two paths produce the same artifact.
  const canvasDataUrl = await page.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement | null
    if (!c) throw new Error('no canvas in DOM')
    return c.toDataURL('image/png')
  })
  const canvasOutPath = path.join(
    'test/visual',
    OUT_DIR,
    `${SCENE_NAME}__${SCENARIO}__f${FRAMES}.png`,
  )
  fs.mkdirSync(path.dirname(canvasOutPath), { recursive: true })
  fs.writeFileSync(
    canvasOutPath,
    Buffer.from(canvasDataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'),
  )

  // Pull every backdrop event the page collected.
  const events = (await page.evaluate(
    () =>
      (window as unknown as { __gatherBackdropBuf?: GatherBackdropEvent[] })
        .__gatherBackdropBuf ?? [],
  )) as GatherBackdropEvent[]

  const dir = backdropsDir()
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })

  // Write a single JSON manifest (without the heavy base64 payloads).
  fs.writeFileSync(
    path.join(dir, '_events.json'),
    JSON.stringify(
      events.map((e) => ({
        shape: e.shape,
        scope: e.scope,
        clipped: e.clipped,
        tile: e.tile,
        open_scopes: e.open_scopes,
        png_bytes: Math.round((e.png_b64.length * 3) / 4),
      })),
      null,
      2,
    ),
  )

  // Write one PNG per event. Index prefix preserves emission order.
  let idx = 0
  for (const ev of events) {
    idx += 1
    const prefix = String(idx).padStart(4, '0')
    const shapeTag = `shape-${ev.shape.slice(0, 13)}`.replace(/[^A-Za-z0-9_-]/g, '_')
    const scopeTag = `scope-${ev.scope.slice(0, 13)}`.replace(/[^A-Za-z0-9_-]/g, '_')
    const tileTag = `tile_${ev.tile[0]}_${ev.tile[1]}`
    const base = `${prefix}__${shapeTag}__${scopeTag}__${tileTag}`
    fs.writeFileSync(
      path.join(dir, `${base}.png`),
      Buffer.from(ev.png_b64, 'base64'),
    )
  }

  console.log(
    `[gather-backdrop-capture] scene=${SCENE_NAME}  backdrops=${events.length}  outDir=${dir}`,
  )
})
