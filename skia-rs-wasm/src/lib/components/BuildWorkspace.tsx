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

export function BuildWorkspace() {
  return (
    <div
      className="pointer-events-auto fixed inset-y-0 right-0 z-40 flex bg-background"
      style={{
        left: 'var(--activity-bar-width, 3rem)',
        // Fill the full width (white sits BEHIND the floating rail, no chrome
        // leaking through) and just pad content off the rail's strip.
        paddingRight: 'calc(0.75rem + var(--properties-panel-width, 280px) + 0.75rem)',
      }}
    >
      {/* Left column: components (live) + chat */}
      <div className="flex w-64 shrink-0 flex-col border-r border-border bg-white">
        <div className="min-h-0 flex-1">
          <ComponentTree />
        </div>
        <div className="min-h-0 flex-1">
          <ChatPanel />
        </div>
      </div>

      {/* Center: live preview + code */}
      <PreviewStage />
    </div>
  )
}
