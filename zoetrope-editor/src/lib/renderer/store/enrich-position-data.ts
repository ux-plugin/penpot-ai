/**
 * Position data for text nodes, computed by the WASM layout engine. Returns
 * the `mod`s that store it. Shapes must already be loaded into WASM.
 */
import type { WasmModule } from '../wasm-types'
import type { PositionDataEntry } from 'penpot-exporter/types'
import { mod, type Change, type Node } from '../../doc'
import { calculatePositionData } from '../api/text'

function mapToCamelCase(entry: {
  paragraph: number
  span: number
  'start-pos': number
  'end-pos': number
  x: number
  y: number
  width: number
  height: number
  direction: number
}): PositionDataEntry {
  return {
    paragraph: entry.paragraph,
    span: entry.span,
    startPos: entry['start-pos'],
    endPos: entry['end-pos'],
    x: entry.x,
    y: entry.y,
    width: entry.width,
    height: entry.height,
    direction: entry.direction,
  }
}

export function positionDataChanges(module: WasmModule, nodes: Iterable<Node>): Change[] {
  const out: Change[] = []
  for (const node of nodes) {
    if (node.type !== 'text') continue
    try {
      const raw = calculatePositionData(module, node)
      if (raw.length > 0) out.push(mod('node', node.id, { positionData: raw.map(mapToCamelCase) } as Partial<Node>))
    } catch {
      // layout unavailable for this node; leave it
    }
  }
  return out
}
