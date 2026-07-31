/**
 * Instantiates the real `render-vello` wasm in Node, with no browser and no GPU.
 *
 * The point is to drive the *actual* `api/*.ts` modules against the *actual* Vello backend, so
 * the claim "the host layer is untouched" is checked by execution rather than by inspection.
 *
 * How it works: a wasm-bindgen module imports ~600 glue functions, all of which are calls from
 * Rust *into* JS — canvas, wgpu, web-sys. The C-style ABI touches none of them; it is plain
 * state manipulation over the module's own memory. So every import is stubbed with a thrower.
 * If a stub is ever hit, that is a real finding — it means an ABI entry point reached for the
 * browser — and the throw names the function.
 *
 * The renderer half (`create_focus_renderer`, `FocusRenderer`) genuinely needs a browser and is
 * not exercised here; that is what the `dev/` harness is for.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createModuleFacade, type EmscriptenLikeModule } from '../../../src/lib/renderer/vello-module-facade'

const WASM_PATH = fileURLToPath(
  new URL('../../../../render-vello/dev/pkg/render-vello_bg.wasm', import.meta.url)
)

/** Built by `render-vello/dev/build.sh`; skip rather than fail when it has not been run. */
export function velloWasmAvailable(): boolean {
  try {
    readFileSync(WASM_PATH)
    return true
  } catch {
    return false
  }
}

export interface VelloInstance {
  /** The Emscripten-shaped module `api/*.ts` drives. */
  module: EmscriptenLikeModule
  /** Raw exports, for assertions the host layer has no API for. */
  exports: Record<string, (...args: number[]) => number>
  /** Entry points the host called that this backend does not implement yet. */
  missing: string[]
}

export async function loadVello(): Promise<VelloInstance> {
  const mod = await WebAssembly.compile(readFileSync(WASM_PATH))

  const imports: Record<string, Record<string, unknown>> = {}
  for (const { module, name, kind } of WebAssembly.Module.imports(mod)) {
    imports[module] ??= {}
    switch (kind) {
      case 'function':
        imports[module][name] = () => {
          throw new Error(`render-vello reached browser glue from the ABI path: ${name}`)
        }
        break
      case 'memory':
        imports[module][name] = new WebAssembly.Memory({ initial: 1 })
        break
      case 'global':
        imports[module][name] = new WebAssembly.Global({ value: 'i32', mutable: true }, 0)
        break
      case 'table':
        imports[module][name] = new WebAssembly.Table({ initial: 1, element: 'anyfunc' })
        break
    }
  }

  const instance = await WebAssembly.instantiate(mod, imports)
  const exports = instance.exports as unknown as VelloInstance['exports'] & {
    memory: WebAssembly.Memory
  }

  const missing: string[] = []
  const module = createModuleFacade(exports, {
    stubMissingExports: true,
    onMissing: (name) => missing.push(name),
  })

  return { module, exports, missing }
}
