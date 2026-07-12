/**
 * Renderer-specific types. Point re-exported from common; worker types from worker.
 */

import type { CSSProperties, ReactNode } from 'react'
import type { Matrix } from 'penpot-exporter/types'

export type { Point } from '@skia-rs-wasm/common/types'

/** Resize handle position (matches frontend handler keywords) */
export type ResizeHandlePosition =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'

/** Shape type values supported by the WASM renderer */
export type ShapeType =
  | 'rect'
  | 'path'
  | 'text'
  | 'frame'
  | 'group'
  | 'bool'
  | 'circle'
  | 'svg-raw'
  | 'image'
  /** Build-mode SPA router outlet; references view frames, owns no children. See common/slot-shape.ts. */
  | 'slot'

/** Boolean operation type (matches exporter BoolOperations string union) */
export type BoolType = 'union' | 'difference' | 'intersection' | 'exclude'

/**
 * Selection rectangle result from WASM
 */
export interface SelectionRectResult {
  width: number
  height: number
  center: { x: number; y: number }
  transform: Matrix
}

/** Path segment types for pathFromBytes deserialization (WASM path format). */
export type PathSegment =
  | { type: 'move-to'; x: number; y: number }
  | { type: 'line-to'; x: number; y: number }
  | { type: 'curve-to'; x: number; y: number; c1x: number; c1y: number; c2x: number; c2y: number }
  | { type: 'close-path' }

export interface PathContent {
  /** Canonical editable path model: ordered vertices with optional bézier handles
   * (absolute world coords). `segments` below is a derived sharp mirror kept in
   * sync by `pathContent()`; vertices are the source of truth for editing. */
  vertices?: Array<{
    point: { x: number; y: number }
    handleIn?: { x: number; y: number }
    handleOut?: { x: number; y: number }
  }>
  /** Whether the vertex ring closes. */
  closed?: boolean
  /** Compound paths (J1): multiple sub-paths in one node. When present this is the
   * canonical model; a single sub-path also mirrors into `vertices`/`closed`. */
  subpaths?: Array<{
    vertices: Array<{
      point: { x: number; y: number }
      handleIn?: { x: number; y: number }
      handleOut?: { x: number; y: number }
    }>
    closed: boolean
  }>
  segments?: PathSegment[]
  /** Vector network (N): the connectivity graph behind junctions — nodes shared by
   * multiple edges, so a line can branch off a closed shape's corner. When present
   * it's canonical for editing; `subpaths`/`segments` are its derived render mirror
   * (kept in sync by `networkContent()`). Legacy nodes have no network. */
  network?: {
    nodes: Array<{ x: number; y: number }>
    edges: Array<{
      a: number
      b: number
      ha?: { x: number; y: number }
      hb?: { x: number; y: number }
    }>
  }
  /** Single shape-wide corner radius (P4). The stored `segments` stay sharp; the
   * fillet is applied only when serializing to the renderer. */
  cornerRadius?: number
  [key: string]: unknown
}

/**
 * SVG content structure - can be a tree or a string (leaf node)
 */
export type SvgContent =
  | {
      tag: string
      attrs?: Record<string, unknown>
      content?: SvgContent[]
    }
  | string

export interface Viewport {
  x: number
  y: number
  width: number
  height: number
}

export interface RendererOptions {
  dpr?: number
  debug?: boolean
  /**
   * Render-wasm picture-in-picture cache debug overlay. When true, the
   * renderer draws a strip along the right edge of the canvas showing
   * the latest scope_F / anc_F / gather backdrop / per-tile cache /
   * Current snapshots captured during the frame. Useful for diagnosing
   * stale tile or backdrop cache contents. Maps to render-wasm flag
   * 0x10 in `set_render_options`.
   */
  debugPip?: boolean
  background?: string
}

export interface ViewportOptions {
  zoom?: number
  panX?: number
  panY?: number
  minZoom?: number
  maxZoom?: number
}

export interface ViewBox {
  x: number
  y: number
  width: number
  height: number
}

export interface PendingImageCallback {
  key: string
  thumbnail: boolean
  callback: () => Promise<boolean>
}

export interface SetObjectResult {
  thumbnails: PendingImageCallback[]
  full: PendingImageCallback[]
}

export type ResolveFontUrlCallback = (
  fontId: string,
  fontVariantId?: string,
  fontWeight?: number,
  fontStyle?: string
) => string

export interface FontInfo {
  fontId: string
  fontVariantId?: string
  fontWeight?: number
  fontStyle?: string
  isEmoji?: boolean
  isFallback?: boolean
}

export interface FontData {
  wasmId: string
  fontId: string
  fontVariantId: string
  style: number
  styleName: string
  weight: number
}

/**
 * Modifier key for triggering pan with left mouse button.
 * Use null to disable modifier-triggered pan.
 */
export type ViewportPanModifier = 'shift' | 'alt' | 'ctrl' | 'meta' | null

/**
 * Full viewport shortcuts config (KeyboardEvent.code strings and mouse options).
 * All fields are required in the resolved config; use Partial for overrides.
 */
export interface ShortcutsConfig {
  panLeft: string
  panRight: string
  panUp: string
  panDown: string
  panStep: number
  zoomInKeys: string[]
  zoomOutKeys: string[]
  zoomInFactor: number
  zoomOutFactor: number
  resetKeys: string[]
  panMouseButton: number
  panWithModifier: ViewportPanModifier
  /** Rebindable tool / path sub-tool shortcut keys (KeyboardEvent.code). */
  selectKey: string
  penKey: string
  rectKey: string
  frameKey: string
  textKey: string
  pathMoveKey: string
  pathAddKey: string
  pathBendKey: string
  /** 3D-scene gizmo sub-tool keys (active only while editing a 3D scene). */
  scene3dMoveKey: string
  scene3dRotateKey: string
  scene3dScaleKey: string
  /** Frame the focused object / reset the view (active only while editing a 3D scene). */
  scene3dFrameKey: string
  /** Recenter the 2D viewport on the edited scene (active only while editing a 3D scene). */
  scene3dRecenterKey: string
  /** Toggle focus (maximize) mode (active only while editing a 3D scene). */
  scene3dFocusKey: string
  /** Cycle to the next recent edit (active only while editing a 3D scene). */
  scene3dCycleKey: string
  wheelZoomEnabled: boolean
  wheelScalePerPixel: number
}

export interface CanvasWrapperProps {
  className?: string
  /** Style applied to the container div that wraps the canvas and overlay. */
  containerStyle?: CSSProperties
  /** Class name applied to the container div that wraps the canvas and overlay. */
  containerClassName?: string
  /** Optional content before the canvas column (e.g. left rail). Omitted = no outer flex wrapper. */
  startSlot?: ReactNode
  /** Optional content after the canvas column (e.g. right rail). */
  endSlot?: ReactNode
  /**
   * Sibling UI rendered inside the canvas XState provider (e.g. fixed toolbars/panels that call `useCanvasActor`).
   * The canvas column does not include this; use for overlays that sit outside the canvas subtree in layout.
   */
  overlays?: ReactNode
  /** Classes for the outer flex row when `startSlot` or `endSlot` is set. */
  workspaceClassName?: string
  rendererOptions?: RendererOptions
  onError?: (error: Error) => void
  /** Initial viewport shortcuts (merged with defaults). Applied on mount when provided. */
  shortcuts?: Partial<ShortcutsConfig>
  /** Optional path to render-wasm.js (e.g. when used in Figma plugin). Defaults to '/wasm/render-wasm.js'. */
  wasmPath?: string
  /** Optional URL to worker script (e.g. when used in Figma plugin). When not set, uses bundled worker. */
  workerScriptUrl?: string
}

export type InitializationState = 'idle' | 'loading' | 'ready' | 'error'

// Re-export conversions from common
export {
  ZERO_UUID,
  makeSelrect,
  uuidToU32,
  uuidToU32Tuple,
  hexToU32ARGB,
  colorToU32ARGB,
  u32ToUUID,
} from '@skia-rs-wasm/common/conversions'
