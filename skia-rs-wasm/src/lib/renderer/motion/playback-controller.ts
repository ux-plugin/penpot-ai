/**
 * PlaybackController — a gated animation clock. While playing it advances a
 * playhead off a wall clock, samples its clips each frame, and pushes the
 * resulting modifiers to a sink; while idle it schedules nothing (no 60fps loop
 * when nothing animates). `seek` renders one discrete frame for scrubbing.
 *
 * The clock and frame scheduler are injectable so the controller is testable
 * without a browser; they default to performance.now / requestAnimationFrame.
 */

import type { Clip } from './types'
import { sampleClip } from './sampler'
import { propsToModifier, type Modifier, type Pivot } from './modifier'

/** Where sampled modifiers go — e.g. the WASM bridge (setWasmModifiers + flush). */
export interface ModifierSink {
  apply(targetId: string, modifier: Modifier): void
  /** Called once after all of a frame's modifiers are applied, if provided. */
  flush?(): void
}

export interface PlaybackOptions {
  now?: () => number
  schedule?: (cb: () => void) => number
  cancel?: (handle: number) => void
  /** Rotation/scale pivot per target (e.g. shape centre). Defaults to origin. */
  pivots?: Map<string, Pivot>
  /** Invoked after every rendered frame (play or seek) with the playhead time. */
  onFrame?: (timeMs: number) => void
  /** Invoked when a non-looping timeline reaches its end and stops. */
  onStop?: () => void
}

export class PlaybackController {
  private clips: Clip[] = []
  private durationMs = 0
  private timeMs = 0
  private playing = false
  private startWall = 0
  private handle: number | null = null
  private loopEnabled = false
  private pivots: Map<string, Pivot>

  private readonly sink: ModifierSink
  private readonly now: () => number
  private readonly schedule: (cb: () => void) => number
  private readonly cancel: (handle: number) => void
  private readonly onFrame?: (timeMs: number) => void
  private readonly onStop?: () => void

  constructor(sink: ModifierSink, options: PlaybackOptions = {}) {
    this.sink = sink
    this.now = options.now ?? (() => performance.now())
    this.schedule = options.schedule ?? ((cb) => requestAnimationFrame(cb))
    this.cancel = options.cancel ?? ((h) => cancelAnimationFrame(h))
    this.pivots = options.pivots ?? new Map()
    this.onFrame = options.onFrame
    this.onStop = options.onStop
  }

  get currentTime(): number {
    return this.timeMs
  }

  get duration(): number {
    return this.durationMs
  }

  get isPlaying(): boolean {
    return this.playing
  }

  setClips(clips: Clip[]): void {
    this.clips = clips
    this.durationMs = clips.reduce((max, c) => Math.max(max, c.duration), 0)
  }

  setLoop(loop: boolean): void {
    this.loopEnabled = loop
  }

  /** Per-target rotation/scale pivot (shape centre). Recompute before play/seek. */
  setPivots(pivots: Map<string, Pivot>): void {
    this.pivots = pivots
  }

  play(): void {
    if (this.playing || this.clips.length === 0) return
    this.playing = true
    this.startWall = this.now() - this.timeMs
    this.handle = this.schedule(this.tick)
  }

  pause(): void {
    if (!this.playing) return
    this.playing = false
    if (this.handle !== null) {
      this.cancel(this.handle)
      this.handle = null
    }
  }

  /** Jump to `t` (ms) and render that frame once, without starting playback. */
  seek(t: number): void {
    this.timeMs = this.normalize(t)
    if (this.playing) this.startWall = this.now() - this.timeMs
    this.renderFrame(this.timeMs)
  }

  private tick = (): void => {
    if (!this.playing) return
    const raw = this.now() - this.startWall
    if (!this.loopEnabled && raw >= this.durationMs) {
      this.timeMs = this.durationMs
      this.renderFrame(this.timeMs)
      this.playing = false
      this.handle = null
      this.onStop?.()
      return
    }
    this.timeMs = this.normalize(raw)
    this.renderFrame(this.timeMs)
    this.handle = this.schedule(this.tick)
  }

  private renderFrame(t: number): void {
    for (const clip of this.clips) {
      const props = sampleClip(clip, t)
      this.sink.apply(clip.targetId, propsToModifier(props, this.pivots.get(clip.targetId)))
    }
    this.sink.flush?.()
    this.onFrame?.(t)
  }

  /** Clamp (or wrap when looping) a master time into the timeline range. */
  private normalize(t: number): number {
    if (this.durationMs <= 0) return 0
    if (this.loopEnabled) {
      const m = t % this.durationMs
      return m < 0 ? m + this.durationMs : m
    }
    return Math.max(0, Math.min(t, this.durationMs))
  }
}
