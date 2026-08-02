/**
 * Internal WASM module singleton
 * Manages the lifecycle of the WASM module instance
 */

import type { WasmModule } from './wasm-types'
import initWasmModuleFactory from '../../../public/wasm/render-wasm.js'
import { loadVelloModule } from './vello-module'
import { attachBackend, chooseBackendKind, type RenderBackend } from './backend'
import { initCanvasContext, clearCanvas } from './api/canvas'
import { storeImageViaTexture } from './api/fills'

/**
 * The Skia backend seam (see `backend.ts`). Its three operations are the existing Emscripten-GL
 * paths — a synchronous GL context, its teardown, and a WebGL-texture image upload — each of
 * which already sets/clears the shared context flag internally.
 */
function createSkiaBackend(): RenderBackend {
  return {
    kind: 'skia',
    async attachSurface(module, canvas, { dpr, debug, debugPip }): Promise<void> {
      const ok = initCanvasContext(module, canvas, dpr, debug, debugPip)
      if (!ok) throw new Error('Failed to initialize WebGL context')
    },
    detachSurface(module, canvas, releaseContext): void {
      clearCanvas(module, canvas, releaseContext)
    },
    storeImage(module, shapeId, imageId, thumbnail, img): boolean {
      return storeImageViaTexture(module, shapeId, imageId, thumbnail, img)
    },
  }
}

let wasmModuleInstance: WasmModule | null = null
let wasmModulePromise: Promise<WasmModule> | null = null
let wasmModuleError: Error | null = null
let wasmPath: string | null = null

/**
 * Internal function to ensure WASM module is loaded
 * Returns cached instance if already loaded, or existing promise if loading
 */
export async function ensureWasmModule(wasmPathParam?: string): Promise<WasmModule> {
  // If already loaded, return immediately
  if (wasmModuleInstance) {
    return wasmModuleInstance
  }

  // If there's an error, throw it
  if (wasmModuleError) {
    throw wasmModuleError
  }

  // If already loading, return the existing promise
  if (wasmModulePromise) {
    return wasmModulePromise
  }

  // Set the path (use provided or default)
  const path = wasmPathParam || '/wasm/render-wasm.js'
  
  // If path was already set and differs, throw error
  if (wasmPath !== null && wasmPath !== path) {
    throw new Error(`WASM module already initialized with path: ${wasmPath}. Cannot change path.`)
  }
  
  wasmPath = path

  // Start loading
  wasmModulePromise = (async () => {
    try {
      // Exactly one wasm artifact is downloaded (D2); the seam decides which before anything is
      // fetched. Default is Skia — the Vello backend is opt-in until it reaches text/effects
      // parity (see `AUTO_SELECT_VELLO` in `backend.ts`).
      if ((await chooseBackendKind()) === 'vello') {
        const vello = (await loadVelloModule()) as unknown as WasmModule
        wasmModuleInstance = vello
        wasmModuleError = null
        return vello
      }

      const module = await initWasmModuleFactory({
        locateFile: (filePath: string) => {
          // Check if path includes .wasm (handles query strings like ?version=develop)
          if (filePath.includes('.wasm')) {
            // Return the directory path + the wasm filename
            const dir = path.substring(0, path.lastIndexOf('/'))
            return `${dir}/${filePath}`
          }
          return filePath
        }
      })

      attachBackend(module, createSkiaBackend())
      wasmModuleInstance = module
      wasmModuleError = null
      return module
    } catch (error) {
      wasmModuleError = error instanceof Error ? error : new Error(String(error))
      wasmModulePromise = null
      throw wasmModuleError
    }
  })()

  return wasmModulePromise
}

/**
 * Get the WASM module synchronously
 * Returns null if not loaded yet
 */
export function getWasmModule(): WasmModule | null {
  return wasmModuleInstance
}

/**
 * Check if WASM module is loaded
 */
export function isWasmModuleLoaded(): boolean {
  return wasmModuleInstance !== null
}

/**
 * Reset the WASM module (for testing/hot reload)
 * WARNING: This will break any existing Renderer instances
 */
export function resetWasmModuleInternal(): void {
  wasmModuleInstance = null
  wasmModulePromise = null
  wasmModuleError = null
  wasmPath = null
}

