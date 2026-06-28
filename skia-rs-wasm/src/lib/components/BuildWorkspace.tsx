/**
 * Build-mode workspace — the surface shown when the editor is in Build mode.
 *
 *   left   — component tree (live) + chat
 *   center — live React preview + generated code
 *
 * The inspector is NOT here: the same floating rail (RightSidePanel) overlays
 * both modes (rendered in App), so this surface reserves the rail's right strip
 * instead of docking its own panel.
 */

import { ComponentTree } from './BuildMode/ComponentTree'
import { PreviewStage } from './BuildMode/PreviewStage'
import { ChatPanel } from './BuildMode/ChatPanel'

// Floating-rail strips to clear on each side (gap + rail width + gap), matching
// the Design rails so the backdrop reads consistently across both modes.
const LEFT_RAIL = 'calc(0.75rem + 16rem + 0.75rem)'
const RIGHT_RAIL = 'calc(0.75rem + var(--properties-panel-width, 280px) + 0.75rem)'

export function BuildWorkspace() {
  return (
    <div
      className="pointer-events-auto fixed inset-x-0 bottom-0 z-40"
      style={{ top: 'var(--top-bar-height)', background: 'var(--editor-canvas-chrome)' }}
    >
      {/* Center: live preview + code, on the backdrop, clearing both floating rails */}
      <div className="absolute inset-0 flex" style={{ paddingLeft: LEFT_RAIL, paddingRight: RIGHT_RAIL }}>
        <PreviewStage />
      </div>

      {/* Left floating rail: components (live) + chat */}
      <aside className="pointer-events-auto absolute top-3 bottom-3 left-3 flex w-64 flex-col overflow-hidden rounded-2xl border border-border/80 bg-white shadow-md">
        <div className="min-h-0 flex-1 overflow-auto">
          <ComponentTree />
        </div>
        <div className="min-h-0 flex-1 overflow-auto border-t border-border">
          <ChatPanel />
        </div>
      </aside>
    </div>
  )
}
