/**
 * Main Renderer class that wraps the WASM module
 * Provides a simple canvas-like API for rendering Penpot nodes
 */

import type { WasmModule } from './wasm-types'
import type { RendererOptions, SelectionRectResult } from './types'
import type { PenpotNode } from 'penpot-exporter/types'
import type { IndexedPage } from '../worker/types'
import type { Matrix, Fill } from 'penpot-exporter/types'
import { getDPR } from './utils'
import { Viewport } from './viewport'
import {
  initCanvasContext,
  setCanvasSize,
  setCanvasBackground,
  clearCanvas,
  clearCanvasPixels,
  getSelectionRect,
  setRenderOptions,
} from './api/canvas'
import { setViewBox, resizeViewbox, initializeViewport } from './api/viewport'
import { getContextInitialized } from './api/context'
import { processObject } from './api/orchestration'
import { requestRender, renderSync } from './api/rendering'
import { moduleUseShape, setShapeChildren } from './api/shape'
import {
  cleanModifiers as cleanModifiersApi,
  setWasmModifiers as setWasmModifiersApi,
  type SetWasmModifiersOptions,
} from './api/modifiers'
import { setShapeFillModifier, cleanFillModifiers as cleanFillModifiersApi } from './api/fill-modifiers'
import {
  setTemporaryModifiers,
  setTemporaryWasmModifiers,
  type GeometryModifier,
} from './store/modifier-overlay'

function defaultOptions(options?: RendererOptions): Required<RendererOptions> {
  return {
    dpr: options?.dpr ?? getDPR(),
    debug: options?.debug ?? false,
    debugPip: options?.debugPip ?? false,
    background: options?.background ?? '#FFFFFF',
  }
}

export class RendererBuilder {
  private canvasEl: HTMLCanvasElement | null = null
  private wasmModule: WasmModule | null = null
  private opts: RendererOptions = {}

  canvas(canvas: HTMLCanvasElement): this {
    this.canvasEl = canvas
    return this
  }

  module(module: WasmModule): this {
    this.wasmModule = module
    return this
  }

  options(options: RendererOptions): this {
    this.opts = options
    return this
  }

  build(): Renderer {
    if (!this.canvasEl || !this.wasmModule) {
      throw new Error('Renderer requires canvas and module. Use Renderer.builder().canvas(...).module(...).build()')
    }
    return Renderer.create(this.canvasEl, this.wasmModule, defaultOptions(this.opts))
  }
}

export class Renderer {
  private readonly module: WasmModule
  private readonly canvas: HTMLCanvasElement
  private readonly options: Required<RendererOptions>
  private viewport: Viewport | null = null
  private prevZoom: number = 1

  static builder(): RendererBuilder {
    return new RendererBuilder()
  }

  /** @internal Used by RendererBuilder. Prefer Renderer.builder().canvas().module().options().build() */
  static create(canvas: HTMLCanvasElement, module: WasmModule, options: Required<RendererOptions>): Renderer {
    return new Renderer(canvas, module, options)
  }

  private constructor(canvas: HTMLCanvasElement, module: WasmModule, options: Required<RendererOptions>) {
    this.canvas = canvas
    this.module = module
    this.options = options
  }

  /**
   * Destroys only the WebGL context. Module and canvas are unchanged.
   * @param releaseContext - If true, release the context so the browser frees GPU resources (final teardown).
   *   If false, allow the same canvas to get a new context (re-init, e.g. new document).
   */
  destroyContext(releaseContext?: boolean): void {
    if (!getContextInitialized()) {
      return
    }
    clearCanvas(this.module, this.canvas, releaseContext ?? false)
  }

  /**
   * Destroys the WebGL context and resets viewport state. Does not null module or canvas.
   */
  destroy(): void {
    this.destroyContext(true)
    this.viewport = null
    this.prevZoom = 1
  }

  /**
   * Toggle the render-wasm cache PiP debug overlay at runtime. Stores
   * the new value so a subsequent `initPage` (re-init) keeps the flag.
   * Calls `_set_render_options` directly so the change is live without
   * losing the WebGL context.
   *
   * Dev-only: in production builds `import.meta.env.DEV` is statically
   * `false` so the body is stripped by esbuild and the method becomes
   * a no-op. The wasm flag bit 0x10 only does anything when the wasm
   * itself was compiled with the `debug-pip` cargo feature.
   */
  setDebugPip(on: boolean): void {
    if (!import.meta.env.DEV) return
    this.options.debugPip = on
    setRenderOptions(this.module, {
      debug: this.options.debug,
      debugPip: on,
      dpr: this.options.dpr,
    })
    // Force a render so the new flag is applied immediately.
    requestRender(this.module, 'set-debug-pip')
  }

  /**
   * Initializes or re-initializes the context and loads the given page (first load or page change).
   */
  async initPage(indexedPage: IndexedPage): Promise<void> {
    if (!this.module || !this.canvas) {
      throw new Error('Renderer not built. Use Renderer.builder() first.')
    }

    this.destroyContext()

    const success = initCanvasContext(
      this.module,
      this.canvas,
      this.options.dpr,
      this.options.debug,
      this.options.debugPip
    )
    if (!success) {
      throw new Error('Failed to initialize WebGL context')
    }

    const canvasWidth = this.canvas.clientWidth || this.canvas.width
    const canvasHeight = this.canvas.clientHeight || this.canvas.height
    resizeViewbox(this.module, canvasWidth, canvasHeight)

    const background = indexedPage.background ?? this.options.background ?? '#FFFFFF'
    setCanvasBackground(this.module, background)

    const baseObjects = indexedPage.objects
    await initializeViewport(
      this.module,
      baseObjects,
      1,
      { x: 0, y: 0 },
      background
    )
  }

  /**
   * Sets the viewport/viewbox
   */
  setViewport(zoom: number, x: number, y: number): void {
    if (!getContextInitialized() || !this.module) {
      throw new Error('Renderer context not initialized. Call initPage() first.')
    }
    setViewBox(this.module, this.prevZoom, zoom, { x, y })
    this.prevZoom = zoom
  }

  /**
   * Sets the viewport using a Viewport instance.
   * Matches frontend: vbox is world-space visible top-left; frontend calls _set_view(zoom, -vbox.x, -vbox.y).
   */
  applyViewport(viewport: Viewport): void {
    if (!getContextInitialized() || !this.module) {
      throw new Error('Renderer context not initialized. Call initPage() first.')
    }
    this.viewport = viewport
    setViewBox(this.module, this.prevZoom, viewport.zoom, { x: viewport.panX, y: viewport.panY })
    this.prevZoom = viewport.zoom
  }

  getViewport(): Viewport | null {
    return this.viewport
  }

  resize(width: number, height: number): void {
    if (!getContextInitialized() || !this.module || !this.canvas) {
      throw new Error('Renderer context not initialized. Call initPage() first.')
    }
    setCanvasSize(this.module, this.canvas, this.options.dpr)
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
    resizeViewbox(this.module, width, height)
  }

  clear(): void {
    if (!getContextInitialized()) {
      console.warn('Renderer context not initialized. Call initPage() first.')
      return
    }
    if (!this.module || !this.canvas) return
    clearCanvasPixels(this.module, this.canvas)
    if (this.module._reset_canvas) {
      this.module._reset_canvas()
    }
  }

  setBackground(color: number | string): void {
    if (!getContextInitialized() || !this.module) {
      throw new Error('Renderer context not initialized. Call initPage() first.')
    }
    const hexColor =
      typeof color === 'number'
        ? `#${(color >>> 0).toString(16).padStart(8, '0').slice(2)}`
        : color
    setCanvasBackground(this.module, hexColor)
  }

  /**
   * Updates a single shape in place (attribute change). No teardown.
   *
   * `changedKeys` (optional): when provided, restricts the per-property push
   * to only the primitives whose backing field is in the set. The
   * renderer-sync subscriber passes the assign keys from each `mod-obj` so
   * unrelated blocks (notably the layout block) aren't re-installed on a
   * transform-only edit.
   */
  async updateShape(shape: PenpotNode, changedKeys?: ReadonlySet<string>): Promise<void> {
    if (!getContextInitialized() || !this.module) {
      throw new Error('Renderer context not initialized. Call initPage() first.')
    }
    await processObject(this.module, shape, changedKeys)
    requestRender(this.module, 'updateShape')
  }

  /**
   * Adds a new shape to the pool. WASM use_shape adds it if it doesn't exist. No init_shapes_pool.
   */
  async addShape(shape: PenpotNode): Promise<void> {
    if (!getContextInitialized() || !this.module) {
      throw new Error('Renderer context not initialized. Call initPage() first.')
    }
    await processObject(this.module, shape)
    requestRender(this.module, 'addShape')
  }

  /**
   * Updates the parent's children list (add/delete). For delete, pass the new list without the removed id;
   * WASM set_children will call delete_shape_children for removed ids.
   */
  updateParentChildren(parentId: string, childIds: string[]): void {
    if (!getContextInitialized() || !this.module) {
      throw new Error('Renderer context not initialized. Call initPage() first.')
    }
    moduleUseShape(this.module, parentId)
    setShapeChildren(this.module, childIds)
    requestRender(this.module, 'updateParentChildren')
  }


  /**
   * Unified gesture-time modifier set: clean + setStructureModifiers + propagate('child') +
   * setModifiers + mirror inputs/result into the JS-side `modifierOverlay` store.
   *
   * Mirrors CLJS `set-wasm-modifiers`. Replaces the move/rotate/resize handlers'
   * `cleanModifiers → setStructureModifiers → setMoveModifiersNoRender` boilerplate
   * with one call. Does NOT request a render — caller decides timing (throttled
   * RAF for gestures, immediate for one-shot updates).
   *
   * Returns the propagated transforms so the caller can use them for overlay rect
   * computation without an additional `querySelectionRect` round-trip.
   */
  setWasmModifiers(
    entries: ReadonlyArray<readonly [string, Matrix]>,
    options?: SetWasmModifiersOptions,
  ): { propagated: Array<{ id: string; transform: Matrix }> } {
    if (!getContextInitialized() || !this.module) return { propagated: [] }
    if (entries.length === 0) {
      // Empty input still clears any previous overlay.
      cleanModifiersApi(this.module)
      setTemporaryModifiers([])
      setTemporaryWasmModifiers([])
      return { propagated: [] }
    }
    const result = setWasmModifiersApi(this.module, entries, options)
    // Mirror to JS-side overlay store. Inputs become `workspaceModifiers`
    // entries (intent); the propagated map is `workspaceWasmModifiers`
    // (consequence). Both are cleared by `clearModifierOverlay()` at commit
    // completion (handlers/utils.ts:applyModifiersAndCommit).
    const intentEntries: Array<[string, GeometryModifier]> = entries.map(([id, matrix]) => [
      id,
      options?.structureModifiers && options.structureModifiers.length > 0
        ? { matrix, structure: options.structureModifiers as GeometryModifier['structure'] }
        : { matrix },
    ])
    setTemporaryModifiers(intentEntries)
    setTemporaryWasmModifiers(result.propagated.map((p) => [p.id, p.transform] as const))
    return result
  }

  /**
   * Clear modifiers (e.g. after move ends). Safe to call even if none were set.
   */
  cleanModifiers(): void {
    if (!getContextInitialized() || !this.module) return
    cleanModifiersApi(this.module)
  }

  /**
   * Set fill override for one shape without scheduling a render. Use during gradient drag
   * combined with requestRenderFrame() for throttled ~60 Hz updates.
   */
  setFillModifierNoRender(shapeId: string, fills: Fill[]): void {
    if (!getContextInitialized() || !this.module) return
    setShapeFillModifier(this.module, shapeId, fills, true)
  }

  /**
   * Set fill override for one shape and immediately schedule a render.
   */
  setFillModifierAndRender(shapeId: string, fills: Fill[]): void {
    if (!getContextInitialized() || !this.module) return
    setShapeFillModifier(this.module, shapeId, fills, false)
  }

  /**
   * Remove all fill overrides and invalidate the modified-shape cache for affected shapes.
   * Call after gradient drag ends (before committing to document).
   */
  cleanFillModifiers(): void {
    if (!getContextInitialized() || !this.module) return
    cleanFillModifiersApi(this.module)
  }

  /**
   * Run a synchronous WASM render so geometry/selection queries match committed shape data.
   * Call after shape updates and/or {@link cleanModifiers} before {@link getSelectionRect} — `updateShape` only schedules RAF by default.
   */
  flushRenderSync(): void {
    if (!getContextInitialized() || !this.module) return
    renderSync(this.module)
  }

  /**
   * Get the selection rectangle (bounds) for the given shape IDs from WASM.
   * When modifiers are set, returns the bounds of the modified shapes. Returns null if context is not initialized or entries are empty.
   */
  getSelectionRect(shapeIds: string[]): SelectionRectResult | null {
    if (!getContextInitialized() || !this.module) return null
    return getSelectionRect(this.module, shapeIds)
  }

  /**
   * Request a render on the next animation frame. Use after cleanModifiers() so the
   * next frame is drawn with committed shape state (e.g. rotation) and no modifiers.
   */
  requestRenderFrame(): void {
    if (!getContextInitialized() || !this.module) return
    requestRender(this.module, 'requestRenderFrame')
  }

  getModule(): WasmModule {
    return this.module
  }

  isInitialized(): boolean {
    return getContextInitialized()
  }
}
