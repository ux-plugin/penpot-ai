/**
 * Commit partial node updates with paired undo for history (mod-obj assign).
 *
 * Layout-* edits additionally trigger a flex/grid reflow on the affected
 * container: `propagate_modifiers` runs the WASM reflow with the freshly-set
 * flex config, the resulting child transforms are written back to docProxy,
 * and the whole edit lands as a single history frame. Mirrors CLJS
 * `update-layout` (shape_layout.cljs:290) + `update-layout-positions`
 * (shape_layout.cljs:100), where the `:layout/update` event is what builds
 * `(ctm/reflow-modifiers)` and applies them via `apply-wasm-modifiers`.
 */

import { snapshot } from 'valtio'
import type { PenpotNode } from 'penpot-exporter/types'
import { docProxy } from '../store/doc-proxy'
import {
  appendModObjPair,
  emptyChangesBuilder,
  snapshotGeometryForUndo,
  toCommitBundle,
  type ChangesBuilder,
} from '../../changes/changes-builder'
import { commitChangesPublic } from '../../page-crud'
import { cleanModifiers, propagateModifiers } from '../api/modifiers'
import { clearLayout, setFlexLayout, setGridLayout, setLayoutData } from '../api/layout'
import { moduleUseShape } from '../api/shape'
import { identityMatrix } from '../geom/matrix'
import { applyTransformToNode } from '../geom/apply-transform-to-node'
import { useWorkspaceStore } from '../store/workspace-store'
import { clearModifierOverlay } from '../store/modifier-overlay'

const CONTAINER_LAYOUT_KEYS = new Set<string>([
  'layoutFlexDir',
  'layoutGridDir',
  'layoutWrapType',
  'layoutJustifyContent',
  'layoutJustifyItems',
  'layoutAlignItems',
  'layoutAlignContent',
  'layoutGap',
  'layoutPadding',
  'layoutGridRows',
  'layoutGridColumns',
  'layoutGridCells',
])

function snapshotAttrsForUndo(node: PenpotNode, keys: string[]): Record<string, unknown> {
  const snap: Record<string, unknown> = {}
  const rec = node as Record<string, unknown>
  for (const k of keys) {
    const v = rec[k]
    if (v !== undefined) {
      snap[k] = v !== null && typeof v === 'object' ? structuredClone(v as object) : v
    }
  }
  return snap
}

export function rectLayoutPartial(
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: number
): Partial<PenpotNode> {
  const selrect = {
    x,
    y,
    width,
    height,
    x1: x,
    y1: y,
    x2: x + width,
    y2: y + height,
  }
  const points = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ]
  return {
    x,
    y,
    width,
    height,
    selrect,
    points,
    rotation: rotation !== 0 ? rotation : undefined,
  }
}

/** Latest committed node on the current page (same page key as `docProxy.currentPageId`). */
export function getCommittedNodeOnActivePage(nodeId: string): PenpotNode | null {
  const snap = snapshot(docProxy)
  const page = snap.currentPageId ? snap.pageMap.get(snap.currentPageId) : undefined
  return (page?.objects[nodeId] as PenpotNode | undefined) ?? null
}

/**
 * Resolve which container needs a flex/grid reflow given a partial.
 * - Container-layout key on the shape itself → reflow the shape.
 * - `layoutItem*` key (margin/sizing/align-self/...) on a child → reflow the child's parent.
 * - Otherwise → no reflow needed.
 */
function resolveReflowTarget(
  id: string,
  parentId: string | undefined,
  partial: Partial<PenpotNode>
): string | undefined {
  let touchesContainer = false
  let touchesItem = false
  for (const k of Object.keys(partial)) {
    if (CONTAINER_LAYOUT_KEYS.has(k)) touchesContainer = true
    else if (k.startsWith('layoutItem')) touchesItem = true
  }
  if (touchesContainer) return id
  if (touchesItem && parentId) return parentId
  return undefined
}

export async function commitNodePartialUpdate(
  id: string,
  nodeBefore: PenpotNode,
  partial: Partial<PenpotNode>,
  pageId: string | null | undefined
): Promise<void> {
  const redoAssign: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) {
      redoAssign[k] = v
    }
  }
  const keys = Object.keys(redoAssign)
  if (keys.length === 0) return

  const undoAssign = snapshotAttrsForUndo(nodeBefore, keys)
  const pid = pageId ?? undefined

  const reflowId = resolveReflowTarget(id, nodeBefore.parentId, partial)
  const renderer = useWorkspaceStore.getState().renderer
  const module = renderer?.getModule?.()

  // Fast path: no layout edit, or renderer/wasm not available (e.g. SSR/tests).
  if (!reflowId || !module) {
    let builder = emptyChangesBuilder({ pageId: pid })
    builder = appendModObjPair(builder, pid, id, { redoAssign, undoAssign })
    const bundle = toCommitBundle(builder)
    await commitChangesPublic({
      redoChanges: bundle.redoChanges,
      undoChanges: bundle.undoChanges,
      pageId: pid,
    })
    return
  }

  // Layout edit. Three phases collapsed into ONE commitChangesPublic call
  // (and therefore one history frame, via the history-sync subscriber):
  //
  //   1. Push the new layout block (just clearLayout + setFlex/Grid +
  //      setLayoutData) to WASM directly, ahead of propagate. We use the
  //      individual layout setters here rather than `renderer.updateShape`,
  //      because we don't want a full setObject pass (no spurious
  //      transform/fills/etc. re-pushes) and we don't want to schedule a
  //      render — the commit at the end will handle that.
  //
  //   2. propagate_modifiers with an identity matrix on the reflow target —
  //      Rust treats identity-on-container as a "reflow this layout" signal
  //      (geom/matrix.ts:11) and returns new child transforms reflecting the
  //      just-set config.
  //
  //   3. Build mod-obj pairs from the propagated transforms (against the
  //      pre-reflow children snapshot from docProxy) and concatenate them
  //      with the layout mod-obj. ONE commitChangesPublic call writes both
  //      to docProxy and re-syncs WASM via the renderer-sync subscriber.
  //      The renderer-sync re-pushes the parent's layout config (idempotent
  //      with phase 1) and the children's geometry as transform-only
  //      partials. The history-sync subscriber records exactly one frame.
  //
  // Transactionality: phase 1 mutates WASM before docProxy. If propagate
  // throws (or anything between throws) we'd be left with WASM holding the
  // new layout config and docProxy holding the old. The try/finally below
  // calls cleanModifiers either way; the state divergence is recoverable
  // because the next setObject for that shape (selection click, undo, etc.)
  // will re-sync WASM from docProxy.
  const projectedLayoutShape = { ...nodeBefore, ...redoAssign } as PenpotNode
  const layoutChangedKeys = new Set(
    keys.filter((k) => CONTAINER_LAYOUT_KEYS.has(k) || k.startsWith('layoutItem')),
  )

  let propagated: Array<{ id: string; transform: import('penpot-exporter/types').Matrix }> = []
  try {
    if (layoutChangedKeys.size > 0) {
      moduleUseShape(module, id)
      clearLayout(module)
      if ('layoutFlexDir' in projectedLayoutShape && projectedLayoutShape.layoutFlexDir) {
        setFlexLayout(module, projectedLayoutShape)
      }
      if ('layoutGridDir' in projectedLayoutShape && projectedLayoutShape.layoutGridDir) {
        setGridLayout(module, projectedLayoutShape)
      }
      setLayoutData(module, projectedLayoutShape)
    }
    cleanModifiers(module)
    propagated = propagateModifiers(module, [[reflowId, identityMatrix()]], 0, 'child')
  } finally {
    // Always clean — leaves WASM's modifier pool empty even if propagate threw.
    cleanModifiers(module)
  }

  let layoutBuilder = emptyChangesBuilder({ pageId: pid })
  layoutBuilder = appendModObjPair(layoutBuilder, pid, id, { redoAssign, undoAssign })

  let reflowBuilder: ChangesBuilder = emptyChangesBuilder({ pageId: pid })
  if (propagated.length > 0) {
    const docSnap = snapshot(docProxy)
    const pageObjects = pid ? docSnap.pageMap.get(pid)?.objects : undefined
    if (pageObjects) {
      for (const { id: targetId, transform } of propagated) {
        if (targetId === reflowId) continue
        const node = pageObjects[targetId] as PenpotNode | undefined
        if (!node) continue
        const childPartial = applyTransformToNode(node, transform)
        if (!childPartial) continue
        reflowBuilder = appendModObjPair(reflowBuilder, pid, targetId, {
          redoAssign: childPartial as Record<string, unknown>,
          undoAssign: snapshotGeometryForUndo(node),
        })
      }
    }
  }

  // Combine bundles. `appendModObjPair` appends to redoChanges and prepends to
  // undoChanges, so iterating layout then reflow gives:
  //   redo: [layout-redo, child1-redo, child2-redo, …]
  //   undo: [childN-undo, …, child1-undo, layout-undo]
  // Undo replays in array order → children revert first, then layout. Matches
  // the prepend invariant in changes-builder.ts:77.
  const layoutBundle = toCommitBundle(layoutBuilder)
  const reflowBundle = toCommitBundle(reflowBuilder)
  const combinedRedo = [...layoutBundle.redoChanges, ...reflowBundle.redoChanges]
  const combinedUndo = [...reflowBundle.undoChanges, ...layoutBundle.undoChanges]
  await commitChangesPublic({
    redoChanges: combinedRedo,
    undoChanges: combinedUndo,
    pageId: pid,
  })

  clearModifierOverlay()
}
