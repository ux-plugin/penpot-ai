/**
 * scene3d-pointer — the click analogue of `dispatchKey` for 3D-scene editing.
 *
 * A pointer-down inside the live overlay is resolved HERE, gated by the machine
 * mode (`scene3dEditing`) exactly as the keyboard bindings are guarded by snapshot
 * state. Keeping the decision in one named, mode-guarded place — instead of inline
 * in the overlay listener — mirrors the pathEditing model: the machine snapshot is
 * the single guard, and the one side effect (focusing an object) is applied here.
 */

import type { CanvasActorRef } from '../machine/canvas-actor-types'
import { type Scene3DInstance, setFocusedObject } from './scene3d-store'

/** What a pointer-down inside the 3D overlay resolved to. */
export type Scene3DPointerOutcome =
  /** Not in 3D-edit mode → ignore (the press belongs to the 2D canvas). */
  | 'inactive'
  /** A gizmo handle is engaged → TransformControls owns the drag. */
  | 'gizmo'
  /** Hit an object → it became the focused (gizmo) target. */
  | 'focus'
  /** Empty space → focus untouched; OrbitControls handles the drag. */
  | 'orbit'

export interface Scene3DPointerDeps {
  actor: CanvasActorRef
  /** The live instance of the editing scene (raycast target), or null if unbuilt. */
  instance: Scene3DInstance | null
  /** True while a TransformControls axis/handle is engaged. */
  gizmoActive: boolean
  /** Raycast a normalized-device point to an object id in the scene, or null. */
  pick: (instance: Scene3DInstance, ndcX: number, ndcY: number) => string | null
}

/**
 * Resolve a pointer-down at NDC (`ndcX`,`ndcY`) inside the 3D overlay. Applies the
 * single focus side effect and returns the outcome (handy for tests / telemetry).
 */
export function resolveScene3dPointerDown(
  ndcX: number,
  ndcY: number,
  deps: Scene3DPointerDeps,
): Scene3DPointerOutcome {
  if (!deps.actor.getSnapshot().matches('scene3dEditing')) return 'inactive'
  if (deps.gizmoActive) return 'gizmo'
  if (!deps.instance) return 'orbit'
  const hit = deps.pick(deps.instance, ndcX, ndcY)
  if (!hit) return 'orbit'
  setFocusedObject(hit)
  return 'focus'
}
