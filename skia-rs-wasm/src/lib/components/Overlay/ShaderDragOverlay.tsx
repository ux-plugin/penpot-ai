/**
 * Renders the in-flight shader drag: a cursor-following chip (the shader's
 * thumbnail + name), the resolved target component filled with a semi-transparent
 * LIVE preview of the shader (rendered by the shared surface — free because the
 * thumbnail loop pauses during a drag) under an accent outline + name label, and
 * a dashed ghost where a drop on empty canvas would create a new shape. Reads the
 * `shaderDrag` signal; positions everything in client coordinates. Pointer-
 * transparent — it never intercepts the drag it's drawing.
 */

import { useEffect, useRef } from 'react'
import { shaderDrag } from '../../renderer/signals/shader-drag'
import { useSignalCoalesced } from '../../renderer/signals/use-signal-coalesced'
import { getWasmModule } from '../../renderer/wasm-module'
import {
  attachPreview,
  blitPreviewTo,
  detachPreview,
  drawPreview,
  isPreviewSupported,
} from '../../renderer/focus-preview'
import { ShaderThumbnail } from '../RightSidePanel/shader-thumbnails'
import type { Material } from '../../renderer/api/material'

/** Selection blue, matching the existing canvas selection/drop indicators. */
const ACCENT = '#378ADD'
/** Cap the preview's rasterised size — a big shape needn't render at full res. */
const MAX_PREVIEW_CSS = 640

let previewHost: HTMLDivElement | null = null
function ensurePreviewHost(w: number, h: number): HTMLDivElement {
  if (!previewHost) {
    previewHost = document.createElement('div')
    previewHost.style.cssText = 'position:fixed;left:-9999px;top:0;pointer-events:none'
    document.body.appendChild(previewHost)
  }
  previewHost.style.width = `${w}px`
  previewHost.style.height = `${h}px`
  return previewHost
}

/** Draw `material` into `canvas` at the target's aspect via the shared surface. */
function renderPreviewInto(canvas: HTMLCanvasElement, material: Material, cssW: number, cssH: number): void {
  const module = getWasmModule()
  if (!module || !isPreviewSupported(module)) return
  const scale = Math.min(1, MAX_PREVIEW_CSS / Math.max(cssW, cssH))
  const w = Math.max(1, Math.round(cssW * scale))
  const h = Math.max(1, Math.round(cssH * scale))
  const host = ensurePreviewHost(w, h)
  if (!attachPreview(module, host, w, h)) return
  drawPreview(module, material, 0, 0.25)
  const ctx = canvas.getContext('2d')
  if (ctx) {
    canvas.width = w
    canvas.height = h
    blitPreviewTo(ctx)
  }
  detachPreview(module)
}

export function ShaderDragOverlay() {
  const drag = useSignalCoalesced(shaderDrag)
  const previewRef = useRef<HTMLCanvasElement>(null)

  const target = drag?.target
  const isComponent = target?.kind === 'component'
  const nodeId = isComponent ? target.nodeId : null
  const rectW = isComponent ? Math.round(target.rect.width) : 0
  const rectH = isComponent ? Math.round(target.rect.height) : 0
  const presetId = drag?.preset.id
  const material = drag?.preset.material

  // Re-render the preview only when the target shape (or its size) changes — not
  // on every cursor move within the same shape.
  useEffect(() => {
    const canvas = previewRef.current
    if (!canvas || !isComponent || !material || rectW < 1 || rectH < 1) return
    renderPreviewInto(canvas, material, rectW, rectH)
  }, [isComponent, nodeId, rectW, rectH, presetId, material])

  if (!drag) return null
  const { cursor, preset } = drag

  return (
    <div className="pointer-events-none fixed inset-0" style={{ zIndex: 9999 }}>
      {target?.kind === 'component' && (
        <>
          <canvas
            ref={previewRef}
            className="absolute rounded-md"
            style={{
              left: target.rect.left,
              top: target.rect.top,
              width: target.rect.width,
              height: target.rect.height,
              opacity: 0.6,
            }}
          />
          <div
            className="absolute box-border rounded-md"
            style={{
              left: target.rect.left,
              top: target.rect.top,
              width: target.rect.width,
              height: target.rect.height,
              border: `2px solid ${ACCENT}`,
            }}
          />
          <div
            className="absolute whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-medium text-white"
            style={{ left: target.rect.left, top: target.rect.top - 22, background: ACCENT }}
          >
            Apply to {target.name}
          </div>
        </>
      )}

      {target?.kind === 'empty' && (
        <>
          <div
            className="absolute box-border rounded-md"
            style={{
              left: target.rect.left,
              top: target.rect.top,
              width: target.rect.width,
              height: target.rect.height,
              border: `2px dashed ${ACCENT}`,
              background: `${ACCENT}0f`,
            }}
          />
          <div
            className="absolute whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-medium text-white"
            style={{
              left: target.rect.left + target.rect.width / 2,
              top: target.rect.top + target.rect.height / 2 - 10,
              transform: 'translateX(-50%)',
              background: ACCENT,
            }}
          >
            + New shape
          </div>
        </>
      )}

      {/* Cursor chip — offset down-right so it doesn't sit under the pointer. */}
      <div
        className="absolute flex items-center gap-2 rounded-lg border border-border bg-background py-1 pl-1 pr-2.5 shadow-lg"
        style={{ left: cursor.x + 14, top: cursor.y + 14 }}
      >
        <div className="h-[22px] w-8 overflow-hidden rounded">
          <ShaderThumbnail entry={preset} />
        </div>
        <span className="text-[12px] font-medium text-foreground">{preset.name}</span>
      </div>
    </div>
  )
}
