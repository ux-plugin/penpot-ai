import { describe, expect, it } from 'vitest'
import {
  createModuleFacade,
  type RawWasmExports,
} from '../../../src/lib/renderer/vello-module-facade'

/** A stand-in for what wasm-bindgen's `init()` resolves to. The memory is real. */
function fakeExports(overrides: Record<string, unknown> = {}): RawWasmExports {
  return {
    memory: new WebAssembly.Memory({ initial: 1 }),
    alloc_bytes: (n: number) => n,
    set_shape_fills: () => 7,
    create_focus_renderer: () => 'bindgen',
    ...overrides,
  } as RawWasmExports
}

describe('createModuleFacade', () => {
  it('maps Emscripten underscore names onto raw exports', () => {
    const m = createModuleFacade(fakeExports())
    expect((m._alloc_bytes as (n: number) => number)(12)).toBe(12)
    expect((m._set_shape_fills as () => number)()).toBe(7)
  })

  it('passes non-prefixed names through, so bindgen exports stay reachable', () => {
    const m = createModuleFacade(fakeExports())
    expect((m.create_focus_renderer as () => string)()).toBe('bindgen')
  })

  it('returns undefined for exports that do not exist', () => {
    const m = createModuleFacade(fakeExports())
    expect(m._nope).toBeUndefined()
    expect('_nope' in m).toBe(false)
    expect('_alloc_bytes' in m).toBe(true)
    expect('HEAPU8' in m).toBe(true)
  })

  it('exposes a heap view over the wasm memory', () => {
    const exports = fakeExports()
    const m = createModuleFacade(exports)

    m.HEAPU8[0] = 0xab
    expect(new Uint8Array(exports.memory.buffer)[0]).toBe(0xab)
    expect(m.HEAP8.length).toBe(m.HEAPU8.length)
  })

  /**
   * The reason `HEAPU8` is a getter rather than a cached field. Growing wasm memory detaches
   * the previous ArrayBuffer, turning any held view into a zero-length husk — writes through
   * it are lost silently. This is the bug the facade exists to prevent.
   */
  it('re-derives the heap view after memory growth', () => {
    const exports = fakeExports()
    const m = createModuleFacade(exports)

    const stale = m.HEAPU8
    const sizeBefore = stale.length
    expect(sizeBefore).toBe(65536)

    exports.memory.grow(1)

    // The view captured before the grow is now detached.
    expect(stale.length).toBe(0)

    // The facade hands back a live one, and writes through it land in the real memory.
    const fresh = m.HEAPU8
    expect(fresh.length).toBe(sizeBefore * 2)
    fresh[70000] = 0x5c
    expect(new Uint8Array(exports.memory.buffer)[70000]).toBe(0x5c)
  })

  it('rejects exports without a memory rather than failing later', () => {
    const broken = { alloc_bytes: () => 0 } as unknown as RawWasmExports
    expect(() => createModuleFacade(broken)).toThrow(/no `memory`/)
  })
})
