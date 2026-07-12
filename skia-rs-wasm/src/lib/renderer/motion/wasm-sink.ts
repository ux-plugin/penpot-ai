/**
 * WasmModifierSink — drives the live Skia canvas from playback. It batches one
 * frame's per-shape matrices and pushes them through the renderer's WASM
 * modifier preview path (setWasmModifiers + requestRenderFrame), the same path
 * the move/resize handlers use for live transforms. Animation is therefore a
 * non-destructive overlay: `reset()` clears it and returns shapes to their base
 * pose. Opacity is buffered but not yet applied — it goes through a separate
 * fill-modifier path (follow-up).
 */

import type { Matrix } from 'penpot-exporter/types'
import { useWorkspaceStore } from '../store/workspace-store'
import type { ModifierSink } from './playback-controller'
import type { Modifier } from './modifier'

export class WasmModifierSink implements ModifierSink {
  private entries: Array<readonly [string, Matrix]> = []
  /** Last frame's per-shape matrices (what was drawn) — the zero-drift source for the hit-test channel. */
  private appliedMap: Map<string, Matrix> = new Map()

  apply(targetId: string, modifier: Modifier): void {
    this.entries.push([targetId, modifier.matrix])
    // modifier.opacity is intentionally ignored for now (separate fill path).
  }

  flush(): void {
    // Retain this frame's matrices (zero-drift source for the modifier-aware
    // hit-test channel) before draining, so consumers read exactly what drew.
    this.appliedMap = new Map(this.entries)
    const renderer = useWorkspaceStore.getState().renderer
    if (!renderer) {
      this.entries = []
      return
    }
    if (this.entries.length > 0) {
      renderer.setWasmModifiers(this.entries)
    }
    renderer.requestRenderFrame()
    this.entries = []
  }

  /** The last frame's per-shape matrices (id -> matrix). Empty after reset(). */
  get lastApplied(): ReadonlyMap<string, Matrix> {
    return this.appliedMap
  }

  /** Clear the preview transforms and repaint the base scene. */
  reset(): void {
    this.entries = []
    this.appliedMap = new Map()
    const renderer = useWorkspaceStore.getState().renderer
    if (!renderer) return
    renderer.cleanModifiers()
    renderer.flushRenderSync()
  }
}
