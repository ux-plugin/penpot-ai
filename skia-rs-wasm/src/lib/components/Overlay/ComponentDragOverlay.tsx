/**
 * Cursor-following chrome for an in-flight component drag: a ghost outline where
 * the copy will land, plus a chip trailing the pointer with the component's
 * thumbnail and name.
 *
 * Unlike the shader drag, nothing here is drawn by the renderer — an outline is
 * all the feedback a placement needs, so the gesture stays pure DOM. Reads the
 * `componentDrag` signal; pointer-transparent.
 */

import { componentDrag } from '../../renderer/signals/component-drag'
import { useSignalCoalesced } from '../../renderer/signals/use-signal-coalesced'
import { ComponentThumbnail } from '../AssetsPanel/ComponentThumbnail'

/** Selection blue, matching the world-layer outline + the canvas selection chrome. */
const ACCENT = '#378ADD'

export function ComponentDragOverlay() {
  const drag = useSignalCoalesced(componentDrag)
  if (!drag) return null
  const { cursor, component, ghost } = drag

  return (
    <div className="pointer-events-none fixed inset-0" style={{ zIndex: 9999 }}>
      {ghost && (
        <div
          className="absolute rounded-sm"
          style={{
            left: ghost.left,
            top: ghost.top,
            width: ghost.width,
            height: ghost.height,
            border: `1px solid ${ACCENT}`,
            background: `${ACCENT}14`,
          }}
        />
      )}

      <div
        className="absolute flex items-center gap-1.5 rounded-md bg-white/95 px-1.5 py-1 text-[11px] font-medium shadow-sm ring-1 ring-black/10"
        style={{ left: cursor.x + 12, top: cursor.y + 12 }}
      >
        <ComponentThumbnail component={component} className="size-4 shrink-0" />
        <span className="max-w-[140px] truncate">{component.name}</span>
      </div>
    </div>
  )
}
