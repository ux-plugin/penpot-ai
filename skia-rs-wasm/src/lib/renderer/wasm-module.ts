/**
 * Internal WASM module singleton
 * Manages the lifecycle of the WASM module instance
 */

import type { WasmModule } from './wasm-types'
import initWasmModuleFactory from '../../../public/wasm/render-wasm.js'
import { loadVelloModule } from './vello-module'

/**
 * Which rendering backend to load. Exactly one wasm artifact is downloaded (D2), so this has to
 * be decided before anything is fetched.
 *
 * Opt in with `?renderer=vello`. Skia stays the default while the Vello backend is missing
 * text, effects and images — it is a Phase-2 preview, not an alternative anyone should land on
 * by accident.
 */
function velloRequested(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('renderer') === 'vello'
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
      if (velloRequested()) {
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

