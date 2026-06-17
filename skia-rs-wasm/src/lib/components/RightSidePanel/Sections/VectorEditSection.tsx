/**
 * Vector-edit launcher (C). For `path` nodes, a button that enters/leaves the
 * `pathEditing` mode — the discoverable alternative to double-clicking the path.
 * Mirrors the double-click entry wired in use-viewport-interactions.
 */

import { useCallback } from 'react'
import { useSelector } from '@xstate/react'
import { PenTool } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useCanvasActor } from '@/lib/renderer/machine/canvas-actor-context'
import type { RectLikeNode } from '@/lib/renderer/properties/panel-utils'

export interface VectorEditSectionProps {
  nodeId: string
  initialNode: RectLikeNode
  readOnly?: boolean
}

export function VectorEditSection({ nodeId, initialNode, readOnly }: VectorEditSectionProps) {
  const canvasActor = useCanvasActor()
  const editingThis = useSelector(
    canvasActor,
    (s) => s.matches('pathEditing') && s.context.pathEditingShapeId === nodeId,
  )

  const toggle = useCallback(() => {
    if (editingThis) canvasActor.send({ type: 'STOP_PATH_EDIT' })
    else canvasActor.send({ type: 'START_PATH_EDIT', shapeId: nodeId })
  }, [canvasActor, editingThis, nodeId])

  // Only path nodes have an editable vector; rect/frame/circle keep native handles.
  if ((initialNode as { type?: string }).type !== 'path') return null

  return (
    <>
      <Separator />
      <div className="px-1 py-2">
        <Button
          type="button"
          variant={editingThis ? 'default' : 'outline'}
          size="sm"
          className="w-full gap-2"
          disabled={readOnly}
          onClick={toggle}
          aria-pressed={editingThis}
          title="Edit the path's anchor points and bézier handles"
        >
          <PenTool className="size-4 shrink-0" />
          {editingThis ? 'Done editing' : 'Edit path'}
        </Button>
        {editingThis && (
          <ul className="mt-2 space-y-0.5 text-[11px] leading-tight text-muted-foreground">
            <li>Drag a point to move it</li>
            <li>Double-click a point to round / sharpen it</li>
            <li>Or Option/Alt-drag a point to curve it</li>
            <li>Drag a handle to shape the curve</li>
            <li>Click the outline to add a point</li>
            <li>Select a point + Delete to remove it</li>
            <li>Click an open end, then click to extend it</li>
            <li>Click the other end to close the path</li>
          </ul>
        )}
      </div>
    </>
  )
}
