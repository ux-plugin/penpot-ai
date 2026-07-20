/**
 * Slot outlet properties — view management for a Build-mode router outlet.
 *
 * Renders only when the selected node is a slot. Lists the slot's candidate view
 * frames (radio picks the design-time active view; ✕ removes a candidate), offers
 * "+ Add view" (creates a pre-sized view frame and makes it active), and a
 * "Clip content" toggle. All mutations funnel through the shared slot write-path
 * (slot-edit / slot-authoring) so each is one undoable history frame.
 */

import { useCallback, useState } from 'react'
import { useSnapshot } from 'valtio'
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { getCommittedNodeOnActivePage } from '@/lib/renderer/properties/commit-node-properties'
import { docProxy } from '@/lib/renderer/store/doc-proxy'
import { isSlotShape } from '@/lib/worker/geometry/shapes'
import { removeViewFromSlot, setActiveView, setSlotClip } from '@/lib/renderer/slot/slot-edit'
import {
  addNewViewToSlot,
  convertFrameToSlot,
  convertSlotToFrame,
  selectView,
  viewName,
} from '@/lib/renderer/slot/slot-authoring'
import type { RectLikeNode } from '@/lib/renderer/properties/panel-utils'

interface SlotSectionProps {
  nodeId: string
  initialNode: RectLikeNode
  readOnly?: boolean
}

export function SlotSection({ nodeId, readOnly }: SlotSectionProps) {
  // Track doc changes so the view list / active / clip reflect undo/redo + edits.
  useSnapshot(docProxy)
  const slot = getCommittedNodeOnActivePage(nodeId)

  const [collapsed, setCollapsed] = useState(false)

  const onAdd = useCallback(() => {
    if (!readOnly) void addNewViewToSlot(nodeId)
  }, [nodeId, readOnly])

  // A plain frame gets the way in: converting extracts its content into the
  // outlet's first view (see convertFrameToSlot). The page root is never an outlet.
  if (!isSlotShape(slot)) {
    if (readOnly || slot?.type !== 'frame') return null
    return (
      <>
        <Separator />
        <div className="min-w-0 space-y-2">
          <p className="py-0.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">Slot</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => void convertFrameToSlot(nodeId)}
          >
            Convert to slot
          </Button>
          <p className="text-xs text-muted-foreground">
            Turns this frame into a router outlet. Its content becomes the outlet&apos;s first view.
          </p>
        </div>
      </>
    )
  }

  const clip = slot.showContent === false
  const views = slot.views

  return (
    <>
      <Separator />
      <div className="min-w-0 space-y-2">
        <div className="flex items-center justify-between gap-2 py-0.5">
          <button
            type="button"
            className="flex min-h-8 flex-1 items-center gap-1 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <ChevronRight className="size-3.5 shrink-0" aria-hidden />
            ) : (
              <ChevronDown className="size-3.5 shrink-0" aria-hidden />
            )}
            Slot
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={readOnly}
            onClick={onAdd}
            aria-label="Add view"
            title="Add a new view"
          >
            <Plus aria-hidden />
          </Button>
        </div>

        {!collapsed && (
          <div className="space-y-2">
            {views.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No views yet. Drop a frame onto this slot in the Layers panel, or add one.
              </p>
            ) : (
              <ul className="space-y-0.5">
                {views.map((viewId) => {
                  const active = slot.activeView === viewId
                  return (
                    <li key={viewId} className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name={`slot-active-${nodeId}`}
                        checked={active}
                        disabled={readOnly}
                        onChange={() => void setActiveView(nodeId, viewId)}
                        aria-label={`Show ${viewName(viewId)} by default`}
                        className="size-3.5 shrink-0 accent-primary"
                      />
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left text-xs hover:text-foreground"
                        onClick={() => selectView(viewId)}
                        title={`Select ${viewName(viewId)} on canvas`}
                      >
                        {viewName(viewId)}
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        disabled={readOnly}
                        onClick={() => void removeViewFromSlot(nodeId, viewId)}
                        aria-label={`Remove ${viewName(viewId)}`}
                        title="Remove from this slot"
                      >
                        <X aria-hidden />
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}

            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={clip}
                disabled={readOnly}
                onChange={(e) => void setSlotClip(nodeId, e.target.checked)}
                className="size-3.5 shrink-0 accent-primary"
              />
              Clip content
            </label>

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              disabled={readOnly}
              onClick={() => void convertSlotToFrame(nodeId)}
              title="Views stay as separate frames"
            >
              Convert to frame
            </Button>
          </div>
        )}
      </div>
    </>
  )
}
