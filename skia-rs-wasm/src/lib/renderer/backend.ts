/**
 * The one seam both rendering backends go through.
 *
 * The `api/*.ts` layer is already backend-neutral — `vello-module-facade.ts` reshapes the
 * wasm-bindgen exports into the Emscripten `Module` shape, so the ~150 setter/render calls run
 * against either backend unchanged. Only three operations genuinely diverge, and this interface
 * owns exactly those:
 *
 *   1. bringing up the drawing surface (Emscripten binds a GL context synchronously; wgpu
 *      acquires an adapter/device asynchronously from the canvas),
 *   2. tearing it down (a GL context to unregister vs a wgpu frame loop to stop),
 *   3. handing over decoded image pixels (a WebGL texture id vs raw RGBA for the wgpu atlas).
 *
 * Everything else is the shared `module`. `backendOf(module)` dispatches these three
 * polymorphically, replacing the `isVelloModule(...)` branches that used to sit at each site.
 *
 * This is deliberately *not* a port of `imaging`'s `PaintSink` (D13): that is a Rust trait that
 * cannot span two separately-compiled wasm targets (D2), and the streaming setter surface it
 * describes already exists here as `api/*.ts`. The retained/caching half is Phase 6.
 */

import type { WasmModule } from './wasm-types'
import type { EmscriptenLikeModule } from './vello-module-facade'

/** Passed to [`RenderBackend.attachSurface`]; Vello uses only `dpr`, Skia uses all three. */
export interface SurfaceOptions {
  dpr: number
  debug: boolean
  debugPip: boolean
}

export interface RenderBackend {
  readonly kind: 'skia' | 'vello'
  /**
   * Bring up the drawing surface for `canvas`. Async because wgpu's adapter/device acquisition
   * is; the Skia path is synchronous under the hood and simply resolves. Sets the shared
   * context-initialized flag on success, matching what `initCanvasContext` does internally.
   */
  attachSurface(module: WasmModule, canvas: HTMLCanvasElement, opts: SurfaceOptions): Promise<void>
  /** Tear the surface down. `releaseContext`/`canvas` matter only to the Skia (GL) path. */
  detachSurface(module: WasmModule, canvas: HTMLCanvasElement, releaseContext: boolean): void
  /** Hand a decoded image to the backend's own store. Returns false if it could not be stored. */
  storeImage(
    module: WasmModule,
    shapeId: string,
    imageId: string,
    thumbnail: boolean,
    img: ImageBitmap
  ): boolean
}

/**
 * The backend is carried on the module as an own property, alongside the exports the facade
 * proxies. The name has no leading underscore on purpose: the Vello facade turns any unknown
 * `_name` lookup into a no-op stub, so an underscored key would come back as a stub function
 * rather than the backend (the same trap `velloBackend` avoids).
 */
const RENDER_BACKEND_KEY = 'renderBackend'

type BackendCarrier = { [RENDER_BACKEND_KEY]?: RenderBackend }

/** Attach `backend` to `module` so `backendOf` can find it later. Returns `module` for chaining. */
export function attachBackend<M extends object>(module: M, backend: RenderBackend): M {
  ;(module as unknown as BackendCarrier)[RENDER_BACKEND_KEY] = backend
  return module
}

/** The backend attached at load time. Throws if the module was built without one. */
export function backendOf(module: WasmModule | EmscriptenLikeModule): RenderBackend {
  const backend = (module as unknown as BackendCarrier)[RENDER_BACKEND_KEY]
  if (!backend) {
    throw new Error('No RenderBackend attached to this module — it was not built through the loader.')
  }
  return backend
}

/**
 * The load-time backend choice. `vello-gpu` is the classic (WebGPU-compute) vello artifact; it shares
 * the whole `RenderBackend` seam with `vello` (same `create_focus_renderer` handoff), differing only
 * in which wasm is fetched — so the backend *object* still reports kind `'vello'`, and this wider type
 * exists purely to route the URL.
 */
export type BackendKind = RenderBackend['kind'] | 'vello-gpu'

/**
 * The one-line flip. While it is `false`, WebGPU-capable users still land on Skia by default;
 * setting it `true` auto-selects Vello wherever WebGPU is present. It stays off until Vello
 * reaches text and effects parity (Phases 4–5) — auto-selecting an incomplete backend would
 * render real documents with text and effects missing.
 */
const AUTO_SELECT_VELLO = false

/** `?renderer=vello` / `?renderer=vello-gpu` / `?renderer=skia`, or null for neither (and under SSR). */
function rendererOverride(): BackendKind | null {
  if (typeof window === 'undefined') return null
  const value = new URLSearchParams(window.location.search).get('renderer')
  return value === 'vello' || value === 'skia' || value === 'vello-gpu' ? value : null
}

/**
 * Whether this browser can give us a WebGPU adapter. Cheap, and only ever called when the answer
 * can change the decision (an explicit `?renderer=vello`, or the auto flag), so the default Skia
 * path pays nothing.
 */
export async function probeWebGPU(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) return false
  try {
    return (await gpu.requestAdapter()) != null
  } catch {
    return false
  }
}

/**
 * Which backend to load. Exactly one wasm artifact is downloaded (D2), so this is decided before
 * anything is fetched. An explicit `?renderer=vello` on a browser without WebGPU falls back to
 * Skia with a warning rather than failing deep inside wgpu bring-up.
 */
export async function chooseBackendKind(): Promise<BackendKind> {
  const override = rendererOverride()
  if (override === 'skia') return 'skia'
  if (override === 'vello') {
    if (await probeWebGPU()) return 'vello'
    console.warn('[renderer] ?renderer=vello requested but WebGPU is unavailable; using Skia.')
    return 'skia'
  }
  // Classic vello is WebGPU-only (compute rasterization) — there is no WebGL fallback, so an absent
  // adapter drops to Skia rather than failing inside wgpu bring-up.
  if (override === 'vello-gpu') {
    if (await probeWebGPU()) return 'vello-gpu'
    console.warn('[renderer] ?renderer=vello-gpu requested but WebGPU is unavailable; using Skia.')
    return 'skia'
  }
  if (AUTO_SELECT_VELLO && (await probeWebGPU())) return 'vello'
  return 'skia'
}
