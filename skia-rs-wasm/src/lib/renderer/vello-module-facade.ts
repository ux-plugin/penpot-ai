/**
 * Presents a raw wasm-bindgen module as the Emscripten-shaped `Module` object that the
 * `api/*.ts` layer already drives.
 *
 * Why this exists (D17): the Skia and Vello backends ship as separate wasm artifacts for
 * different targets, so their *runtimes* differ even though their ABI does not. Emscripten
 * gives you `Module._some_fn(...)` and a `HEAPU8` view; a wasm-bindgen module gives you
 * `instance.exports.some_fn(...)` and a `WebAssembly.Memory`. Rather than port 34 api modules
 * and ~170 call sites, we reshape the runtime once, here.
 *
 * Verified in-browser before this was written: a `#[unsafe(no_mangle)] extern "C"` function
 * survives wasm-bindgen's rewrite and is callable off the exports object, alongside
 * wasm-bindgen's own bindings, with `memory` exported. Both mechanisms coexist in one module.
 *
 * The subtle part is `HEAPU8`. Growing wasm memory **detaches** the old `ArrayBuffer`, so any
 * cached view silently becomes a zero-length husk. Emscripten republishes `Module.HEAPU8` on
 * growth; here the getter re-derives the view whenever the underlying buffer identity changes.
 * render-wasm's own callers already know this hazard — `motion/rust-runtime.ts` re-reads
 * `m.HEAPU8` right after allocating for exactly this reason.
 */

/** The subset of the Emscripten module shape that `api/*.ts` actually touches. */
export interface EmscriptenLikeModule {
  readonly HEAP8: Int8Array
  readonly HEAPU8: Uint8Array
  // Emscripten exposes C functions with a leading underscore.
  readonly [exportName: string]: unknown
}

/** Anything with the two things we need: the memory and the exported functions. */
export interface RawWasmExports {
  readonly memory: WebAssembly.Memory
  readonly [name: string]: unknown
}

/**
 * Wrap raw wasm exports in an Emscripten-shaped facade.
 *
 * `exports` is what wasm-bindgen's `init()` resolves to — it carries both the generated
 * bindings and any raw `#[unsafe(no_mangle)]` functions.
 */
export function createModuleFacade(exports: RawWasmExports): EmscriptenLikeModule {
  const memory = exports.memory
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new TypeError('wasm exports have no `memory`; cannot build a Module facade')
  }

  // Cache the views but key them on buffer identity: after a grow, `memory.buffer` is a new
  // ArrayBuffer object and the previous one is detached.
  let cachedBuffer: ArrayBufferLike | null = null
  let heapU8: Uint8Array | null = null
  let heap8: Int8Array | null = null

  const refresh = (): void => {
    if (cachedBuffer === memory.buffer) return
    cachedBuffer = memory.buffer
    heapU8 = new Uint8Array(cachedBuffer)
    heap8 = new Int8Array(cachedBuffer)
  }

  // Bound functions are memoised so repeated `module._foo` lookups don't allocate per call.
  const bound = new Map<string, unknown>()

  const base = {
    get HEAPU8(): Uint8Array {
      refresh()
      return heapU8 as Uint8Array
    },
    get HEAP8(): Int8Array {
      refresh()
      return heap8 as Int8Array
    },
  }

  return new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver)
      if (prop === 'HEAPU8' || prop === 'HEAP8') return Reflect.get(target, prop, receiver)

      if (bound.has(prop)) return bound.get(prop)

      // `Module._foo` -> export `foo`. Non-prefixed names pass through unchanged so callers
      // can still reach wasm-bindgen's own exports if they need to.
      const name = prop.startsWith('_') ? prop.slice(1) : prop
      const value = exports[name]
      if (value === undefined) return undefined

      bound.set(prop, value)
      return value
    },

    has(target, prop) {
      if (typeof prop !== 'string') return Reflect.has(target, prop)
      if (prop === 'HEAPU8' || prop === 'HEAP8') return true
      const name = prop.startsWith('_') ? prop.slice(1) : prop
      return name in exports
    },
  }) as unknown as EmscriptenLikeModule
}
