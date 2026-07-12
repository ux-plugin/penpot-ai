/**
 * Stroke operations
 */

import type { WasmModule } from '../wasm-types'
import type { ImageColor } from 'penpot-exporter/types'
import type { PendingImageCallback } from '../types'
import type { StrokeWithSettings } from '../stroke-settings'
import { normalizeDashes } from '../stroke-settings'
import { uuidToU32Tuple } from '../types'
import { allocBytes, freeBytes } from '../utils'
import {
  translateStrokeStyle,
  translateStrokeCap,
  translateStrokeLinecap,
  translateStrokeLinejoin,
} from './serializers'
import { checkContext } from './context'
import { FILL_U8_SIZE } from './constants'
import {
  writeSolidFill,
  writeLinearGradientFill,
  writeRadialGradientFill,
  writeAngularGradientFill,
  writeDiamondGradientFill,
  writeImageFill,
  fetchImage,
} from './fills'

/**
 * Set shape strokes
 */
export function setShapeStrokes(
  module: WasmModule,
  shapeId: string,
  strokes: StrokeWithSettings[],
  thumbnail: boolean = false,
  resolveImageUrl?: (imageId: string, thumbnail: boolean) => string
): PendingImageCallback[] {
  checkContext()
  const pending: PendingImageCallback[] = []

  module._clear_shape_strokes()

  for (const stroke of strokes) {
    const opacity = stroke.strokeOpacity ?? 1.0
    const color = stroke.strokeColor
    const gradient = stroke.strokeColorGradient
    const image = stroke.strokeImage
    const width = stroke.strokeWidth ?? 0
    const align = stroke.strokeAlignment ?? 'center'
    const style = translateStrokeStyle(stroke.strokeStyle)
    const capStart = translateStrokeCap(stroke.strokeCapStart)
    const capEnd = translateStrokeCap(stroke.strokeCapEnd)

    // Add stroke based on alignment
    switch (align) {
      case 'inner':
        module._add_shape_inner_stroke(width, style, capStart, capEnd)
        break
      case 'outer':
        module._add_shape_outer_stroke(width, style, capStart, capEnd)
        break
      default:
        module._add_shape_center_stroke(width, style, capStart, capEnd)
    }

    // Basic stroke settings: join / dash-cap / miter (−1 / negative = unset),
    // applied to the stroke just added above.
    const join = stroke.strokeJoin !== undefined ? translateStrokeLinejoin(stroke.strokeJoin) : -1
    const dashCap =
      stroke.strokeDashCap !== undefined ? translateStrokeLinecap(stroke.strokeDashCap) : -1
    const miter = stroke.strokeMiterLimit ?? -1
    if (join !== -1 || dashCap !== -1 || miter >= 0) {
      module._set_shape_stroke_props(join, dashCap, miter)
    }

    // Dynamic (procedural wiggle) perturbation.
    const dyn = stroke.strokeDynamic
    if (dyn && dyn.wiggle > 0) {
      module._set_shape_stroke_dynamic(dyn.frequency, dyn.wiggle, dyn.smoothen)
    }

    // Custom dash pattern (variable-length f32 buffer, same shared-mem
    // convention as stroke fills).
    const dashes = stroke.strokeDashes ? normalizeDashes(stroke.strokeDashes) : []
    if (dashes.length > 0) {
      const dashOffset = allocBytes(module, dashes.length * 4)
      const dashView = new DataView(module.HEAPU8.buffer, module.HEAPU8.byteOffset)
      for (let i = 0; i < dashes.length; i++) {
        dashView.setFloat32(dashOffset + i * 4, dashes[i], true)
      }
      module._set_shape_stroke_dashes()
      freeBytes(module)
    }

    // Write fill data
    const fillOffset = allocBytes(module, FILL_U8_SIZE)
    const dataView = new DataView(module.HEAPU8.buffer, module.HEAPU8.byteOffset)

    if (gradient) {
      if (gradient.type === 'linear') {
        writeLinearGradientFill(fillOffset, dataView, gradient, opacity)
      } else if (gradient.type === 'radial') {
        writeRadialGradientFill(fillOffset, dataView, gradient, opacity)
      } else if (gradient.type === 'angular') {
        writeAngularGradientFill(fillOffset, dataView, gradient, opacity)
      } else if (gradient.type === 'diamond') {
        writeDiamondGradientFill(fillOffset, dataView, gradient, opacity)
      }
      module._add_shape_stroke_fill()
    } else if (image) {
      if ('width' in image && 'height' in image) {
        writeImageFill(fillOffset, dataView, image as ImageColor, opacity)
        module._add_shape_stroke_fill()
      }

      if ('id' in image && image.id) {
        const imageId = image.id
        const [a, b, c, d] = uuidToU32Tuple(imageId)
        const cached = module._is_image_cached(a, b, c, d, thumbnail)
        if (cached === 0) {
          pending.push(fetchImage(module, shapeId, imageId, thumbnail, resolveImageUrl))
        }
      }
    } else if (color) {
      writeSolidFill(fillOffset, dataView, color, opacity)
      module._add_shape_stroke_fill()
    }

    freeBytes(module)
  }

  return pending
}

