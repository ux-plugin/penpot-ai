/**
 * Records the ABI call stream, and replays it into any backend.
 *
 * This is the differential harness's transport. D17 gave the two backends one wire format and
 * one calling convention specifically so a capture from a live session could be replayed into
 * either — the recording is the *host's intent*, with no backend in it. Replay it into both,
 * compare what each ended up with, and a divergence is attributable: same bytes in, different
 * scene out.
 *
 * What is captured is everything that crosses the boundary: the name and arguments of each
 * `_call`, plus the bytes the host wrote through `HEAPU8` before any entry point that drains
 * the shared buffer. Without those bytes a recording would be missing every fill and path — the
 * arguments alone say nothing about them.
 *
 * The recording is plain JSON so a capture taken in a browser can be committed and replayed in
 * a test, which is the point: a real document becomes a fixture.
 */

import type { EmscriptenLikeModule } from './vello-module-facade'

export interface RecordedCall {
  /** Entry point name, without the Emscripten underscore. */
  readonly fn: string
  readonly args: readonly number[]
  /**
   * Bytes staged in the shared buffer at the moment of the call, base64-encoded.
   *
   * Present only for calls that consume the buffer. Base64 rather than a number array because a
   * page of fills runs to hundreds of kilobytes and JSON arrays of bytes are roughly 4x worse.
   */
  readonly buffer?: string
}

export interface Recording {
  readonly version: 1
  readonly calls: readonly RecordedCall[]
}

/**
 * Entry points that take their real payload from the shared buffer rather than from arguments.
 *
 * Deliberately a list rather than "record the buffer every time": staging is a separate step
 * from consuming it, and snapshotting on every call would capture the same bytes repeatedly and
 * make a recording quadratic in the number of shapes.
 */
const BUFFER_CONSUMERS = new Set([
  'set_shape_fills',
  'set_shape_path_content',
  'set_shape_path_chunk_buffer',
  'set_children',
  'set_shape_strokes',
  'set_shape_stroke_dashes',
  'set_shape_svg_attrs',
  'set_shape_text_content',
  'set_shape_blurs',
  'set_shape_shadows',
  'set_modifiers',
  'set_structure_modifiers',
])

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function fromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export interface Recorder {
  /** The module to hand to `api/*.ts` in place of the real one. */
  readonly module: EmscriptenLikeModule
  recording(): Recording
  reset(): void
}

/**
 * Wrap a module so every ABI call through it is recorded, then forwarded unchanged.
 *
 * Transparent by construction: `api/*.ts` cannot tell it is being recorded, so a capture is of
 * what the host really did rather than of what a separate instrumentation path thought it did.
 */
export function createRecorder(target: EmscriptenLikeModule): Recorder {
  const calls: RecordedCall[] = []
  /** Where the last `alloc_bytes` handed out, so the staged bytes can be read back. */
  let pendingPtr = 0
  let pendingLen = 0

  const wrapped = new Proxy(target, {
    get(_t, prop, receiver) {
      if (typeof prop !== 'string' || !prop.startsWith('_')) {
        return Reflect.get(target, prop, receiver)
      }
      const name = prop.slice(1)
      const fn = Reflect.get(target, prop, receiver)
      if (typeof fn !== 'function') return fn

      return (...args: number[]): unknown => {
        if (name === 'alloc_bytes') {
          pendingLen = args[0] ?? 0
          const ptr = (fn as (...a: number[]) => number)(...args)
          pendingPtr = ptr
          calls.push({ fn: name, args: [...args] })
          return ptr
        }

        let buffer: string | undefined
        if (BUFFER_CONSUMERS.has(name) && pendingPtr !== 0 && pendingLen > 0) {
          buffer = toBase64(target.HEAPU8.subarray(pendingPtr, pendingPtr + pendingLen))
          pendingPtr = 0
          pendingLen = 0
        }
        calls.push(buffer === undefined ? { fn: name, args: [...args] } : { fn: name, args: [...args], buffer })
        return (fn as (...a: number[]) => unknown)(...args)
      }
    },
  }) as EmscriptenLikeModule

  return {
    module: wrapped,
    recording: () => ({ version: 1, calls: [...calls] }),
    reset: () => {
      calls.length = 0
      pendingPtr = 0
      pendingLen = 0
    },
  }
}

/**
 * Replay a recording into a module.
 *
 * `alloc_bytes` is re-executed rather than replayed — the pointer a backend hands out is its own
 * business, and forcing the recorded one would write into whatever happens to live there. The
 * staged bytes are written at whatever address *this* backend returns, which is exactly the
 * indirection that lets one recording drive two different allocators.
 */
export function replay(module: EmscriptenLikeModule, recording: Recording): void {
  if (recording.version !== 1) {
    throw new Error(`unsupported recording version: ${String(recording.version)}`)
  }

  let ptr = 0
  for (const call of recording.calls) {
    const fn = module[`_${call.fn}`]
    if (typeof fn !== 'function') {
      throw new Error(`replay: module has no entry point _${call.fn}`)
    }

    if (call.fn === 'alloc_bytes') {
      ptr = (fn as (...a: number[]) => number)(...call.args)
      continue
    }
    if (call.buffer !== undefined) {
      const bytes = fromBase64(call.buffer)
      if (ptr === 0) {
        throw new Error(`replay: ${call.fn} needs staged bytes but no allocation is outstanding`)
      }
      module.HEAPU8.set(bytes, ptr)
      ptr = 0
    }
    ;(fn as (...a: number[]) => unknown)(...call.args)
  }
}
