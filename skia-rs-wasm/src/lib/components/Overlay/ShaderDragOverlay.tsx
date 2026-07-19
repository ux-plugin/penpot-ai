/**
 * Renders the in-flight shader drag: a cursor-following chip (the shader's live
 * thumbnail + name), an accent outline + name label on the resolved target
 * component, and a dashed ghost where a drop on empty canvas would create a new
 * shape. Reads the `shaderDrag` signal; positions everything in client
 * coordinates (the overlay sits at the viewport origin). Pointer-transparent —
 * it never intercepts the drag it's drawing.
 */

import { shaderDrag } from '../../renderer/signals/shader-drag'
import { useSignalCoalesced } from '../../renderer/signals/use-signal-coalesced'
import { ShaderThumbnail } from '../RightSidePanel/shader-thumbnails'

/** Selection blue, matching the existing canvas selection/drop indicators. */
const ACCENT = '#378ADD'

export function ShaderDragOverlay() {
  const drag = useSignalCoalesced(shaderDrag)
  if (!drag) return null
  const { cursor, target, preset } = drag

  return (
    <div className="pointer-events-none fixed inset-0" style={{ zIndex: 9999 }}>
      {target?.kind === 'component' && (
        <>
          <div
            className="absolute box-border rounded-md"
            style={{
              left: target.rect.left,
              top: target.rect.top,
              width: target.rect.width,
              height: target.rect.height,
              border: `2px solid ${ACCENT}`,
              background: `${ACCENT}14`,
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
