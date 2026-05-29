/**
 * /perf route — wasm bench harness.
 *
 * Boots the wasm module against a hidden canvas, builds a parameterised
 * scene from a preset id, then exposes `window.perfApi` for a Playwright
 * runner to drive scenarios from outside. The page itself runs the
 * timing loop inside `requestAnimationFrame` so per-frame work isn't
 * coupled to IPC latency between browser and runner.
 *
 * Query params:
 *   ?scene=<id>           preset id (default 0)
 *   ?scenario=<name>      auto-run scenario after init (optional)
 *   ?frames=<n>           frame count for the auto-run (default 60)
 *   ?ready-check=1        skip wasm init, used by Playwright webServer
 *                         to confirm the dev server is up
 */
import { useEffect, useRef, useState } from 'react'
import type { WasmModule } from '@/lib/renderer/wasm-types'
import { ensureWasmModule } from '@/lib/renderer/wasm-module'
import {
  initCanvasContext,
  setCanvasBackground,
} from '@/lib/renderer/api/canvas'
import {
  buildPerfScene,
  clearSnapshot,
  dumpSnapshot,
  perfPresetCount,
  setShapeTranslation,
  FIRST_LEAF_UUID_QUARTET,
} from './perf-api'
import type {
  PerfApi,
  PerfSnapshot,
  ScenarioName,
  ScenarioRunResult,
} from './perf-types'

const VIEWPORT_W = 1920
const VIEWPORT_H = 1080
const WORLD_PAN_PX_PER_FRAME = 8
const ZOOM_START = 0.5
const ZOOM_END = 2.0

function readQuery(): { scene: number; scenario: ScenarioName | null; frames: number; readyCheck: boolean } {
  if (typeof window === 'undefined') {
    return { scene: 0, scenario: null, frames: 60, readyCheck: false }
  }
  const url = new URL(window.location.href)
  const scene = parseInt(url.searchParams.get('scene') ?? '0', 10)
  const sc = url.searchParams.get('scenario') as ScenarioName | null
  const frames = parseInt(url.searchParams.get('frames') ?? '60', 10)
  const readyCheck = url.searchParams.get('ready-check') === '1'
  return { scene: isFinite(scene) ? scene : 0, scenario: sc, frames: isFinite(frames) ? frames : 60, readyCheck }
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

async function runScenarioImpl(
  module: WasmModule,
  name: ScenarioName,
  frames: number,
  sceneId: number,
  sceneName: string,
): Promise<ScenarioRunResult> {
  clearSnapshot(module)

  // Prime the cache: render twice before timing begins so the tile
  // texture cache has its starting state. Without this, frame 0 of
  // every scenario looks artificially slow because ALL tiles miss.
  module._set_view(1.0, 0, 0)
  module._render_sync()
  await nextFrame()
  module._render_sync()
  await nextFrame()
  clearSnapshot(module)

  const tStart = performance.now()
  for (let i = 0; i < frames; i++) {
    runFrame(module, name, i, frames)
    // eslint-disable-next-line no-await-in-loop
    await nextFrame()
  }
  const wallMs = performance.now() - tStart
  // Drain any in-flight async render so its cost is captured before we
  // dump the snapshot. Without this, the last few continuation frames
  // can still be running when we read.
  module._render_sync()
  await nextFrame()
  const snapshot = dumpSnapshot(module)
  return { scenario: name, sceneId, sceneName, frames, wallMs, snapshot }
}

function runFrame(module: WasmModule, name: ScenarioName, i: number, frames: number): void {
  const t = performance.now()
  switch (name) {
    case 'pan': {
      const x = i * WORLD_PAN_PX_PER_FRAME
      module._set_view_start()
      module._set_view(1.0, -x, 0)
      module._set_view_end()
      module._render(t)
      break
    }
    case 'zoom': {
      const k = frames <= 1 ? 1 : i / (frames - 1)
      const zoom = ZOOM_START * Math.pow(ZOOM_END / ZOOM_START, k)
      module._set_view_start()
      module._set_view(zoom, 0, 0)
      module._set_view_end()
      module._render(t)
      break
    }
    case 'drag': {
      // Low-amplitude pan kept as a separate scenario so historical
      // baselines don't lose a name. For real shape-mutation cost,
      // see the `move` scenario.
      const x = i * 2
      module._set_view_start()
      module._set_view(1.0, -x, 0)
      module._set_view_end()
      module._render(t)
      break
    }
    case 'move': {
      // Translate the first leaf shape (UUID derived from the
      // test_fixtures generator) by an increasing offset every frame.
      // `_set_modifiers` rebuilds the touched-tile set for that shape
      // alone; `_render(t)` then walks the tile-scheduler with the
      // moved shape's old + new tiles invalidated. Catches per-shape
      // touched-tile + scatter-cache regressions, not viewport-wide
      // ones.
      const dx = i * 4
      const dy = (i % 4) * 2
      setShapeTranslation(module, FIRST_LEAF_UUID_QUARTET, dx, dy)
      module._render(t)
      break
    }
    case 'idle':
    default: {
      module._render(t)
      break
    }
  }
}

export default function PerfPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [status, setStatus] = useState<string>('booting…')
  const [lastResult, setLastResult] = useState<ScenarioRunResult | null>(null)

  const { scene: sceneId, scenario, frames, readyCheck } = readQuery()

  useEffect(() => {
    if (readyCheck) {
      setStatus('ready (no wasm init for ready-check probe)')
      // Still expose the api so probes can detect the page mounted.
      window.perfApi = {
        ready: true,
        presetCount: 0,
        async buildScene() {
          /* no-op */
        },
        async runScenario(): Promise<ScenarioRunResult> {
          throw new Error('runScenario unavailable on ready-check probe')
        },
        snapshot(): PerfSnapshot {
          return { frames: 0, wall_ms: 0, cache: { tile_hits: 0, tile_misses: 0, tile_writes: 0 }, stats: [] }
        },
        clear() {
          /* no-op */
        },
      }
      return
    }

    let cancelled = false
    let module: WasmModule | null = null

    void (async () => {
      try {
        const canvas = canvasRef.current
        if (!canvas) {
          setStatus('error: canvas not mounted')
          return
        }
        canvas.width = VIEWPORT_W
        canvas.height = VIEWPORT_H

        setStatus('loading wasm…')
        module = await ensureWasmModule()
        if (cancelled) return

        setStatus('initializing context…')
        const ok = initCanvasContext(module, canvas, 1, false)
        if (!ok) {
          setStatus('error: WebGL2 unavailable')
          return
        }

        setCanvasBackground(module, '#ffffff')
        module._set_view(1.0, 0, 0)

        const presetCount = perfPresetCount(module)
        if (presetCount === 0) {
          setStatus(
            'error: wasm built without `perf-trace`. Rebuild with `pnpm build:wasm:perf`.',
          )
          return
        }

        setStatus(`building scene #${sceneId}…`)
        buildPerfScene(module, sceneId)

        const sceneName = `scene_${sceneId}`

        const api: PerfApi = {
          ready: true,
          presetCount,
          async buildScene(id: number) {
            buildPerfScene(module!, id)
          },
          async runScenario(name: ScenarioName, n: number) {
            const result = await runScenarioImpl(module!, name, n, sceneId, sceneName)
            setLastResult(result)
            return result
          },
          snapshot() {
            return dumpSnapshot(module!)
          },
          clear() {
            clearSnapshot(module!)
          },
        }
        window.perfApi = api
        setStatus(`ready (scene ${sceneId}, ${presetCount} presets registered)`)

        if (scenario) {
          const result = await runScenarioImpl(module, scenario, frames, sceneId, sceneName)
          if (!cancelled) {
            setLastResult(result)
            setStatus(`done: ${scenario} × ${frames} frames in ${result.wallMs.toFixed(1)}ms`)
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setStatus(`error: ${msg}`)
        console.error('perf-page boot error', e)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [readyCheck, sceneId, scenario, frames])

  return (
    <div style={{ font: '14px monospace', background: '#0a0a0a', color: '#eaeaea', minHeight: '100vh' }}>
      <div style={{ padding: 12, borderBottom: '1px solid #222' }}>
        <strong>perf harness</strong> — scene={sceneId} scenario={scenario ?? '—'} frames={frames}
        <div style={{ marginTop: 4, color: '#aaa' }}>{status}</div>
      </div>
      {/*
        The canvas backing buffer is 1920×1080 (set by `canvas.width`).
        `initCanvasContext` calls `setCanvasSize(module, canvas, dpr)`,
        which reads `clientWidth/clientHeight` (CSS layout size) and
        OVERWRITES `canvas.width`/`canvas.height` to match. If the CSS
        layout size differs from the backing-buffer attribute, half the
        framebuffer ends up clipped while Skia keeps drawing to the
        full 1920×1080 surface — leaving every world coord that maps
        outside the (smaller) framebuffer invisible.

        Fix: pin the CSS layout dims to the backing-buffer dims and use
        `transform: scale(...)` purely for visual scaling on the page.
        `transform` doesn't affect `clientWidth/clientHeight`, so
        `setCanvasSize` reads 1920×1080 and the backing buffer stays
        consistent with Skia's surface.
      */}
      <div
        style={{
          width: VIEWPORT_W * 0.5,
          height: VIEWPORT_H * 0.5,
          margin: '12px auto',
        }}
      >
        <canvas
          ref={canvasRef}
          width={VIEWPORT_W}
          height={VIEWPORT_H}
          style={{
            display: 'block',
            background: '#fff',
            width: VIEWPORT_W,
            height: VIEWPORT_H,
            transform: 'scale(0.5)',
            transformOrigin: 'top left',
            border: '1px solid #222',
          }}
        />
      </div>
      {lastResult && (
        <pre
          style={{
            background: '#111',
            color: '#cfe',
            padding: 12,
            margin: '12px auto',
            maxWidth: 960,
            maxHeight: 360,
            overflow: 'auto',
          }}
        >
          {JSON.stringify(lastResult.snapshot, null, 2)}
        </pre>
      )}
    </div>
  )
}
