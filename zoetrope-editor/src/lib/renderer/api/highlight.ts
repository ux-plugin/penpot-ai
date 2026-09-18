/**
 * Hover chrome drawn by the renderer.
 *
 * Asks WASM to trace a dashed stroke over one shape's own outline, on the UI
 * surface — above the design, but not part of it (no document change, no history
 * entry, nothing in the export). Because the renderer draws it from the real
 * shape it follows corner radii and rotation for free, which an SVG overlay
 * mirroring the shape's bounding box cannot.
 *
 * Only one highlight exists at a time; setting a new one replaces it.
 */

import type { WasmModule } from '../wasm-types'
import { hexToU32ARGB, uuidToU32Tuple } from '../types'
import { checkContext } from './context'
import { requestRender } from './rendering'

export function setShapeHighlight(
  module: WasmModule,
  id: string,
  color: string,
  opacity = 1,
): void {
  checkContext()
  const [a, b, c, d] = uuidToU32Tuple(id)
  module._set_shape_highlight(a, b, c, d, hexToU32ARGB(color, opacity))
  requestRender(module, 'set-shape-highlight')
}

export function clearShapeHighlight(module: WasmModule): void {
  checkContext()
  module._clear_shape_highlight()
  requestRender(module, 'clear-shape-highlight')
}
