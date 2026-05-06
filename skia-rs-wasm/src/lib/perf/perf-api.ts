/**
 * Thin wrappers around the perf-trace wasm exports. Decouples the
 * page + runner from the raw `_dump_perf_snapshot` byte layout.
 *
 * Snapshot wire format: 4-byte little-endian length prefix, then
 * UTF-8 JSON payload. Mirrors `render-wasm/src/perf_trace.rs`.
 */
import type { WasmModule } from '../renderer/wasm-types'
import type { PerfSnapshot } from './perf-types'

const EMPTY_SNAPSHOT: PerfSnapshot = {
  frames: 0,
  wall_ms: 0,
  cache: { tile_hits: 0, tile_misses: 0, tile_writes: 0 },
  stats: [],
}

/**
 * Read the perf snapshot from BUFFERU8. Returns an empty snapshot
 * when the wasm was built without `perf-trace` (length prefix is 0).
 */
export function dumpSnapshot(module: WasmModule): PerfSnapshot {
  const ptr = module._dump_perf_snapshot()
  if (!ptr) {
    return { ...EMPTY_SNAPSHOT }
  }
  // Length prefix is 4 bytes LE.
  const heap = module.HEAPU8
  const len =
    heap[ptr] |
    (heap[ptr + 1] << 8) |
    (heap[ptr + 2] << 16) |
    (heap[ptr + 3] << 24)
  let snapshot: PerfSnapshot
  if (len <= 0) {
    snapshot = { ...EMPTY_SNAPSHOT }
  } else {
    const bytes = heap.subarray(ptr + 4, ptr + 4 + len)
    const text = new TextDecoder('utf-8').decode(bytes)
    try {
      snapshot = JSON.parse(text) as PerfSnapshot
    } catch (e) {
      console.error('perf: failed to parse snapshot JSON', e, text.slice(0, 200))
      snapshot = { ...EMPTY_SNAPSHOT }
    }
  }
  // BUFFERU8 lifecycle requires releasing after every successful
  // `_dump_perf_snapshot` even when the payload was empty — Rust
  // panics on the next write_bytes if a buffer is already held.
  module._free_bytes()
  return snapshot
}

export function clearSnapshot(module: WasmModule): void {
  module._clear_perf_snapshot()
}

export function buildPerfScene(module: WasmModule, sceneId: number): void {
  module._build_perf_scene(sceneId)
}

export function perfPresetCount(module: WasmModule): number {
  // 0 indicates the wasm was built without `perf-trace`.
  try {
    return module._perf_preset_count()
  } catch {
    return 0
  }
}
