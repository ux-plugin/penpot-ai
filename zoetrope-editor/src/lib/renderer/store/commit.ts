/**
 * Wires the editor into the document pipeline (`doc/commit.ts`): the effects
 * that run before apply and the subscribers that run after, in one place so
 * the order is explicit.
 *
 * Effects, in order: component sync, aspects, 3D crop resize.
 * Subscribers, in order: renderer (WASM must hold the new state before the
 * selection rect is queried), selection, hit-index worker, 3D read-cache.
 */
import { onChangesApplied, registerEffect } from '../../doc/commit'
import { aspectsEffect, registerAspect } from '../../changes/aspects'
import { componentSyncEffect } from '../component/component-sync'
import { cropResizeEffect } from '../three/scene3d-crop-resize'
import { interactionsAspect } from '../interactions/document/interactions-aspect'
import { rendererSyncHandler } from './renderer-sync'
import { selectionSyncHandler } from './selection-sync'
import { workerSyncHandler } from '../../worker/worker-sync'
import { scene3dSyncHandler } from '../three/scene3d-sync'

registerEffect(componentSyncEffect)
registerEffect(aspectsEffect)
registerEffect(cropResizeEffect)

registerAspect(interactionsAspect)

onChangesApplied(rendererSyncHandler)
onChangesApplied(selectionSyncHandler)
onChangesApplied(workerSyncHandler)
onChangesApplied(scene3dSyncHandler)

export { commitChanges } from '../../doc/commit'
export type { CommitParams } from '../../doc/commit'
