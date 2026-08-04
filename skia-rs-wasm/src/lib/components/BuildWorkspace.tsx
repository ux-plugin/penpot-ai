/**
 * Build-mode workspace — the surface shown when the editor is in Build mode.
 *
 *   left   — component tree (live) + chat, a resizable vertical split
 *   center — live React preview + generated code
 *
 * The rail width and the tree/chat split are both draggable (react-resizable-panels),
 * so the chat/agent can be given real room; sizes persist via autoSaveId. The inspector
 * is NOT here: the same floating rail (RightSidePanel) overlays both modes (rendered in
 * App), so this surface reserves the rail's right strip instead of docking its own panel.
 */

import { ComponentTree } from './BuildMode/ComponentTree'
import { PreviewStage } from './BuildMode/PreviewStage'
import { ChatPanel } from './BuildMode/ChatPanel'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'

// Right strip to clear for the floating inspector (RightSidePanel), which overlays both modes.
const RIGHT_RAIL = 'calc(0.75rem + var(--properties-panel-width, 280px) + 0.75rem)'

export function BuildWorkspace() {
  return (
    <div
      className="pointer-events-auto fixed inset-x-0 bottom-0 z-40"
      style={{ top: 'var(--top-bar-height)', background: 'var(--editor-canvas-chrome)' }}
    >
      <ResizablePanelGroup orientation="horizontal" className="h-full w-full p-3" style={{ paddingRight: RIGHT_RAIL }}>
        {/* Left rail: components (top) + chat/agent (bottom), each resizable. */}
        <ResizablePanel id="build-rail" minSize={14} defaultSize={26} className="min-h-0 min-w-0">
          <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-border/80 bg-white shadow-md">
            <ResizablePanelGroup orientation="vertical" className="h-full w-full">
              <ResizablePanel id="build-components" minSize={10} defaultSize={35} className="min-h-0 overflow-auto">
                <ComponentTree />
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel id="build-chat" minSize={20} defaultSize={65} className="min-h-0 overflow-hidden">
                <ChatPanel />
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle className="mx-1 bg-transparent" />

        {/* Center: live preview + generated code, on the backdrop. */}
        <ResizablePanel id="build-preview" minSize={40} defaultSize={74} className="relative min-h-0 min-w-0">
          <PreviewStage />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
