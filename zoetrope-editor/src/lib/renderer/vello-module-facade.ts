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
  readonly HEAP16: Int16Array
  readonly HEAPU16: Uint16Array
  readonly HEAP32: Int32Array
  readonly HEAPU32: Uint32Array
  readonly HEAPF32: Float32Array
  readonly HEAPF64: Float64Array
  // Emscripten exposes C functions with a leading underscore.
  readonly [exportName: string]: unknown
}

/**
 * Every heap view Emscripten publishes, and the constructor for each.
 *
 * All of them, not just the ones a page sync happens to touch: the host reaches for whichever
 * width suits the data — `HEAPU32` for uuids, `HEAPF32` for rects — and an absent view is not a
 * missing feature but a `TypeError` deep inside an unrelated call. One table drives both the
 * getters and the proxy's own key checks, so the two cannot drift apart.
 */
const HEAP_VIEWS = {
  HEAP8: Int8Array,
  HEAPU8: Uint8Array,
  HEAP16: Int16Array,
  HEAPU16: Uint16Array,
  HEAP32: Int32Array,
  HEAPU32: Uint32Array,
  HEAPF32: Float32Array,
  HEAPF64: Float64Array,
} as const

type HeapName = keyof typeof HEAP_VIEWS

/** Anything with the two things we need: the memory and the exported functions. */
export interface RawWasmExports {
  readonly memory: WebAssembly.Memory
  readonly [name: string]: unknown
}

export interface FacadeOptions {
  /**
   * Stand in for entry points the module has not implemented yet, instead of letting
   * `module._foo(...)` fail with "is not a function".
   *
   * The Vello backend implements a fraction of render-wasm's ~150 entry points — text, layouts,
   * effects and materials are all later phases — but the host calls them unconditionally while
   * syncing a page. Without this, the first text shape kills the renderer.
   *
   * The stub returns 0, not undefined: callers treat these as numbers or pointers, and
   * `undefined` propagates into arithmetic as NaN, which fails somewhere far from the cause.
   *
   * **This is Phase-2 scaffolding, and it hides real errors by design.** Keep it off for the
   * Skia backend, where a missing export is a genuine bug. `onMissing` fires once per name, so
   * a run doubles as a census of what a real document actually needs.
   */
  readonly stubMissingExports?: boolean
  /** Called once per distinct missing export name. */
  readonly onMissing?: (name: string) => void
}

/**
 * Wrap raw wasm exports in an Emscripten-shaped facade.
 *
 * `exports` is what wasm-bindgen's `init()` resolves to — it carries both the generated
 * bindings and any raw `#[unsafe(no_mangle)]` functions.
 */
export function createModuleFacade(
  exports: RawWasmExports,
  options: FacadeOptions = {}
): EmscriptenLikeModule {
  const memory = exports.memory
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new TypeError('wasm exports have no `memory`; cannot build a Module facade')
  }

  const reportedMissing = new Set<string>()
  const stubFor = (name: string): (() => number) => {
    if (!reportedMissing.has(name)) {
      reportedMissing.add(name)
      options.onMissing?.(name)
    }
    return () => 0
  }

  // Cache the views but key them on buffer identity: after a grow, `memory.buffer` is a new
  // ArrayBuffer object and the previous one is detached.
  let cachedBuffer: ArrayBufferLike | null = null
  const views = new Map<HeapName, ArrayBufferView>()

  const refresh = (): void => {
    if (cachedBuffer === memory.buffer) return
    cachedBuffer = memory.buffer
    views.clear()
  }

  const view = (name: HeapName): ArrayBufferView => {
    refresh()
    let v = views.get(name)
    if (!v) {
      v = new HEAP_VIEWS[name](cachedBuffer as ArrayBuffer)
      views.set(name, v)
    }
    return v
  }

  // Bound functions are memoised so repeated `module._foo` lookups don't allocate per call.
  const bound = new Map<string, unknown>()

  const base = Object.defineProperties(
    {
      /**
       * Emscripten's C-string reader, reimplemented over the same heap: decode UTF-8 from `ptr`
       * up to the first NUL. The editor ABI returns NUL-terminated buffers
       * (`text_editor_export_content`) that `api/text-editor.ts` reads through this.
       */
      UTF8ToString(ptr: number, maxBytesToRead?: number): string {
        if (!ptr) return ''
        const heap = view('HEAPU8') as Uint8Array
        const limit = maxBytesToRead === undefined ? heap.length : Math.min(heap.length, ptr + maxBytesToRead)
        let end = ptr
        while (end < limit && heap[end] !== 0) end++
        return new TextDecoder().decode(heap.subarray(ptr, end))
      },
      /**
       * Emscripten's C-string writer: encode `str` as UTF-8 at `outPtr`, NUL-terminated, never
       * exceeding `maxBytesToWrite`. Returns the number of bytes written excluding the NUL,
       * matching Emscripten's contract (`api/svg.ts` writes SVG payloads through this).
       */
      stringToUTF8(str: string, outPtr: number, maxBytesToWrite: number): number {
        if (maxBytesToWrite <= 0) return 0
        const heap = view('HEAPU8') as Uint8Array
        const encoded = new TextEncoder().encode(str)
        const written = Math.min(encoded.length, maxBytesToWrite - 1)
        heap.set(encoded.subarray(0, written), outPtr)
        heap[outPtr + written] = 0
        return written
      },
    },
    Object.fromEntries(
      (Object.keys(HEAP_VIEWS) as HeapName[]).map((name) => [
        name,
        { get: () => view(name), enumerable: true, configurable: true },
      ])
    )
  )

  const isHeapName = (prop: string): prop is HeapName => prop in HEAP_VIEWS

  return new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver)
      // Heap views and the runtime helpers (UTF8ToString / stringToUTF8) live on the base object.
      if (isHeapName(prop) || Object.hasOwn(target, prop)) return Reflect.get(target, prop, receiver)

      if (bound.has(prop)) return bound.get(prop)

      // `Module._foo` -> export `foo`. Non-prefixed names pass through unchanged so callers
      // can still reach wasm-bindgen's own exports if they need to.
      const name = prop.startsWith('_') ? prop.slice(1) : prop
      const value = exports[name]
      if (value === undefined) {
        // Only stub the C-ABI namespace. A bare name is a wasm-bindgen export, and inventing
        // one would mask a genuine wiring mistake.
        if (!options.stubMissingExports || !prop.startsWith('_')) return undefined
        const stub = stubFor(name)
        bound.set(prop, stub)
        return stub
      }

      bound.set(prop, value)
      return value
    },

    has(target, prop) {
      if (typeof prop !== 'string') return Reflect.has(target, prop)
      if (isHeapName(prop) || Object.hasOwn(target, prop)) return true
      const name = prop.startsWith('_') ? prop.slice(1) : prop
      if (name in exports) return true
      return options.stubMissingExports === true && prop.startsWith('_')
    },
  }) as unknown as EmscriptenLikeModule
}
