/**
 * Node Factory Utilities
 * Provides factory functions to create PenpotNode instances with proper defaults
 */

import type { ShapeType } from './types'
import type { PenpotNode, Selrect } from 'penpot-exporter/types'
import type { Fill, Stroke } from 'penpot-exporter/types'
import { newShapeId } from '../common/shape-id'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'

/**
 * Per-type counter for human-friendly auto names. Each shape created
 * by these factories gets a name like `Rect 1`, `Rect 2`, `Circle 1`,
 * `Frame 1`, … so the layers panel, right side panel, and dev
 * `/scheduler` timeline can refer to shapes by name instead of UUID.
 *
 * Counters are process-local: they don't survive page reload, but
 * within a session they're stable, which is exactly what we need for
 * debug tooling that shows "shape Rect 3 just re-rendered".
 */
const nextIndexByType: Record<string, number> = {}

/**
 * Produce the default name for a shape of the given type. Caller can
 * still pass an explicit `name` to the factory to override.
 */
function defaultName(type: string): string {
  const idx = (nextIndexByType[type] ?? 0) + 1
  nextIndexByType[type] = idx
  // Capitalise the type so labels read `Rect 1` not `rect 1`. `svg-raw`
  // → `Svg-raw 1` is acceptable; we don't generally create those by hand.
  const pretty = type.length > 0 ? type[0].toUpperCase() + type.slice(1) : type
  return `${pretty} ${idx}`
}

/**
 * Creates a selrect from position and size
 */
function createSelRect(x: number, y: number, width: number, height: number): Selrect {
  return {
    x,
    y,
    width,
    height,
    x1: x,
    y1: y,
    x2: x + width,
    y2: y + height,
  }
}

/** Corner points for a rect (used by worker selection/overlap). */
function rectPoints(x: number, y: number, width: number, height: number) {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ]
}

/**
 * Creates a rectangle node
 */
export function createRect(
  options: {
    id?: string
    name?: string
    x?: number
    y?: number
    width?: number
    height?: number
    parentId?: string
    fillColor?: string
    fillOpacity?: number
    strokeColor?: string
    strokeWidth?: number
    borderRadius?: number
    opacity?: number
  } = {}
): PenpotNode {
  const id = options.id || newShapeId()
  const x = options.x ?? 100
  const y = options.y ?? 100
  const width = options.width ?? 200
  const height = options.height ?? 150

  const fills: Fill[] = options.fillColor
    ? [
        {
          fillColor: options.fillColor,
          fillOpacity: options.fillOpacity ?? 1,
        },
      ]
    : []

  const strokes: Stroke[] = options.strokeColor
    ? [
        {
          strokeColor: options.strokeColor,
          strokeOpacity: 1,
          strokeWidth: options.strokeWidth ?? 2,
          strokeStyle: 'solid',
          strokeAlignment: 'center',
        },
      ]
    : []

  const node: PenpotNode = {
    id,
    type: 'rect',
    name: options.name ?? defaultName('rect'),
    x,
    y,
    width,
    height,
    parentId: options.parentId ?? ROOT_UUID,
    selrect: createSelRect(x, y, width, height),
    points: rectPoints(x, y, width, height),
    fills,
    strokes,
    opacity: options.opacity ?? 1,
  }

  if (options.borderRadius !== undefined) {
    node.r1 = options.borderRadius
    node.r2 = options.borderRadius
    node.r3 = options.borderRadius
    node.r4 = options.borderRadius
  }

  return node
}

/**
 * Creates a circle node
 */
export function createCircle(
  options: {
    id?: string
    name?: string
    x?: number
    y?: number
    radius?: number
    parentId?: string
    fillColor?: string
    fillOpacity?: number
    strokeColor?: string
    strokeWidth?: number
    opacity?: number
  } = {}
): PenpotNode {
  const id = options.id || newShapeId()
  const radius = options.radius ?? 50
  const x = options.x ?? 100
  const y = options.y ?? 100
  const width = radius * 2
  const height = radius * 2

  const fills: Fill[] = options.fillColor
    ? [
        {
          fillColor: options.fillColor,
          fillOpacity: options.fillOpacity ?? 1,
        },
      ]
    : []

  const strokes: Stroke[] = options.strokeColor
    ? [
        {
          strokeColor: options.strokeColor,
          strokeOpacity: 1,
          strokeWidth: options.strokeWidth ?? 2,
          strokeStyle: 'solid',
          strokeAlignment: 'center',
        },
      ]
    : []

  return {
    id,
    type: 'circle',
    name: options.name ?? defaultName('circle'),
    x,
    y,
    width,
    height,
    parentId: options.parentId ?? ROOT_UUID,
    selrect: createSelRect(x, y, width, height),
    fills,
    strokes,
    opacity: options.opacity ?? 1,
  }
}

/**
 * Creates a text node
 */
export function createText(
  options: {
    id?: string
    name?: string
    x?: number
    y?: number
    width?: number
    height?: number
    text?: string
    parentId?: string
    fillColor?: string
    opacity?: number
    /** Text box grow behaviour. Defaults to `fixed` (Penpot's default for a text
     * box you *draw*): the box keeps the size you gave it and is fully resizable.
     * `auto-width`/`auto-height` make the box content-driven (it resizes to fit the
     * text and can't be manually resized in that axis); `syncTextEditGeometry`
     * grows those while editing. */
    growType?: string
  } = {}
): PenpotNode {
  const id = options.id || newShapeId()
  const x = options.x ?? 100
  const y = options.y ?? 100
  const width = options.width ?? 200
  const height = options.height ?? 50
  const growType = options.growType ?? 'fixed'

  const fillColor = options.fillColor ?? '#000000'
  const spanFill: Fill = { fillColor, fillOpacity: 1 }

  return {
    id,
    type: 'text',
    name: options.name ?? defaultName('text'),
    x,
    y,
    width,
    height,
    parentId: options.parentId ?? ROOT_UUID,
    selrect: createSelRect(x, y, width, height),
    fills: [spanFill],
    growType,
    content: {
      type: 'root',
      verticalAlign: 'top',
      children: [
        {
          type: 'paragraph-set',
          children: [
            {
              type: 'paragraph',
              children: [
                {
                  type: 'text',
                  text: options.text || 'Hello World',
                  fills: [spanFill],
                },
              ],
            },
          ],
        },
      ],
    },
    opacity: options.opacity ?? 1,
  }
}

/**
 * Creates a frame node
 */
export function createFrame(
  options: {
    id?: string
    name?: string
    x?: number
    y?: number
    width?: number
    height?: number
    parentId?: string
    fillColor?: string
    fillOpacity?: number
    strokeColor?: string
    strokeWidth?: number
    shapes?: string[]
    opacity?: number
    showContent?: boolean
  } = {}
): PenpotNode {
  const id = options.id || newShapeId()
  const x = options.x ?? 0
  const y = options.y ?? 0
  const width = options.width ?? 400
  const height = options.height ?? 300

  const fills: Fill[] = options.fillColor
    ? [
        {
          fillColor: options.fillColor,
          fillOpacity: options.fillOpacity ?? 0.1,
        },
      ]
    : []

  const strokes: Stroke[] = options.strokeColor
    ? [
        {
          strokeColor: options.strokeColor,
          strokeOpacity: 1,
          strokeWidth: options.strokeWidth ?? 1,
          strokeStyle: 'solid',
          strokeAlignment: 'center',
        },
      ]
    : []

  return {
    id,
    type: 'frame',
    name: options.name ?? defaultName('frame'),
    x,
    y,
    width,
    height,
    parentId: options.parentId,
    shapes: options.shapes || [],
    selrect: createSelRect(x, y, width, height),
    fills,
    strokes,
    opacity: options.opacity ?? 1,
    // Default to non-clipping so the frame's own fill/shadows render — the
    // tile-scheduler's clipped-frame path clears them before stroke rendering.
    showContent: options.showContent ?? true,
  }
}

/**
 * Creates a group node
 */
export function createGroup(
  options: {
    id?: string
    name?: string
    x?: number
    y?: number
    width?: number
    height?: number
    parentId?: string
    shapes?: string[]
    opacity?: number
  } = {}
): PenpotNode {
  const id = options.id || newShapeId()
  const x = options.x ?? 0
  const y = options.y ?? 0
  const width = options.width ?? 200
  const height = options.height ?? 200

  return {
    id,
    type: 'group',
    name: options.name ?? defaultName('group'),
    x,
    y,
    width,
    height,
    parentId: options.parentId ?? ROOT_UUID,
    shapes: options.shapes || [],
    selrect: createSelRect(x, y, width, height),
    opacity: options.opacity ?? 1,
  }
}

/**
 * Creates a path node (simplified - just a basic path)
 */
export function createPath(
  options: {
    id?: string
    name?: string
    x?: number
    y?: number
    width?: number
    height?: number
    parentId?: string
    fillColor?: string
    fillOpacity?: number
    strokeColor?: string
    strokeWidth?: number
    opacity?: number
  } = {}
): PenpotNode {
  const id = options.id || newShapeId()
  const x = options.x ?? 100
  const y = options.y ?? 100
  const width = options.width ?? 200
  const height = options.height ?? 200

  const fills: Fill[] = options.fillColor
    ? [
        {
          fillColor: options.fillColor,
          fillOpacity: options.fillOpacity ?? 1,
        },
      ]
    : []

  const strokes: Stroke[] = options.strokeColor
    ? [
        {
          strokeColor: options.strokeColor,
          strokeOpacity: 1,
          strokeWidth: options.strokeWidth ?? 2,
          strokeStyle: 'solid',
          strokeAlignment: 'center',
        },
      ]
    : []

  // Simple path content - a basic rectangle path
  const pathContent = {
    segments: [
      { type: 'move-to', x: 0, y: 0 },
      { type: 'line-to', x: width, y: 0 },
      { type: 'line-to', x: width, y: height },
      { type: 'line-to', x: 0, y: height },
      { type: 'close-path' },
    ],
  }

  return {
    id,
    type: 'path',
    name: options.name ?? defaultName('path'),
    x,
    y,
    width,
    height,
    parentId: options.parentId ?? ROOT_UUID,
    selrect: createSelRect(x, y, width, height),
    fills,
    strokes,
    content: pathContent,
    opacity: options.opacity ?? 1,
  }
}

/**
 * Creates a boolean operation node
 */
export function createBool(
  options: {
    id?: string
    name?: string
    x?: number
    y?: number
    width?: number
    height?: number
    parentId?: string
    boolType?: 'union' | 'difference' | 'intersection' | 'exclude'
    shapes?: string[]
    opacity?: number
  } = {}
): PenpotNode {
  const id = options.id || newShapeId()
  const x = options.x ?? 0
  const y = options.y ?? 0
  const width = options.width ?? 200
  const height = options.height ?? 200

  return {
    id,
    type: 'bool',
    name: options.name ?? defaultName('bool'),
    x,
    y,
    width,
    height,
    parentId: options.parentId ?? ROOT_UUID,
    shapes: options.shapes || [],
    boolType: options.boolType ?? 'union',
    selrect: createSelRect(x, y, width, height),
    opacity: options.opacity ?? 1,
  }
}

/**
 * Creates an image node
 */
export function createImage(
  options: {
    id?: string
    name?: string
    x?: number
    y?: number
    width?: number
    height?: number
    parentId?: string
    imageId?: string
    opacity?: number
  } = {}
): PenpotNode {
  const id = options.id || newShapeId()
  const x = options.x ?? 100
  const y = options.y ?? 100
  const width = options.width ?? 200
  const height = options.height ?? 200

  const fills: Fill[] = options.imageId
    ? [
        {
          fillImage: {
            id: options.imageId,
            width,
            height,
          },
          fillOpacity: options.opacity ?? 1,
        },
      ]
    : []

  return {
    id,
    type: 'image',
    name: options.name ?? defaultName('image'),
    x,
    y,
    width,
    height,
    parentId: options.parentId ?? ROOT_UUID,
    selrect: createSelRect(x, y, width, height),
    fills,
    opacity: options.opacity ?? 1,
  }
}

/**
 * Creates an SVG raw node
 */
export function createSvgRaw(
  options: {
    id?: string
    name?: string
    x?: number
    y?: number
    width?: number
    height?: number
    parentId?: string
    svgContent?: string
    opacity?: number
  } = {}
): PenpotNode {
  const id = options.id || newShapeId()
  const x = options.x ?? 100
  const y = options.y ?? 100
  const width = options.width ?? 200
  const height = options.height ?? 200

  return {
    id,
    type: 'svg-raw',
    name: options.name ?? defaultName('svg-raw'),
    x,
    y,
    width,
    height,
    parentId: options.parentId ?? ROOT_UUID,
    selrect: createSelRect(x, y, width, height),
    content: options.svgContent || '<svg><rect width="100%" height="100%" fill="blue"/></svg>',
    opacity: options.opacity ?? 1,
  }
}

/**
 * Main factory function to create nodes by type
 */
export function createNode(
  type: ShapeType,
  options: {
    id?: string
    name?: string
    x?: number
    y?: number
    width?: number
    height?: number
    parentId?: string
    [key: string]: unknown
  } = {}
): PenpotNode {
  switch (type) {
    case 'rect':
      return createRect(options)
    case 'circle':
      return createCircle(options)
    case 'text':
      return createText(options)
    case 'frame':
      return createFrame(options)
    case 'group':
      return createGroup(options)
    case 'path':
      return createPath(options)
    case 'bool':
      return createBool(options)
    case 'image':
      return createImage(options)
    case 'svg-raw':
      return createSvgRaw(options)
    default:
      throw new Error(`Unknown node type: ${type}`)
  }
}

/**
 * Creates the root frame node (required by renderer)
 */
export function createRootFrame(width: number = 800, height: number = 600): PenpotNode {
  return createFrame({
    id: ROOT_UUID,
    x: 0,
    y: 0,
    width,
    height,
    shapes: [],
  })
}

