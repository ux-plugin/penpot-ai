import type { Matrix, PenpotNode } from 'penpot-exporter/types'
import { snapshot } from 'valtio'
import { cleanModifiers, propagateModifiers, setStructureModifiers } from '../api/modifiers'
import { setShapeGrowType, moduleUseShape } from '../api/shape'
import { applyTransformToNode } from '../geom/apply-transform-to-node'
import { useWorkspaceStore } from '../store/workspace-store'
import { commitChanges } from '../store/commit'
import { docProxy, getActiveOrSinglePageId } from '../store/doc-proxy'
import {
  appendModObjPair,
  emptyChangesBuilder,
  snapshotGeometryForUndo,
  toCommitBundle,
  type ChangesBuilder,
} from '../../changes/changes-builder'
import { buildReparentChanges } from '../../components/LayersPanel/reparent'
import {
  groupReparentTargets,
  type PerShapeReparent,
  type StructureModifierEntry,
} from './reparent-detection'
import type { IndexedShape } from '../../worker/types'
import { clearModifierOverlay } from '../store/modifier-overlay'

export interface ApplyModifiersAndCommitOptions {
  pixelPrecision?: number
  /** Per-shape reparent intents for shapes whose final drop parent differs from current. */
  reparentTargets?: ReadonlyMap<string, PerShapeReparent>
  /** Pre-propagate text grow-type assignments. Mirrors CLJS modifiers.cljs:681–684. */
  textGrowTypes?: ReadonlyMap<string, string | undefined>
  /** Pre-propagate structure modifiers. Mirrors CLJS modifiers.cljs:677. */
  structureModifiers?: ReadonlyArray<StructureModifierEntry>
}

export async function applyModifiersAndCommit(
  entries: Array<[string, Matrix]>,
  options?: ApplyModifiersAndCommitOptions,
): Promise<void> {
  const state = useWorkspaceStore.getState()
  const { renderer } = state
  const module = renderer?.getModule?.()
  if (!module) return
  const pageId = getActiveOrSinglePageId() ?? undefined

  // Snapshot pre-commit geometry from docProxy for undoAssign — must happen
  // before any WASM-side mutation. snapshot() produces non-proxy objects so
  // structuredClone inside snapshotGeometryForUndo doesn't trip on the proxy.
  const docSnap = snapshot(docProxy)
  const pageObjects = pageId ? docSnap.pageMap.get(pageId)?.objects : undefined

  // 1. Clean any drag-time modifier overlay so propagate runs against committed state.
  cleanModifiers(module)

  // 2. Preflight structure modifiers (in-flight reparent / flex track changes).
  if (options?.structureModifiers && options.structureModifiers.length > 0) {
    setStructureModifiers(module, options.structureModifiers as Array<StructureModifierEntry>)
  }

  // 3. Preflight per-text grow-type so propagate sees the post-commit intrinsic size.
  if (options?.textGrowTypes && options.textGrowTypes.size > 0) {
    for (const [id, growType] of options.textGrowTypes) {
      moduleUseShape(module, id)
      setShapeGrowType(module, growType)
    }
  }

  // 4. Propagate (constraints + flex/grid reflow). Returns final transforms.
  //    Treated as pure data — we do NOT write it back to pool.modifiers.
  //    processObject setters inside commitChanges write the new geometry to
  //    the base shape; if a stale modifier overlay were left in the pool it
  //    would compose with the freshly-set base in `Shape::transformed`,
  //    rendering the shape at 2× the delta until cleanModifiers ran. CLJS
  //    `apply-wasm-modifiers` (modifiers.cljs:695) likewise treats propagate's
  //    output as data for update-shapes only.
  //
  //    'child' kind: gesture commits include container shapes whose
  //    descendants must follow via constraint propagation.
  const propagated = propagateModifiers(module, entries, options?.pixelPrecision ?? 0, 'child')

  // 5. Build mod-obj redo/undo pairs from the propagated transforms.
  let builder: ChangesBuilder = emptyChangesBuilder({ pageId })
  for (const { id, transform } of propagated) {
    const node = pageObjects?.[id] as PenpotNode | undefined
    if (!node) continue
    const undoAssign = snapshotGeometryForUndo(node) as Record<string, unknown>
    const partial = applyTransformToNode(node, transform)
    if (!partial) continue
    const redoAssign = partial as Record<string, unknown>
    // Persist a grow-type change (e.g. resizing pins an auto-size text box to
    // `fixed`) in the SAME frame as the geometry, but only when it actually
    // differs — callers that pass the current grow type to preserve it (move /
    // reparent) leave the model untouched.
    const requestedGrow = options?.textGrowTypes?.get(id)
    const currentGrow = (node as { growType?: string }).growType
    if (requestedGrow !== undefined && requestedGrow !== currentGrow) {
      redoAssign.growType = requestedGrow
      undoAssign.growType = currentGrow
    }
    builder = appendModObjPair(builder, pageId, id, {
      redoAssign,
      undoAssign,
    })
  }

  // 7. Atomic reparent: append mov-objects (one per destination parent) into
  //    the SAME bundle so a drag-into-frame is one undo frame. Mirrors CLJS
  //    `start-undo-transaction` … `commit-undo-transaction` (modifiers.cljs:734).
  if (options?.reparentTargets && options.reparentTargets.size > 0 && pageId && pageObjects) {
    const objects = pageObjects as Record<string, IndexedShape>
    for (const target of groupReparentTargets(options.reparentTargets)) {
      const reparent = buildReparentChanges({
        pageId,
        parentId: target.parentId,
        index: target.index,
        shapeIds: target.ids,
        objects,
      })
      builder = {
        ...builder,
        redoChanges: [...builder.redoChanges, ...reparent.redoChanges],
        // mov-objects undo plays before the geometry undo; matches the
        // existing prepend invariant at changes-builder.ts:77.
        undoChanges: [...reparent.undoChanges, ...builder.undoChanges],
        pageId: builder.pageId ?? pageId,
      }
    }
  }

  const bundle = toCommitBundle(builder)
  if (bundle.redoChanges.length > 0) {
    await commitChanges({
      redoChanges: bundle.redoChanges,
      undoChanges: bundle.undoChanges,
      pageId: bundle.pageId ?? getActiveOrSinglePageId() ?? undefined,
    })
  }

  // 8. Clear any propagated overlay still in the WASM pool and the JS-side
  //    modifierOverlay store; the committed setters (processObject in
  //    renderer-sync) are now the source of truth.
  cleanModifiers(module)
  clearModifierOverlay()
}
