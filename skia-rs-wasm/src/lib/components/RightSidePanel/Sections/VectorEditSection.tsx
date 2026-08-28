/**
 * Vector-edit launcher (C). For `path` nodes — and for convertible primitives
 * (rect / ellipse), which are baked into a path first — a button that enters/leaves
 * `pathEditing`. The discoverable, worker-independent alternative to double-clicking
 * (which relies on the hit-test worker); mirrors the entry in use-viewport-interactions.
 */

import { useCallback } from 'react'
import { useSelector } from '@xstate/react'
import { PenTool, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useCanvasActor } from '@/lib/renderer/machine/canvas-actor-context'
import { isConvertibleToPath, primitiveToPathPartial } from '@/lib/renderer/handlers/primitive-to-path'
import { applyShapeOperators, bakeShapeOperators } from '@/lib/renderer/handlers/erase'
import type { Operator } from '@/lib/renderer/geom/operators'
import type { Subpath } from '@/lib/renderer/geom/subpaths'
import {
  commitNodePartialUpdate,
  getCommittedNodeOnActivePage,
} from '@/lib/renderer/properties/commit-node-properties'
import { getActiveOrSinglePageId } from '@/lib/renderer/store/doc-proxy'
import type { RectLikeNode } from '@/lib/renderer/properties/panel-utils'

const OPERATOR_LABELS: Record<string, string> = { subtract: 'Erase' }

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

  const isPath = (initialNode as { type?: string }).type === 'path'

  const content = (initialNode as { content?: { operators?: Operator[]; base?: Subpath[] } }).content
  const operators = content?.operators ?? []
  const base = content?.base ?? []

  const removeOperator = useCallback(
    async (index: number) => {
      const pid = getActiveOrSinglePageId()
      if (!pid) return
      await applyShapeOperators(
        nodeId,
        pid,
        base,
        operators.filter((_, i) => i !== index),
      )
    },
    [nodeId, base, operators],
  )

  const bake = useCallback(async () => {
    const pid = getActiveOrSinglePageId()
    if (!pid) return
    await bakeShapeOperators(nodeId, pid)
  }, [nodeId])

  const toggle = useCallback(async () => {
    if (editingThis) {
      canvasActor.send({ type: 'STOP_PATH_EDIT' })
      return
    }
    // A primitive bakes into an editable path first (one undoable step), exactly
    // like the double-click entry, so the vector editor has geometry to show.
    if (!isPath) {
      const before = getCommittedNodeOnActivePage(nodeId)
      const partial = primitiveToPathPartial(before)
      const pid = getActiveOrSinglePageId()
      if (before && partial && pid) await commitNodePartialUpdate(nodeId, before, partial, pid)
    }
    canvasActor.send({ type: 'START_PATH_EDIT', shapeId: nodeId })
  }, [canvasActor, editingThis, isPath, nodeId])

  // Editable paths, plus primitives we can bake into one (rect/ellipse). Other
  // types (frame, text, 3D) keep their native handles.
  if (!isPath && !isConvertibleToPath(initialNode as { type?: string })) return null

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
            <li>Pen tool → new sub-path, then click another end to join</li>
          </ul>
        )}
        {isPath && operators.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium text-muted-foreground">
                Operators <span className="tabular-nums">({operators.length})</span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px]"
                disabled={readOnly}
                onClick={bake}
                title="Bake the stack into the path — the cuts become permanent and future edits are destructive"
              >
                Bake
              </Button>
            </div>
            <ul className="space-y-0.5">
              {operators.map((op, i) => (
                <li
                  key={i}
                  className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1 text-[11px]"
                >
                  <span className="text-foreground">{OPERATOR_LABELS[op.type] ?? op.type}</span>
                  <span className="ml-auto tabular-nums text-muted-foreground">#{i + 1}</span>
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => removeOperator(i)}
                    title="Remove this operator (restores what it cut)"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  )
}
