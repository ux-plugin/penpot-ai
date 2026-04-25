/**
 * Modifier operations
 */

import type { WasmModule } from '../wasm-types'
import type { Matrix } from 'penpot-exporter/types'
import { u32ToUUID } from '../types'
import {
  allocBytes,
  freeBytes,
  writeUUIDToHeap,
  writeMatrixToHeap,
  offset8To32,
  getAllocSize,
  writeU32ToHeap,
  writeF32ToHeap,
} from '../utils'
import {
  translateStructureModifierType,
} from './serializers'
import { checkContext } from './context'
import { MODIFIER_U8_SIZE, MODIFIER_U32_SIZE, PROPAGATE_MODIFIER_ENTRY_U8_SIZE } from './constants'
import { requestRender } from './rendering'

/**
 * Set modifiers
 */
export function setModifiers(module: WasmModule, modifiers: Array<[string, Matrix]>, skipRender = false): void {
  checkContext()
  if (modifiers.length === 0) {
    return
  }

  const offset = offset8To32(allocBytes(module, MODIFIER_U8_SIZE * modifiers.length))
  const heapU32 = module.HEAPU32
  const heapF32 = module.HEAPF32

  let currentOffset = offset
  for (const [id, transform] of modifiers) {
    currentOffset = writeUUIDToHeap(currentOffset, heapU32, id)
    currentOffset = writeMatrixToHeap(currentOffset, heapF32, transform)
  }

  module._set_modifiers()
  freeBytes(module)
  if (!skipRender) {
    requestRender(module, 'set-modifiers')
  }
}

/**
 * Propagate modifiers.
 *
 * `kind` selects how the Rust side treats the entries:
 *  - 'parent' (default) → `propagate=false` → the transform is for a parent
 *    shape whose children's modifiers were already computed elsewhere; Rust
 *    does not re-walk descendants. Mirrors CLJS `:parent` branch in
 *    `parse-geometry-modifiers` (modifiers.cljs:574–580).
 *  - 'child' → `propagate=true` → propagate the transform through
 *    constraint-based children. **Required** for move/resize/rotate of a
 *    selection that may contain container shapes whose descendants must
 *    follow via constraints. Mirrors CLJS `:child` branch.
 *
 * Default is `'parent'` because `'child'` triggers a constraint walk over
 * every descendant and changes the visible behavior (children move with
 * their container). Gesture handlers (move / resize / rotate) opt in
 * explicitly at their callsites; non-gesture callers stay at `'parent'`.
 *
 * The Rust boundary maps `kind=Child(1) → propagate=true` and
 * `kind=Parent(0) → propagate=false` at `render-wasm/src/wasm/transforms.rs:72`.
 */
export function propagateModifiers(
  module: WasmModule,
  entries: Array<[string, Matrix]>,
  pixelPrecision: number,
  kind: 'parent' | 'child' = 'parent',
): Array<{ id: string; transform: Matrix }> {
  checkContext()
  if (entries.length === 0) {
    return []
  }

  const offset = offset8To32(allocBytes(module, PROPAGATE_MODIFIER_ENTRY_U8_SIZE * entries.length))
  const heapU32 = module.HEAPU32
  const heapF32 = module.HEAPF32

  const kindByte = kind === 'child' ? 1 : 0
  let currentOffset = offset
  for (const [id, transform] of entries) {
    currentOffset = writeUUIDToHeap(currentOffset, heapU32, id)
    currentOffset = writeMatrixToHeap(currentOffset, heapF32, transform)
    heapU32[currentOffset] = kindByte
    currentOffset += 1
  }

  const resultOffset = offset8To32(module._propagate_modifiers(pixelPrecision))
  const length = heapU32[resultOffset]
  const maxOffset = resultOffset + 1 + length * MODIFIER_U32_SIZE

  const result: Array<{ id: string; transform: Matrix }> = []
  let readOffset = resultOffset + 1

  while (readOffset < maxOffset) {
    // Read UUID
    const idBuffer = new Uint32Array(4)
    idBuffer[0] = heapU32[readOffset]
    idBuffer[1] = heapU32[readOffset + 1]
    idBuffer[2] = heapU32[readOffset + 2]
    idBuffer[3] = heapU32[readOffset + 3]
    readOffset += 4

    // Read transform
    const transform: Matrix = {
      a: heapF32[readOffset],
      b: heapF32[readOffset + 1],
      c: heapF32[readOffset + 2],
      d: heapF32[readOffset + 3],
      e: heapF32[readOffset + 4],
      f: heapF32[readOffset + 5],
    }
    readOffset += 6

    // Convert UUID buffer to string
    const id = u32ToUUID(idBuffer)
    result.push({ id, transform })
  }

  freeBytes(module)
  return result
}

/**
 * Clean modifiers
 */
export function cleanModifiers(module: WasmModule): void {
  checkContext()
  module._clean_modifiers()
}

/**
 * Set structure modifiers
 */
export function setStructureModifiers(
  module: WasmModule,
  entries: Array<{
    type: string
    parent: string
    id: string
    index?: number
    value: number
  }>
): void {
  checkContext()
  if (entries.length === 0) {
    return
  }

  const size = getAllocSize(entries.length, 44) // MODIFIER size
  const offset = offset8To32(allocBytes(module, size))
  const heapU32 = module.HEAPU32
  const heapF32 = module.HEAPF32

  let currentOffset = offset
  for (const entry of entries) {
    currentOffset = writeU32ToHeap(currentOffset, heapU32, translateStructureModifierType(entry.type))
    currentOffset = writeU32ToHeap(currentOffset, heapU32, entry.index || 0)
    currentOffset = writeUUIDToHeap(currentOffset, heapU32, entry.parent)
    currentOffset = writeUUIDToHeap(currentOffset, heapU32, entry.id)
    currentOffset = writeF32ToHeap(currentOffset, heapF32, entry.value)
  }

  module._set_structure_modifiers()
  freeBytes(module)
}

