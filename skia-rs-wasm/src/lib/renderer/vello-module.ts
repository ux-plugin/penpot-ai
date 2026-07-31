/**
 * Loads the Vello backend and brings up its drawing surface.
 *
 * D2: the two backends are separate wasm artifacts for different targets — render-wasm is
 * `wasm32-unknown-emscripten` against prebuilt Skia, render-vello is `wasm32-unknown-unknown`
 * with wasm-bindgen, because wgpu's browser backend needs the latter. Exactly one is downloaded
 * at runtime.
 *
 * Everything downstream of bring-up is identical: the facade reshapes the raw exports into the
 * `Module` object `api/*.ts` already drives, so no part of the shape-sync layer knows which
 * backend it is talking to.
 *
 * **Bring-up is the one genuine difference.** Emscripten binds a GL context to a canvas in its
 * JS glue, so render-wasm's `_init(width, height)` is synchronous and canvas-free. Acquiring a
 * wgpu adapter and device is asynchronous and needs the canvas element itself, so it happens
 * here through a wasm-bindgen call rather than through the C ABI. Phase 3 absorbs this into a
 * `Renderer` interface both backends implement.
 */

import { createModuleFacade, type EmscriptenLikeModule, type RawWasmExports } from './vello-module-facade'
import type { WasmModule } from './wasm-types'

/** Default location of the wasm-bindgen bundle, copied here by `scripts/build-vello.sh`. */
const VELLO_GLUE_PATH = '/wasm-vello/render-vello.js'

/** The wasm-bindgen surface we reach past the C ABI, for the parts a C ABI cannot express. */
interface VelloBindgenExports extends RawWasmExports {
  create_focus_renderer(canvas: HTMLCanvasElement): Promise<VelloFocusRenderer>
  frame_requested(): boolean
}

interface VelloFocusRenderer {
  render(): void
  resize(width: number, height: number): void
  status(): string | undefined
}

/** A module built by [`loadVelloModule`]; the extra members are how `Renderer` brings it up. */
export interface VelloModule extends EmscriptenLikeModule {
  readonly velloBackend: {
    attachCanvas(canvas: HTMLCanvasElement): Promise<void>
    detach(): void
    /** Entry points the host has called that this backend does not implement yet. */
    missingExports(): string[]
    /** Frames actually drawn — distinguishes "never asked" from "asked and failed". */
    frameCount(): number
    hasRenderer(): boolean
  }
}

export function isVelloModule(module: WasmModule | EmscriptenLikeModule): module is VelloModule {
  return typeof (module as VelloModule).velloBackend === 'object'
}

/**
 * Fetch, instantiate and wrap the Vello wasm.
 *
 * The specifier is built at runtime rather than written as a literal. wasm-bindgen's glue is a
 * build artifact served from `public/`, and Vite refuses to import those from source — it
 * copies `public/` verbatim without running its transforms, so a static specifier fails at
 * resolve time even with `@vite-ignore`. An absolute URL computed here is opaque to the
 * analyser and reaches the browser's own dynamic import, which is what we want: the glue then
 * resolves `render-vello_bg.wasm` against its own `import.meta.url` and fetches it from the
 * same directory.
 */
export async function loadVelloModule(gluePath: string = VELLO_GLUE_PATH): Promise<VelloModule> {
  const url = new URL(gluePath, window.location.origin).href
  const glue = (await import(/* @vite-ignore */ url)) as {
    default: () => Promise<VelloBindgenExports>
  }
  const exports = await glue.default()

  const missing: string[] = []
  const base = createModuleFacade(exports, {
    stubMissingExports: true,
    onMissing: (name) => {
      missing.push(name)
      if (import.meta.env.DEV) {
        console.debug(`[vello] entry point not implemented, stubbed: ${name}`)
      }
    },
  })

  let renderer: VelloFocusRenderer | null = null
  let frameHandle: number | null = null
  let frames = 0

  const loop = (): void => {
    frameHandle = requestAnimationFrame(loop)
    if (!renderer) return
    // The C-ABI `render()` records a request rather than drawing — render-wasm's does too, and
    // Phase 0 deliberately left the frame loop with the host (D3). Drawing only when something
    // asked keeps an idle document off the GPU.
    if (exports.frame_requested()) {
      renderer.render()
      frames += 1
    }
  }

  const vello: VelloModule['velloBackend'] = {
    async attachCanvas(canvas: HTMLCanvasElement): Promise<void> {
      if (renderer) return
      renderer = await exports.create_focus_renderer(canvas)
      if (frameHandle === null) {
        frameHandle = requestAnimationFrame(loop)
      }
    },
    detach(): void {
      if (frameHandle !== null) {
        cancelAnimationFrame(frameHandle)
        frameHandle = null
      }
      renderer = null
    },
    missingExports: () => [...missing],
    frameCount: () => frames,
    hasRenderer: () => renderer !== null,
  }

  // The facade is a Proxy whose `get` trap answers for every string key, so a member attached
  // to it directly would be routed at the wasm exports and lost. An object *prototyped* on the
  // facade keeps `velloBackend` as an own property — found before the trap — while every
  // `_`-prefixed lookup still falls through to it.
  //
  // The name deliberately has no leading underscore. `stubMissingExports` turns any unknown
  // `_name` into a no-op function, so an underscored marker would come back as a stub and
  // `isVelloModule` would quietly answer false.
  const module = Object.assign(Object.create(base) as EmscriptenLikeModule, {
    velloBackend: vello,
  }) as VelloModule

  if (import.meta.env.DEV) {
    // The backend is a preview behind `?renderer=vello`; a handle makes it inspectable from the
    // console without digging it out of the store.
    ;(window as unknown as { velloModule?: VelloModule }).velloModule = module
  }

  return module
}
