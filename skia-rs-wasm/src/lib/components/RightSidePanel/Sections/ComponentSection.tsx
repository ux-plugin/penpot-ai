/**
 * Component properties — create a component from a frame, and drive a copy.
 *
 * Three faces, one per role the selected node plays:
 *  - a plain frame offers "Create component";
 *  - a main instance shows what it defines and can be deleted as a component
 *    (the frame stays on the canvas);
 *  - a copy shows its declared props as editable controls, plus reset and detach.
 *
 * Every mutation funnels through the component write-paths (component-crud /
 * component-props / component-overrides), so each is one undoable history frame.
 */

import { useCallback, useState } from 'react'
import { useSnapshot } from 'valtio'
import { ChevronDown, ChevronRight, RotateCcw, Unlink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { getCommittedNodeOnActivePage } from '@/lib/renderer/properties/commit-node-properties'
import { docProxy } from '@/lib/renderer/store/doc-proxy'
import { isComponentCopyRoot, isComponentMain } from '@/lib/worker/geometry/shapes'
import {
  createComponentFromFrame,
  deleteComponent,
  detachCopy,
  getComponent,
} from '@/lib/renderer/component/component-crud'
import {
  getPropValues,
  setPropValue,
} from '@/lib/renderer/component/component-props'
import {
  hasOverrides,
  resetOverrides,
} from '@/lib/renderer/component/component-overrides'
import type { ComponentProp } from '@/lib/common/component'
import type { RectLikeNode } from '@/lib/renderer/properties/panel-utils'

interface ComponentSectionProps {
  nodeId: string
  initialNode: RectLikeNode
  readOnly?: boolean
}

const HEADING = 'py-0.5 text-xs font-medium tracking-wide text-muted-foreground uppercase'

/** One editable control for a declared prop, by type. */
function PropControl({
  prop,
  value,
  disabled,
  onChange,
}: {
  prop: ComponentProp
  value: unknown
  disabled?: boolean
  onChange: (next: unknown) => void
}) {
  if (prop.type === 'boolean') {
    return (
      <label className="flex items-center gap-1.5 text-xs">
        <input
          type="checkbox"
          checked={Boolean(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="size-3.5 shrink-0 accent-primary"
        />
        <span className="min-w-0 flex-1 truncate">{prop.name}</span>
      </label>
    )
  }
  if (prop.type === 'text') {
    return (
      <label className="flex items-center gap-1.5 text-xs">
        <span className="w-20 shrink-0 truncate text-muted-foreground">{prop.name}</span>
        <input
          type="text"
          value={String(value ?? '')}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-xs"
        />
      </label>
    )
  }
  // instance-swap / variant are declarable but not yet settable — say so rather
  // than offering a control that silently does nothing.
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="w-20 shrink-0 truncate text-muted-foreground">{prop.name}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground/70">
        {prop.type} — not available yet
      </span>
    </div>
  )
}

export function ComponentSection({ nodeId, readOnly }: ComponentSectionProps) {
  // Track doc changes so props, overrides and role reflect undo/redo + edits.
  useSnapshot(docProxy)
  const node = getCommittedNodeOnActivePage(nodeId)
  const [collapsed, setCollapsed] = useState(false)

  const isMain = isComponentMain(node)
  const isCopy = isComponentCopyRoot(node)
  const component = node?.componentId ? getComponent(node.componentId) : undefined

  const onCreate = useCallback(() => {
    if (!readOnly) void createComponentFromFrame(nodeId)
  }, [nodeId, readOnly])

  // A plain frame gets the way in.
  if (!isMain && !isCopy) {
    if (readOnly || node?.type !== 'frame' || node.parentId == null) return null
    return (
      <>
        <Separator />
        <div className="min-w-0 space-y-2">
          <p className={HEADING}>Component</p>
          <Button type="button" variant="outline" size="sm" className="w-full" onClick={onCreate}>
            Create component
          </Button>
          <p className="text-xs text-muted-foreground">
            This frame becomes the main. Copies of it track its changes.
          </p>
        </div>
      </>
    )
  }

  // Flagged as a component but its record is gone — say so instead of rendering
  // an empty panel the user can't act on.
  if (!component) {
    return (
      <>
        <Separator />
        <div className="min-w-0 space-y-2">
          <p className={HEADING}>Component</p>
          <p className="text-xs text-muted-foreground">
            This node points at a component that is no longer in the library.
          </p>
          {isCopy && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              disabled={readOnly}
              onClick={() => void detachCopy(nodeId)}
            >
              Detach
            </Button>
          )}
        </div>
      </>
    )
  }

  const values = isCopy ? getPropValues(nodeId) : {}
  const overridden = isCopy && hasOverrides(nodeId)

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
            Component
          </button>
          <span className="truncate text-[10px] text-muted-foreground/70">
            {isMain ? 'Main' : 'Copy'}
          </span>
        </div>

        {!collapsed && (
          <div className="space-y-2">
            <p className="truncate text-xs font-medium" title={component.name}>
              {component.name}
            </p>

            {isCopy && component.props.length > 0 && (
              <div className="space-y-1.5">
                {component.props.map((prop) => (
                  <PropControl
                    key={prop.id}
                    prop={prop}
                    value={prop.id in values ? values[prop.id] : prop.defaultValue}
                    disabled={readOnly}
                    onChange={(next) => void setPropValue(nodeId, prop.id, next)}
                  />
                ))}
              </div>
            )}

            {isCopy && component.props.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No properties declared on this component yet.
              </p>
            )}

            {isCopy && (
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  disabled={readOnly || !overridden}
                  onClick={() => void resetOverrides(nodeId)}
                  title={
                    overridden
                      ? 'Take the main’s values back'
                      : 'Nothing on this copy differs from the main'
                  }
                >
                  <RotateCcw aria-hidden className="size-3.5" />
                  Reset
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  disabled={readOnly}
                  onClick={() => void detachCopy(nodeId)}
                  title="Keep the shapes, stop tracking the component"
                >
                  <Unlink aria-hidden className="size-3.5" />
                  Detach
                </Button>
              </div>
            )}

            {isMain && (
              <>
                <p className="text-xs text-muted-foreground">
                  Editing this frame updates every copy, except where a copy has its own change.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={readOnly}
                  onClick={() => void deleteComponent(component.id)}
                  title="The frames stay on canvas; they stop tracking each other"
                >
                  Delete component
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </>
  )
}
