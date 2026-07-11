/**
 * RustRuntime — the optional Rust→WASM evaluation path, feature-detected. Loads
 * the AnimDoc into render-wasm once, updates params event-driven, and evaluates
 * each frame by reading render-wasm's pre-allocated frame buffer via `HEAPF32`.
 * If render-wasm wasn't built with the anim FFI, every call is a safe no-op and
 * the PlaybackController transparently falls back to the TS engine.
 *
 * Node order is derived here with the SAME first-appearance rule as the Rust
 * `Session`, so the buffer's node-major records map back to ids without a table
 * crossing the boundary. Memory-growth discipline: the frame buffer is
 * pre-allocated in the runtime (`load_doc`), and `HEAPF32` is re-read fresh every
 * frame (never cached) so a growth elsewhere can't hand us a detached view.
 */

import { getWasmModule } from '../wasm-module'
import { serializeAnimDoc } from '../anim/serialize'
import type { AnimDoc } from '../anim/types'
import type { EvalContext } from '../anim/sample'

/** Render-facing prop slots — MUST match `anim_runtime::session::PROPS` byte-for-byte. */
const PROPS = ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity'] as const

/** The anim FFI surface added to render-wasm (present only when built with it). */
interface AnimModule {
  _alloc_bytes(size: number): number
  _anim_load_doc(): void
  _anim_set_param(index: number, value: number): void
  _anim_eval(time: number): number
  HEAPU8: Uint8Array
  HEAPF32: Float32Array
}

function animModule(): AnimModule | null {
  const m = getWasmModule() as unknown as (AnimModule & Record<string, unknown>) | null
  if (!m || typeof m._anim_eval !== 'function' || typeof m._anim_load_doc !== 'function') return null
  return m
}

let nodeOrder: string[] = []
let loaded = false

// The Rust path is OFF by default: the TS engine is the verified default, and
// the Rust eval hasn't been validated on a real canvas yet. Flip it on to test —
// in the browser console: `__animRust(true)` then play.
let enabled = false

/** Enable/disable the Rust evaluation path at runtime (default off). */
export function setRustRuntimeEnabled(value: boolean): void {
  enabled = value
}

export function rustRuntimeEnabled(): boolean {
  return enabled
}

/** Whether render-wasm was built with the anim FFI. */
export function rustRuntimeAvailable(): boolean {
  return animModule() !== null
}

/** Node ids in the SAME order the Rust session assigns (first appearance across bindings). */
function deriveNodeOrder(doc: AnimDoc): string[] {
  const order: string[] = []
  const seen = new Set<string>()
  for (const tl of doc.timelines) {
    for (const b of tl.bindings) {
      if (b.target.object.kind !== 'node') continue
      const id = b.target.object.id
      if (!seen.has(id)) {
        seen.add(id)
        order.push(id)
      }
    }
  }
  return order
}

/** Load a document into the Rust runtime (once per edit). No-op when unavailable. */
export function rustLoadDoc(doc: AnimDoc): void {
  const m = animModule()
  if (!m) {
    loaded = false
    return
  }
  nodeOrder = deriveNodeOrder(doc)
  const bytes = new TextEncoder().encode(serializeAnimDoc(doc))
  // _alloc_bytes may grow memory — fine, it's a load-time (rare) call, and we
  // re-read HEAPU8 right after via the fresh `m.HEAPU8`.
  const ptr = m._alloc_bytes(bytes.length)
  m.HEAPU8.set(bytes, ptr)
  m._anim_load_doc() // consumes the scratch buffer (mem::bytes) — no free needed
  loaded = true
}

/** Update a live parameter value by its index. No-op when unavailable. */
export function rustSetParam(index: number, value: number): void {
  const m = animModule()
  if (m && loaded) m._anim_set_param(index, value)
}

/**
 * Evaluate at `ctx.time` (params live inside the runtime). Returns per-node
 * property bags, or `null` when the Rust path is unavailable / no doc is loaded —
 * the controller then falls back to the TS engine.
 */
export function rustEval(ctx: EvalContext): Map<string, Record<string, number>> | null {
  if (!enabled) return null
  const m = animModule()
  if (!m || !loaded || nodeOrder.length === 0) return null
  const ptr = m._anim_eval(ctx.time)
  if (!ptr) return null
  const heap = m.HEAPF32 // fresh each frame — never cached across a wasm call
  const base = ptr >>> 2
  const stride = PROPS.length
  const out = new Map<string, Record<string, number>>()
  for (let i = 0; i < nodeOrder.length; i++) {
    const recBase = base + i * stride
    let props: Record<string, number> | null = null
    for (let s = 0; s < stride; s++) {
      const v = heap[recBase + s]
      if (Number.isNaN(v)) continue
      if (!props) props = {}
      props[PROPS[s]] = v
    }
    if (props) out.set(nodeOrder[i], props)
  }
  return out
}

/**
 * One-shot diagnostic: after authoring some motion (so the doc is loaded), returns
 * what the Rust runtime actually produces — the loaded state, node order, and the
 * raw frame buffer at a few times. Run `__animRustDebug()` in the console and share
 * the output to pinpoint where the on-canvas eval diverges (ptr null = not loaded;
 * all-NaN buffer = eval produced nothing; real numbers = the apply side is at fault).
 */
export function rustRuntimeDebug(): unknown {
  const m = animModule()
  if (!m) return { available: false, reason: 'render-wasm built without the anim FFI' }
  const stride = PROPS.length
  const dump = (t: number): unknown => {
    const ptr = m._anim_eval(t)
    if (!ptr) return { time: t, ptr, buffer: null }
    const base = ptr >>> 2
    return { time: t, ptr, buffer: Array.from(m.HEAPF32.subarray(base, base + nodeOrder.length * stride)) }
  }
  return { available: true, loaded, nodeOrder, props: PROPS, frames: [dump(0), dump(500), dump(750)] }
}

// Dev hooks: toggle the Rust path and inspect it from the browser console while we
// validate it against a real canvas (headless has no GL surface, so this is where
// it's tested).
if (typeof window !== 'undefined') {
  const w = window as unknown as { __animRust?: (v: boolean) => void; __animRustDebug?: () => unknown }
  w.__animRust = setRustRuntimeEnabled
  w.__animRustDebug = rustRuntimeDebug
}
