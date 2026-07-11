/**
 * Right rail: page + node properties driven by document selection (Valtio).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSnapshot } from 'valtio'
import type { Fill } from 'penpot-exporter/types'
import { docProxy, getActiveOrSinglePageId } from '../../renderer/store/doc-proxy'
import { activeEditorGradient, activeEditorOnChange, activeEditorTarget } from '../../renderer/signals/selection'
import { MAX_GRADIENT_STOPS } from '../../renderer/api/constants'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { FloatingEditorRail } from '../EditorShell/floating-editor-rail'
import { ROOT_UUID, type EffectItem, type RectLikeNode } from '../../renderer/properties/panel-utils'
import { PagePropertyPanel } from './PagePropertyPanel'
import { NodePropertyPanel } from './NodePropertyPanel'
import {
  ColorEditorContext,
  type ColorEditorContextValue,
  type ColorEditorKind,
  type ColorEditorTarget,
} from './color-editor-context'
import { FloatingColorEditorPanel } from './FloatingColorEditorPanel'
import { FloatingEffectEditorPanel } from './FloatingEffectEditorPanel'
import { InspectorTabBar } from '../Inspector/InspectorTabBar'
import { InteractionsTab } from '../Inspector/InteractionsTab'
import { MotionTab } from '../Inspector/MotionTab'
import { CodeTab } from '../Inspector/CodeTab'
import { inspectorTab } from '../../renderer/signals/inspector-tab'
import { useSignalCoalesced } from '../../renderer/signals/use-signal-coalesced'

export interface RightSidePanelProps {
  className?: string
}

export function RightSidePanel({ className }: RightSidePanelProps) {
  const doc = useSnapshot(docProxy)
  const selectedIds = useMemo(() => new Set(doc.selectedIds), [doc.selectedIds])

  const [collapsed, setCollapsed] = useState(false)
  const tab = useSignalCoalesced(inspectorTab)

  // Unified color editor state (fill or stroke)
  const [activeTarget, setActiveTarget] = useState<ColorEditorTarget | null>(null)
  const [activeFill, setActiveFill] = useState<Fill | null>(null)
  const [anchorY, setAnchorY] = useState(12)
  const [title, setTitle] = useState('')
  const onChangeRef = useRef<((fill: Fill) => void) | null>(null)

  // Effect editor state (glass / shadow properties)
  const [activeEffect, setActiveEffect] = useState<EffectItem | null>(null)
  const onEffectChangeRef = useRef<((effect: EffectItem) => void) | null>(null)

  const closeEditor = useCallback(() => {
    setActiveTarget(null)
    setActiveFill(null)
    setActiveEffect(null)
    setTitle('')
    onChangeRef.current = null
    onEffectChangeRef.current = null
    activeEditorTarget.value = null
  }, [])

  const openEditor = useCallback(
    (kind: ColorEditorKind, index: number, fill: Fill, y: number, t: string, onChange: (fill: Fill) => void) => {
      setActiveTarget({ kind, index })
      setActiveFill(fill)
      setAnchorY(y)
      setTitle(t)
      // Clear effect-specific state so FloatingEffectEditorPanel hides
      setActiveEffect(null)
      onEffectChangeRef.current = null
      onChangeRef.current = (next: Fill) => {
        setActiveFill(next)
        onChange(next)
      }
      activeEditorTarget.value = { kind, index }
    },
    [],
  )

  const openEffectEditor = useCallback(
    (kind: ColorEditorKind, index: number, effect: EffectItem, y: number, t: string, onChange: (effect: EffectItem) => void) => {
      setActiveTarget({ kind, index })
      setActiveEffect(effect)
      setAnchorY(y)
      setTitle(t)
      // Clear fill-specific state so FloatingColorEditorPanel hides
      setActiveFill(null)
      onChangeRef.current = null
      onEffectChangeRef.current = (next: EffectItem) => {
        setActiveEffect(next)
        onChange(next)
      }
      activeEditorTarget.value = { kind, index }
    },
    [],
  )

  // Sync active editor gradient + onChange callback to signals for SelectionOverlay.
  // No cleanup here — the null-then-set pattern races with useSignalCoalesced's RAF batching.
  useEffect(() => {
    const g = activeFill?.fillColorGradient
    activeEditorGradient.value = g
      ? { ...g, stops: g.stops?.slice(0, MAX_GRADIENT_STOPS) ?? [] }
      : null
    activeEditorOnChange.value = onChangeRef.current
  }, [activeFill])

  // Clean up signals only on unmount
  useEffect(() => {
    return () => {
      activeEditorGradient.value = null
      activeEditorOnChange.value = null
      activeEditorTarget.value = null
    }
  }, [])

  // Close editor when selection changes
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- close floating editor when selection changes externally */
    closeEditor()
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [selectedIds, closeEditor])

  // Close the floating color editor when leaving the Parameters tab
  useEffect(() => {
    if (tab !== 'parameters') {
      /* eslint-disable-next-line react-hooks/set-state-in-effect -- close floating editor when switching inspector tab */
      closeEditor()
    }
  }, [tab, closeEditor])

  // Close editor when right panel collapses
  const handleCollapsedChange = useCallback(
    (next: boolean) => {
      setCollapsed(next)
      if (next) {
        closeEditor()
      }
    },
    [closeEditor],
  )

  const colorEditorCtx = useMemo<ColorEditorContextValue>(
    () => ({
      activeTarget,
      activeFill,
      anchorY,
      title,
      openEditor,
      closeEditor,
      onChangeRef,
      activeEffect,
      onEffectChangeRef,
      openEffectEditor,
    }),
    [activeTarget, activeFill, activeEffect, anchorY, title, openEditor, openEffectEditor, closeEditor],
  )

  const count = selectedIds.size
  const singleId = count === 1 ? Array.from(selectedIds)[0] : null
  const isRoot = singleId === ROOT_UUID

  const resolvePageId = useCallback((): string | null => getActiveOrSinglePageId(), [])

  // The Parameters tab body — the existing selection-driven property editor.
  let parametersBody: ReactNode = null
  if (count === 0) {
    const pid = resolvePageId()
    const page = pid ? doc.pageMap.get(pid) : undefined
    parametersBody = (
      <div className="flex min-h-0 flex-1 flex-col">
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 p-3">
            {pid && page && <PagePropertyPanel key={pid} pageId={pid} initialPage={page} />}
            <Separator />
            <p className="text-sm text-muted-foreground">Select a layer to view shape properties.</p>
          </div>
        </ScrollArea>
      </div>
    )
  } else if (count > 1) {
    parametersBody = (
      <div className="p-3 text-sm">
        <span className="font-medium">{count} items selected</span>
        <p className="mt-2 text-muted-foreground">Edit one shape at a time.</p>
      </div>
    )
  } else if (singleId) {
    const currentPage = doc.currentPageId ? doc.pageMap.get(doc.currentPageId) : undefined
    const node = currentPage?.objects[singleId] as RectLikeNode | undefined
    parametersBody = (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!isRoot && (
          <p
            className="shrink-0 truncate border-b border-border px-3 py-1.5 text-xs text-muted-foreground"
            title={singleId}
          >
            {singleId.slice(0, 8)}…
          </p>
        )}
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <div className="min-w-0 space-y-4 p-3">
            {node ? (
              <NodePropertyPanel key={singleId} nodeId={singleId} initialNode={node} readOnly={isRoot} />
            ) : null}
          </div>
        </ScrollArea>
      </div>
    )
  }

  return (
    <ColorEditorContext.Provider value={colorEditorCtx}>
      <FloatingColorEditorPanel />
      <FloatingEffectEditorPanel />
      <FloatingEditorRail
        docked
        side="right"
        title="Inspector"
        collapsed={collapsed}
        onCollapsedChange={handleCollapsedChange}
        data-right-side-panel
        className={cn('min-h-0', className)}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <InspectorTabBar />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {tab === 'parameters' ? parametersBody : tab === 'interactions' ? <InteractionsTab /> : tab === 'motion' ? <MotionTab /> : <CodeTab />}
          </div>
        </div>
      </FloatingEditorRail>
    </ColorEditorContext.Provider>
  )
}

/** @deprecated Use `RightSidePanel` */
export const ShapePropertiesPanel = RightSidePanel
/** @deprecated Use `RightSidePanelProps` */
export type ShapePropertiesPanelProps = RightSidePanelProps
