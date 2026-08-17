/**
 * Top-most, cursor-following chrome for an in-flight shader drag: the chip that
 * trails the pointer (the shader's thumbnail + name) and a small text label naming
 * the drop outcome ("Apply to <name>" over a shape, "+ New shape" on empty canvas).
 *
 * The heavy visual — the live, shape-clipped preview fill — is drawn by the real
 * renderer as a transient clone of the hovered shape (see `handlers/shader-preview-
 * node`), so it's canvas content UNDER the floating toolbar. This overlay is
 * deliberately tiny and stays on top: a chip and a label reading over the tools is
 * expected drag affordance, a full preview fill covering them was not. Reads the
 * `shaderDrag` signal; pointer-transparent.
 */

import { shaderDrag } from '../../renderer/signals/shader-drag'
import { useSignalCoalesced } from '../../renderer/signals/use-signal-coalesced'
import { ShaderThumbnail } from '../RightSidePanel/shader-thumbnails'

/** Selection blue, matching the world-layer outline + the canvas selection chrome. */
const ACCENT = '#378ADD'

export function ShaderDragOverlay() {
  const drag = useSignalCoalesced(shaderDrag)
  if (!drag) return null
  const { cursor, preset, target } = drag

  return (
    <div className="pointer-events-none fixed inset-0" style={{ zIndex: 9999 }}>
      {target?.kind === 'component' && (
        <div
          className="absolute whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-medium text-white shadow-sm"
          style={{ left: target.rect.left, top: target.rect.top - 22, background: ACCENT }}
        >
          Apply to {target.name}
        </div>
      )}

      {target?.kind === 'empty' && (
        <div
          className="absolute whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-medium text-white shadow-sm"
          style={{
            left: target.rect.left + target.rect.width / 2,
            top: target.rect.top + target.rect.height / 2 - 10,
            transform: 'translateX(-50%)',
            background: ACCENT,
          }}
        >
          + New shape
        </div>
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
