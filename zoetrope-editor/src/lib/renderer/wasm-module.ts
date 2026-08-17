/**
 * Internal WASM module singleton
 * Manages the lifecycle of the WASM module instance
 */

import type { WasmModule } from './wasm-types'
import { loadVelloModule, VELLO_GPU_GLUE_PATH } from './vello-module'
import { chooseBackendKind } from './backend'

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

  // `wasmPathParam` is retained for API compatibility (the Figma plugin still passes one) but no
  // longer selects an artifact: Skia is detached, so both remaining backends are vello, loaded by
  // `loadVelloModule` from its own fixed glue paths. We still record it so a conflicting later call
  // is rejected the same way it always was.
  const path = wasmPathParam ?? '(default)'
  if (wasmPath !== null && wasmPath !== path) {
    throw new Error(`WASM module already initialized with path: ${wasmPath}. Cannot change path.`)
  }
  wasmPath = path

  // Start loading
  wasmModulePromise = (async () => {
    try {
      // Exactly one wasm artifact is downloaded (D2); the seam decides which before anything is
      // fetched. Both remaining backends are vello and go through the same loader/facade —
      // `vello-gpu` (classic, WebGPU-compute) only points it at a different glue artifact than the
      // hybrid (WebGL2) build. Classic is the default (see `chooseBackendKind` in `backend.ts`).
      const kind = await chooseBackendKind()
      const gluePath = kind === 'vello-gpu' ? VELLO_GPU_GLUE_PATH : undefined
      const vello = (await loadVelloModule(gluePath)) as unknown as WasmModule
      wasmModuleInstance = vello
      wasmModuleError = null
      return vello
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

