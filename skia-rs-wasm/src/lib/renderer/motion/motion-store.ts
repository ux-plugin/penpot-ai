/**
 * Motion store — app-facing state and controls for timeline playback. Holds the
 * current clips and playhead as preact signals and owns a single
 * PlaybackController wired to the WASM canvas via WasmModifierSink. Pivots
 * (shape centres) are recomputed from live geometry before each play/seek so
 * rotation and scale pivot on the shape rather than the world origin.
 */

import { signal } from '@preact/signals-core'
import { useWorkspaceStore } from '../store/workspace-store'
import { querySelectionRect } from '../signals/selection'
import { PlaybackController } from './playback-controller'
import { WasmModifierSink } from './wasm-sink'
import type { Clip } from './types'
import type { Pivot } from './modifier'

export const motionClips = signal<Clip[]>([])
export const motionTime = signal(0)
export const motionPlaying = signal(false)
export const motionLoop = signal(false)

/**
 * True whenever a motion preview is applied to the canvas (between play/seek and
 * stop, including while paused mid-animation). Editor overlays read this to hide
 * selection chrome that would otherwise sit at the shape's base pose while the
 * shape is displaced.
 */
export const motionPreviewActive = signal(false)

const sink = new WasmModifierSink()
const controller = new PlaybackController(sink, {
  onFrame: (t) => {
    motionTime.value = t
  },
  onStop: () => {
    motionPlaying.value = false
  },
})

function computePivots(clips: Clip[]): Map<string, Pivot> {
  const renderer = useWorkspaceStore.getState().renderer
  const pivots = new Map<string, Pivot>()
  if (!renderer) return pivots
  for (const clip of clips) {
    const rect = querySelectionRect(renderer, [clip.targetId])
    if (rect) pivots.set(clip.targetId, { cx: rect.center.x, cy: rect.center.y })
  }
  return pivots
}

export function setMotionClips(clips: Clip[]): void {
  motionClips.value = clips
  controller.setClips(clips)
}

export function playMotion(): void {
  const clips = motionClips.value
  if (clips.length === 0) return
  controller.setPivots(computePivots(clips))
  controller.setLoop(motionLoop.value)
  controller.play()
  motionPlaying.value = true
  motionPreviewActive.value = true
}

export function pauseMotion(): void {
  controller.pause()
  motionPlaying.value = false
}

/** Stop, reset the playhead, and clear the preview so shapes return to base. */
export function stopMotion(): void {
  controller.pause()
  controller.seek(0)
  sink.reset()
  motionPlaying.value = false
  motionPreviewActive.value = false
  motionTime.value = 0
}

export function seekMotion(t: number): void {
  controller.setPivots(computePivots(motionClips.value))
  controller.seek(t)
  motionTime.value = controller.currentTime
  motionPreviewActive.value = true
}

export function setMotionLoop(loop: boolean): void {
  motionLoop.value = loop
  controller.setLoop(loop)
}
