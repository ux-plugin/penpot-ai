import type { Matrix } from 'penpot-exporter/types'
import { cleanModifiers, propagateModifiers, setStructureModifiers } from '../api/modifiers'
import { setShapeGrowType, moduleUseShape } from '../api/shape'
import { applyTransformToNode } from '../geom/apply-transform-to-node'
import { useWorkspaceStore } from '../store/workspace-store'
import { commitChanges } from '../store/commit'
import { getActiveOrSinglePageId, getNode, mod, moveNodes, type Change, type Node } from '../../doc'
import { groupReparentTargets, type PerShapeReparent, type StructureModifierEntry } from './reparent-detection'
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

/**
 * End of a gesture: propagate the entries through WASM (constraints, flex/grid
 * reflow) and commit the resulting geometry, grow-type changes and reparents
 * as one frame. Mirrors CLJS `apply-wasm-modifiers`.
 */
export async function applyModifiersAndCommit(
  entries: Array<[string, Matrix]>,
  options?: ApplyModifiersAndCommitOptions,
): Promise<void> {
  const module = useWorkspaceStore.getState().renderer?.getModule?.()
  if (!module) return
  const page = getActiveOrSinglePageId()

  // Clean any drag-time overlay so propagate runs against committed state.
  cleanModifiers(module)

  if (options?.structureModifiers && options.structureModifiers.length > 0) {
    setStructureModifiers(module, options.structureModifiers as Array<StructureModifierEntry>)
  }
  if (options?.textGrowTypes && options.textGrowTypes.size > 0) {
    for (const [id, growType] of options.textGrowTypes) {
      moduleUseShape(module, id)
      setShapeGrowType(module, growType)
    }
  }

  // Propagate's output is data for the commit only; the committed setters
  // write the base shape, and a stale overlay would compose twice.
  const propagated = propagateModifiers(module, entries, options?.pixelPrecision ?? 0, 'child')

  const changes: Change[] = []
  for (const { id, transform } of propagated) {
    const node = getNode(id)
    if (!node) continue
    const partial = applyTransformToNode(node, transform)
    if (!partial) continue
    const set = partial as Partial<Node>
    // A grow-type change (resizing pins an auto-size text to `fixed`) lands in
    // the same frame, only when it differs.
    const requestedGrow = options?.textGrowTypes?.get(id)
    if (requestedGrow !== undefined && requestedGrow !== (node as { growType?: string }).growType) {
      ;(set as { growType?: string }).growType = requestedGrow
    }
    changes.push(mod('node', id, set))
  }

  // Reparents ride the same frame, one `moveNodes` per destination parent.
  if (options?.reparentTargets && options.reparentTargets.size > 0 && page) {
    for (const target of groupReparentTargets(options.reparentTargets)) {
      changes.push(...moveNodes(target.ids, { page, parentId: target.parentId, index: target.index }))
    }
  }

  if (changes.length > 0) await commitChanges({ changes })

  cleanModifiers(module)
  clearModifierOverlay()
}
