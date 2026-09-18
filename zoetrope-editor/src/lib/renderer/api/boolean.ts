/**
 * Boolean operations
 */

import type { WasmModule } from '../wasm-types'
import type { BoolType, PathContent } from '../types'
import type { PenpotNode } from 'penpot-exporter/types'
import {
  allocBytes,
  freeBytes,
  writeUUIDToHeap,
  offset8To32,
  getAllocSize,
  sliceHeap,
} from '../utils'
import { translateBoolType } from './serializers'
import { checkContext } from './context'
import { UUID_U8_SIZE } from './constants'
import { moduleUseShape } from './shape'
import { setObject } from './orchestration'
import { pathFromBytes, serializePathContent } from './path'

/**
 * Segment size constants
 */
const SEGMENT_U32_SIZE = 7 // 28 bytes / 4
const SEGMENT_U8_SIZE = 28

/**
 * Gets all children including nested children for a shape
 */
function getAllChildrenWithSelf(objects: Record<string, PenpotNode>, id: string): PenpotNode[] {
  const result: PenpotNode[] = []
  const visited = new Set<string>()

  function collectChildren(currentId: string): void {
    if (visited.has(currentId)) {
      return
    }
    visited.add(currentId)

    const node = objects[currentId]
    if (!node) {
      return
    }

    result.push(node)

    if ('shapes' in node && node.shapes) {
      for (const childId of node.shapes) {
        collectChildren(childId)
      }
    }
  }

  collectChildren(id)
  return result
}

/**
 * Reads path content from heap
 * Path format: length (u32) followed by segments (each segment is 7 u32 values = 28 bytes)
 * Matches ClojureScript implementation
 */
function readPathContentFromHeap(
  module: WasmModule,
  heap: Uint32Array,
  offset: number
): PathContent {
  const length = heap[offset]
  const data = sliceHeap(heap, offset + 1, length * SEGMENT_U32_SIZE)
  const heapF32 = module.HEAPF32

  // Call pathFromBytes with the sliced data and base offset for reading floats
  // baseOffset is offset + 1 (skip the length field)
  return pathFromBytes(data, heapF32, offset + 1)
}

/**
 * Calculate boolean operation
 */
export function calculateBool(
  module: WasmModule,
  shape: { boolType: BoolType; shapes: string[] },
  objects: Record<string, PenpotNode>
): PathContent | null {
  checkContext()

  // Start temp objects
  module._start_temp_objects()

  try {
    const boolType = translateBoolType(shape.boolType)
    const ids = shape.shapes

    // Get all children including nested children
    const allChildren: PenpotNode[] = []
    for (const id of ids) {
      allChildren.push(...getAllChildrenWithSelf(objects, id))
    }

    // Initialize shapes pool
    module._init_shapes_pool(allChildren.length)

    // Serialize all children
    for (const child of allChildren) {
      setObject(module, child)
    }

    // Write shape IDs to heap (in reverse order)
    const size = getAllocSize(ids.length, UUID_U8_SIZE)
    const offset = offset8To32(allocBytes(module, size))
    const heap = module.HEAPU32

    let currentOffset = offset
    for (let i = ids.length - 1; i >= 0; i--) {
      currentOffset = writeUUIDToHeap(currentOffset, heap, ids[i])
    }

    // Calculate bool and get result
    const resultOffset = offset8To32(module._calculate_bool(boolType))
    const pathContent = readPathContentFromHeap(module, heap, resultOffset)

    freeBytes(module)

    return pathContent
  } finally {
    // End temp objects
    module._end_temp_objects()
  }
}

/**
 * Curve-native boolean of two arbitrary path contents (`subject OP clip`).
 *
 * Unlike {@link calculateBool} — which operates on shapes already in the scene by
 * id — this takes raw geometry, so the eraser can subtract a transient brush band
 * or lasso that is not a document shape. The operation runs on real béziers in
 * Rust (`curve-bool`/linesweeper): no flattening to polygons and no re-fitting, so
 * the surviving outline keeps the shape's exact curves. Returns `null` when both
 * operands are empty; an engine failure comes back as an empty-segment content.
 *
 * `fillRule` decides how the subject's own nested rings (holes) are read; it
 * defaults to non-zero to match the renderer's default fill.
 */
export function pathBoolean(
  module: WasmModule,
  subject: PathContent,
  clip: PathContent,
  boolType: BoolType,
  fillRule: 'nonzero' | 'evenodd' = 'nonzero',
): PathContent | null {
  checkContext()

  const subjectBytes = serializePathContent(subject)
  const clipBytes = serializePathContent(clip)
  const totalBytes = subjectBytes.length + clipBytes.length
  if (totalBytes === 0) return null

  const combined = new Uint8Array(totalBytes)
  combined.set(subjectBytes, 0)
  combined.set(clipBytes, subjectBytes.length)

  const heapOffset = offset8To32(allocBytes(module, totalBytes))
  const combinedU32 = new Uint32Array(combined.buffer, combined.byteOffset, totalBytes / 4)
  module.HEAPU32.set(combinedU32, heapOffset)

  const subjectSegCount = subjectBytes.length / SEGMENT_U8_SIZE
  const fillNum = fillRule === 'evenodd' ? 1 : 0
  const resultOffset = offset8To32(
    module._path_boolean(translateBoolType(boolType), fillNum, subjectSegCount),
  )
  const out = readPathContentFromHeap(module, module.HEAPU32, resultOffset)

  freeBytes(module)
  return out
}

/**
 * Convert shape to path
 */
export function shapeToPath(module: WasmModule, id: string): PathContent {
  checkContext()
  moduleUseShape(module, id)
  const offset = offset8To32(module._current_to_path())
  const heap = module.HEAPU32
  
  // Read path content from heap
  const pathContent = readPathContentFromHeap(module, heap, offset)

  freeBytes(module)
  return pathContent
}

