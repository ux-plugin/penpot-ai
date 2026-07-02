/**
 * Higher-level orchestration functions
 */

import type { WasmModule } from '../wasm-types'
import type { PendingImageCallback, SetObjectResult } from '../types'
import type { BoolType, ShapeType, PathContent } from '../types'
import type { PenpotNode, TextContent } from 'penpot-exporter/types'
import type { Noise } from '../properties/panel-utils'
import { checkContext } from './context'
import { requestRender } from './rendering'
import { renderFinish } from './viewport'
import {
  moduleUseShape,
  setParentId,
  setShapeType,
  setShapeClipContent,
  setShapeConstraints,
  setShapeRotation,
  setShapeTransform,
  setShapeBlendMode,
  setShapeOpacity,
  setShapeHidden,
  setShapeChildren,
  setShapeCorners,
  setShapeBlurs,
  setShapeTexture,
  setShapeBoolType,
  setShapeGrowType,
  setMasked,
  setShapeSelrect,
} from './shape'
import { setShapeFills } from './fills'
import { setShapeStrokes } from './strokes'
import { setShapeShadows } from './shadows'
import { setShapeNoise } from './noise'
import { setShapeGlass } from './glass'
import { setShapeMaterial, type Material } from './material'
import { setShapeSvgAttrs } from './svg'
import { setShapePathContent } from './path'
import {
  setFlexLayout,
  setGridLayout,
  setLayoutData,
  clearLayout,
} from './layout'
import {
  setShapeTextContent,
  setShapeTextImages,
  updateTextLayouts,
} from './text'

/**
 * Ensures text content is valid, falling back to default if needed
 */
function ensureTextContent(content: TextContent | null | undefined): TextContent {
  return content ?? {
    type: 'root',
    verticalAlign: 'top',
    children: []
  }
}

/**
 * Sets all properties of a shape object.
 *
 * `changedKeys`, when provided, restricts the per-property pushes to only
 * those whose backing field is in the set. The renderer-sync subscriber
 * passes the assign keys from each `mod-obj` so unrelated blocks (notably
 * the layout block) aren't re-installed on a transform-only edit. When
 * `changedKeys` is `undefined`, every setter fires (used for `add-obj`,
 * full re-pushes, and undo replay).
 *
 * The layout block (`clearLayout` + `setFlexLayout`/`setGridLayout` +
 * `setLayoutData`) fires only when at least one `layout`-prefixed key is in
 * `changedKeys`. Re-installing flex/grid config retriggers WASM's
 * render-time layout pass on the just-rotated container — the cause of the
 * rotated-flex-container snap-back.
 *
 * Returns pending image loading operations
 */
export function setObject(
  module: WasmModule,
  shape: PenpotNode,
  changedKeys?: ReadonlySet<string>,
  resolveImageUrl?: (imageId: string, thumbnail: boolean) => string
): SetObjectResult {
  checkContext()

  const id = shape.id
  const type = shape.type

  const wantsKey = (...keys: string[]): boolean => {
    if (!changedKeys) return true
    for (const k of keys) if (changedKeys.has(k)) return true
    return false
  }
  const wantsAnyLayoutKey = (): boolean => {
    if (!changedKeys) return true
    for (const k of changedKeys) if (k.startsWith('layout')) return true
    return false
  }

  // Always set the active shape id; setters below operate on it.
  moduleUseShape(module, id)

  if (wantsKey('parentId')) {
    setParentId(module, shape.parentId)
  }
  if (wantsKey('type')) {
    const wasmType: ShapeType = (type === 'instance' || type === 'component' ? 'frame' : type) as ShapeType
    setShapeType(module, wasmType)
  }
  if (wantsKey('showContent')) {
    setShapeClipContent(module, type === 'frame' ? !shape.showContent : false)
  }
  if (wantsKey('constraintsH', 'constraintsV')) {
    setShapeConstraints(module, shape.constraintsH, shape.constraintsV)
  }

  if (wantsKey('rotation')) {
    setShapeRotation(module, shape.rotation)
  }
  // `setShapeTransform` only reads `shape.transform`; the inverse is implied.
  // The canonical mod-obj geometry assign (applyTransformToNode) sends both
  // keys together, so checking just `transform` is enough.
  if (wantsKey('transform')) {
    setShapeTransform(module, shape.transform)
  }
  if (wantsKey('blendMode')) {
    setShapeBlendMode(module, shape.blendMode)
  }
  if (wantsKey('opacity')) {
    setShapeOpacity(module, shape.opacity)
  }
  if (wantsKey('hidden')) {
    setShapeHidden(module, shape.hidden ?? false)
  }
  if (wantsKey('shapes')) {
    const children = 'shapes' in shape ? (shape.shapes ?? []) : []
    setShapeChildren(module, children)
  }
  if (wantsKey('r1', 'r2', 'r3', 'r4')) {
    const corners: [number?, number?, number?, number?] = [shape.r1, shape.r2, shape.r3, shape.r4]
    setShapeCorners(module, corners)
  }
  if (wantsKey('blur', 'backgroundBlur')) {
    // A shape may carry both a layer blur and a background blur. The upstream
    // Penpot schema only exposes `shape.blur` (single slot, any kind); we
    // additionally read an optional `backgroundBlur` off the node so both can
    // be sent in one pass.
    const blurs: import('penpot-exporter/types').Blur[] = []
    if (shape.blur) blurs.push(shape.blur)
    const backgroundBlur = (shape as { backgroundBlur?: import('penpot-exporter/types').Blur })
      .backgroundBlur
    if (backgroundBlur) blurs.push(backgroundBlur)
    setShapeBlurs(module, blurs)
  }
  if (wantsKey('texture')) {
    const texture = (shape as Record<string, unknown>).texture as import('../properties/panel-utils').Texture | undefined
    setShapeTexture(module, texture)
  }
  if (wantsKey('glass')) {
    setShapeGlass(module, shape.glass)
  }

  // Type-specific properties
  if (type === 'group' && wantsKey('maskedGroup')) {
    setMasked(module, shape.maskedGroup ?? false)
  }
  if (type === 'bool' && wantsKey('boolType')) {
    const boolType = (shape as { boolType?: BoolType }).boolType
    if (boolType !== undefined) setShapeBoolType(module, boolType)
  }
  if ((type === 'path' || type === 'bool') && wantsKey('content')) {
    const content = (shape as { content?: unknown }).content
    if (content) setShapePathContent(module, content as PathContent)
  }
  if (wantsKey('svgAttrs')) {
    if (shape.svgAttrs) setShapeSvgAttrs(module, shape.svgAttrs)
  }

  if (wantsKey('shadow')) {
    setShapeShadows(module, shape.shadow || [])
  }
  if (wantsKey('noise')) {
    setShapeNoise(module, (shape as Record<string, unknown>).noise as Noise | null | undefined)
  }
  if (wantsKey('material')) {
    setShapeMaterial(module, (shape as Record<string, unknown>).material as Material | null | undefined)
  }
  if (type === 'text' && wantsKey('growType')) {
    setShapeGrowType(module, shape.growType)
  }

  // Layout block: only fires when the change touched a layout-* key. Skipping
  // this on transform-only commits is the snap-back fix — re-installing flex
  // config retriggers WASM's render-time layout pass on the just-rotated
  // container.
  if (wantsAnyLayoutKey()) {
    clearLayout(module)
    if ('layoutFlexDir' in shape && shape.layoutFlexDir) {
      setFlexLayout(module, shape)
    }
    if ('layoutGridDir' in shape && shape.layoutGridDir) {
      setGridLayout(module, shape)
    }
    setLayoutData(module, shape)
  }

  // Canonical geometry partials (applyTransformToNode / rectLayoutPartial) emit
  // selrect + points + x/y/width/height as a unit — checking the canonical pair
  // is sufficient. A mod-obj that sends, e.g., raw `x` without `selrect` would
  // already be inconsistent at the document level; we don't paper over that.
  if (wantsKey('selrect', 'points')) {
    setShapeSelrect(module, shape.selrect || { x1: 0, y1: 0, x2: 0, y2: 0, width: 0, height: 0, x: 0, y: 0 })
  }

  // Collect pending operations
  const pendingThumbnails: PendingImageCallback[] = []
  const pendingFull: PendingImageCallback[] = []

  // Text content and images — gated on `content` since that's the assign key
  // text edits carry; full text shape adds (no changedKeys) also fall through.
  if (type === 'text' && wantsKey('content')) {
    const textContent = ensureTextContent((shape as { content?: TextContent }).content)
    pendingThumbnails.push(...setShapeTextContent(module, id, textContent, resolveImageUrl))
    pendingThumbnails.push(...setShapeTextImages(module, id, textContent, true, resolveImageUrl))
    pendingFull.push(...setShapeTextImages(module, id, textContent, false, resolveImageUrl))
  }

  // Fills and strokes. Text colour lives on the content leaves (pushed via
  // setShapeTextContent above), not the shape-level `fills`. Pushing shape
  // fills for a text node would re-introduce a second, diverging colour source
  // that the renderer ignores anyway.
  if (wantsKey('fills') && type !== 'text') {
    const fills = shape.fills || []
    pendingThumbnails.push(...setShapeFills(module, id, fills, true, resolveImageUrl))
    pendingFull.push(...setShapeFills(module, id, fills, false, resolveImageUrl))
  }
  if (wantsKey('strokes')) {
    const strokes = type === 'group' ? [] : (shape.strokes || [])
    pendingThumbnails.push(...setShapeStrokes(module, id, strokes, true))
    pendingFull.push(...setShapeStrokes(module, id, strokes, false))
  }

  return {
    thumbnails: pendingThumbnails,
    full: pendingFull,
  }
}

/**
 * Processes pending image loading operations
 * Executes thumbnails first, then full images
 */
export async function processPending(
  module: WasmModule,
  shapes: PenpotNode[],
  thumbnails: PendingImageCallback[],
  full: PendingImageCallback[],
  onRender?: () => void,
  onComplete?: () => void
): Promise<void> {
  try {
    // Index by key to deduplicate
    const thumbnailMap = new Map<string, PendingImageCallback>()
    const fullMap = new Map<string, PendingImageCallback>()

    for (const callback of thumbnails) {
      thumbnailMap.set(callback.key, callback)
    }

    for (const callback of full) {
      fullMap.set(callback.key, callback)
    }

    // Process thumbnails first (in parallel)
    const thumbnailPromises = Array.from(thumbnailMap.values()).map(cb => cb.callback())
    await Promise.all(thumbnailPromises)

    // Process full images (in parallel)
    const fullPromises = Array.from(fullMap.values()).map(cb => cb.callback())
    await Promise.all(fullPromises)

    // Update text layouts
    updateTextLayouts(module, shapes)

    // Call render callback
    if (onRender) {
      onRender()
    } else {
      requestRender(module, 'pending-finished')
    }
  } catch (error) {
    console.error('Error processing pending operations:', error)
  } finally {
    if (onComplete) {
      onComplete()
    }
  }
}

/**
 * Convenience wrapper around setObject + processPending
 */
export async function processObject(
  module: WasmModule,
  shape: PenpotNode,
  changedKeys?: ReadonlySet<string>,
  resolveImageUrl?: (imageId: string, thumbnail: boolean) => string
): Promise<void> {
  const { thumbnails, full } = setObject(module, shape, changedKeys, resolveImageUrl)
  await processPending(module, [shape], thumbnails, full)
}

/**
 * Sets multiple objects and processes pending operations
 */
export async function setObjects(
  module: WasmModule,
  objects: Record<string, PenpotNode>,
  renderCallback?: () => void,
  resolveImageUrl?: (imageId: string, thumbnail: boolean) => string
): Promise<void> {
  checkContext()

  const shapes = Object.values(objects)
  const thumbnails: PendingImageCallback[] = []
  const full: PendingImageCallback[] = []

  // Set all objects and collect pending operations.
  // No `changedKeys` here — initial load is a full push of every property.
  for (const shape of shapes) {
    const result = setObject(module, shape, undefined, resolveImageUrl)
    thumbnails.push(...result.thumbnails)
    full.push(...result.full)
  }

  // Process pending operations
  await processPending(
    module,
    shapes,
    thumbnails,
    full,
    renderCallback || (() => {
      renderFinish(module, performance.now())
    }),
    () => {
      // Optional: dispatch event if needed
      // dispatchEvent(new CustomEvent('penpot:wasm:set-objects'))
    }
  )
}
