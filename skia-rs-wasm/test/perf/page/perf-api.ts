/**
 * Thin wrappers around the perf-trace wasm exports. Decouples the
 * page + runner from the raw `_dump_perf_snapshot` byte layout.
 *
 * Snapshot wire format: 4-byte little-endian length prefix, then
 * UTF-8 JSON payload. Mirrors `render-wasm/src/perf_trace.rs`.
 */
import type { WasmModule } from '@/lib/renderer/wasm-types'
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

/**
 * Apply a translation to a single shape via the wasm `_set_modifiers`
 * pipeline. Mirrors the byte layout in
 * `render-wasm/src/shapes/transform.rs::TransformEntry::From<[u8;40]>`:
 *
 *   [0..16]  UUID as 4 LE u32s (matches `uuid_to_u32_quartet`)
 *   [16..40] 6 LE f32s laid out as
 *            a, b, c, d, tx, ty (with the cross-stored skew/translate
 *            order that From<[u8;40]> reads).
 *
 * `_set_modifiers` consumes the buffer ownership-style — no
 * `_free_bytes` after.
 */
export function setShapeTranslation(
  module: WasmModule,
  uuidQuartet: readonly [number, number, number, number],
  dx: number,
  dy: number,
): void {
  const SIZE = 40
  const ptr = module._alloc_bytes(SIZE)
  const view = new DataView(module.HEAPU8.buffer, ptr, SIZE)
  view.setUint32(0, uuidQuartet[0] >>> 0, true)
  view.setUint32(4, uuidQuartet[1] >>> 0, true)
  view.setUint32(8, uuidQuartet[2] >>> 0, true)
  view.setUint32(12, uuidQuartet[3] >>> 0, true)
  // Identity matrix + translate. Layout matches the Rust reader:
  //   bytes[16..20] = transform[0]  (a)
  //   bytes[20..24] = transform[3]  (b — skew y)
  //   bytes[24..28] = transform[1]  (c — skew x)
  //   bytes[28..32] = transform[4]  (d)
  //   bytes[32..36] = transform[2]  (tx)
  //   bytes[36..40] = transform[5]  (ty)
  view.setFloat32(16, 1.0, true)
  view.setFloat32(20, 0.0, true)
  view.setFloat32(24, 0.0, true)
  view.setFloat32(28, 1.0, true)
  view.setFloat32(32, dx, true)
  view.setFloat32(36, dy, true)
  module._set_modifiers()
}

/**
 * UUID quartet for the first leaf in any scene built by the
 * test_fixtures Rust module. Both `build_flat` and `build_nested`
 * use `Uuid::from_u64_pair(0xCAFE, idx)` for leaves; the resulting
 * u32 quartet for `idx=0` is `(0, 0xCAFE, 0, 0)`. Used as the move
 * scenario's drag target.
 */
export const FIRST_LEAF_UUID_QUARTET: readonly [number, number, number, number] = [
  0,
  0xcafe,
  0,
  0,
]
