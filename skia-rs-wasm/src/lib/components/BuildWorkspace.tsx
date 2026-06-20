/**
 * Build-mode workspace — the surface shown when the editor is in Build mode.
 *
 * Lays out the three-column shell from the approved mockup:
 *   left   — component tree (M2, live) + chat (M5 placeholder)
 *   center — live React preview + generated code (M3 placeholder)
 *   right  — inspector: Parameters / Interactions / Code tabs (M4 placeholder)
 */

import { ComponentTree } from './BuildMode/ComponentTree'
import { PreviewStage } from './BuildMode/PreviewStage'
import { BuildInspector } from './BuildMode/BuildInspector'
import { ChatPanel } from './BuildMode/ChatPanel'

export function BuildWorkspace() {
  return (
    <div
      className="pointer-events-auto fixed inset-y-0 right-0 z-40 flex bg-background"
      style={{ left: 'var(--activity-bar-width, 3rem)' }}
    >
      {/* Left column: components (live) + chat (placeholder) */}
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

      {/* Right column: shared tabbed inspector */}
      <BuildInspector />
    </div>
  )
}
