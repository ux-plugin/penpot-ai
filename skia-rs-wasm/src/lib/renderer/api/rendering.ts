/**
 * Core rendering functions
 */

import type { WasmModule } from '../wasm-types'
import { uuidToU32Tuple } from '../types'
import { checkContext, getContextInitialized, getContextLost, getPendingRender, setPendingRender } from './context'
import { textEditorActive } from '../signals/text-editor'
import { textEditorUpdateBlink, textEditorRenderOverlay, textEditorPollEvent } from './text-editor'

/**
 * Renders with timestamp.
 *
 * When a text shape is being edited, the caret/selection overlay is drawn on
 * top after the main render, the blink state is advanced, and any editor event
 * (poll != 0) schedules a follow-up frame. Gated on `textEditorActive` so the
 * non-editing hot path is a single signal read.
 */
export function render(module: WasmModule, timestamp: number): void {
  checkContext()
  module._render(timestamp)
  if (textEditorActive.value) {
    textEditorUpdateBlink(module, timestamp)
    textEditorRenderOverlay(module)
    if (textEditorPollEvent(module) !== 0) {
      requestRender(module, 'text-editor-event')
    }
  }
}

/**
 * Synchronous render
 */
export function renderSync(module: WasmModule): void {
  checkContext()
  module._render_sync()
}

/**
 * Render specific shape synchronously
 */
export function renderSyncShape(module: WasmModule, id: string): void {
  checkContext()
  const [a, b, c, d] = uuidToU32Tuple(id)
  module._render_sync_shape(a, b, c, d)
}

/**
 * Request async render via requestAnimationFrame
 */
export function requestRender(module: WasmModule, _requester: string): void {
  if (!getContextInitialized() || getContextLost()) {
    return
  }
  if (getPendingRender()) {
    return
  }

  setPendingRender(true)
  requestAnimationFrame((ts) => {
    setPendingRender(false)
    render(module, ts)
  })
}
