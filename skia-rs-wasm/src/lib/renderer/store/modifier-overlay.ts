/**
 * JS-side mirror of the WASM modifier pool — the gesture-time scratch space.
 *
 * Mirrors CLJS's two transient buckets (`workspace-modifiers`,
 * `workspace-wasm-modifiers`) that live as keys in `app-db`. We don't have a
 * single ratom equivalent, but the data is the same shape:
 *
 *   workspaceModifiers       — what the gesture handler asked for (intent).
 *   workspaceWasmModifiers   — what `propagate_modifiers` returned (consequence).
 *
 * Stored as **plain Maps in a module singleton**, no reactive wrapper. The
 * only consumer today is the commit handler reading imperatively. If a
 * reactive consumer ever appears (cyan overlay, panel live values), the
 * one-line upgrade is a single `signal(0)` version counter bumped inside the
 * two `setTemporary*` functions; consumers `useSignalValue(...)` to re-render
 * and read the Map directly.
 */

import type { Matrix } from 'penpot-exporter/types'
import type { StructureModifierEntry } from '../handlers/reparent-detection'

export interface GeometryModifier {
  matrix: Matrix
  structure?: StructureModifierEntry[]
}

const workspaceModifiers = new Map<string, GeometryModifier>()
const workspaceWasmModifiers = new Map<string, Matrix>()

/** Replace the gesture intent map. Called by `setWasmModifiers` per gesture frame. */
export function setTemporaryModifiers(
  entries: Iterable<readonly [string, GeometryModifier]>,
): void {
  workspaceModifiers.clear()
  for (const [id, m] of entries) workspaceModifiers.set(id, m)
}

/** Replace the propagated-result map. Called by `setWasmModifiers` after propagate. */
export function setTemporaryWasmModifiers(
  entries: Iterable<readonly [string, Matrix]>,
): void {
  workspaceWasmModifiers.clear()
  for (const [id, m] of entries) workspaceWasmModifiers.set(id, m)
}

/** Wipe both maps. Called at commit completion (success or error path). */
export function clearModifierOverlay(): void {
  workspaceModifiers.clear()
  workspaceWasmModifiers.clear()
}

/** Read the gesture intent for one shape. Imperative; no subscription. */
export function getWorkspaceModifier(id: string): GeometryModifier | undefined {
  return workspaceModifiers.get(id)
}

/** Read the propagate result for one shape. Imperative; no subscription. */
export function getWorkspaceWasmTransform(id: string): Matrix | undefined {
  return workspaceWasmModifiers.get(id)
}
