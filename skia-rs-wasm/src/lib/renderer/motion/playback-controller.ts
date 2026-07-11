/**
 * PlaybackController — a gated animation clock. While playing it advances a
 * playhead off a wall clock, evaluates its timelines each frame, and pushes the
 * resulting modifiers to a sink; while idle it schedules nothing (no 60fps loop
 * when nothing animates). `seek` renders one discrete frame for scrubbing.
 *
 * The clock and frame scheduler are injectable so the controller is testable
 * without a browser; they default to performance.now / requestAnimationFrame. A
 * `params` provider supplies live parameter values to param-domain bindings each
 * frame (defaults to none) — the seam the parameter panel wires into.
 */

import type { Timeline } from '../anim/types'
import { evaluateTimeline } from '../anim/evaluate'
import type { EvalContext } from '../anim/sample'
import { propsToModifier, type Modifier, type Pivot } from './modifier'
import type { SampledProperties } from './props'

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
  /** Live parameter values for param-domain bindings. Read fresh each frame. */
  params?: () => Record<string, number>
  /** Optional frame evaluator (e.g. the Rust runtime). Returns null to fall back to the TS engine. */
  evaluateFrame?: (ctx: EvalContext) => Map<string, Record<string, number>> | null
  /** Invoked after every rendered frame (play or seek) with the playhead time. */
  onFrame?: (timeMs: number) => void
  /** Invoked when a non-looping timeline reaches its end and stops. */
  onStop?: () => void
}

export class PlaybackController {
  private timelines: Timeline[] = []
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
  private readonly getParams: () => Record<string, number>
  private readonly evaluateFrame?: (ctx: EvalContext) => Map<string, Record<string, number>> | null
  private readonly onFrame?: (timeMs: number) => void
  private readonly onStop?: () => void

  constructor(sink: ModifierSink, options: PlaybackOptions = {}) {
    this.sink = sink
    this.now = options.now ?? (() => performance.now())
    this.schedule = options.schedule ?? ((cb) => requestAnimationFrame(cb))
    this.cancel = options.cancel ?? ((h) => cancelAnimationFrame(h))
    this.pivots = options.pivots ?? new Map()
    this.getParams = options.params ?? (() => ({}))
    this.evaluateFrame = options.evaluateFrame
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

  setTimelines(timelines: Timeline[]): void {
    this.timelines = timelines
    this.durationMs = timelines.reduce((max, t) => Math.max(max, t.duration), 0)
  }

  setLoop(loop: boolean): void {
    this.loopEnabled = loop
  }

  /** Per-target rotation/scale pivot (shape centre). Recompute before play/seek. */
  setPivots(pivots: Map<string, Pivot>): void {
    this.pivots = pivots
  }

  play(): void {
    if (this.playing || this.timelines.length === 0) return
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
    // Evaluate the frame: the Rust runtime when it's wired (evaluateFrame returns
    // a map), else the TS engine. Each timeline owns its own loop/clamp; this
    // master clock only decides when a non-looping run stops. Sampled values are
    // deltas from the rest pose, so they feed the modifier directly.
    const ctx: EvalContext = { time: t, params: this.getParams() }
    const bags = (this.evaluateFrame && this.evaluateFrame(ctx)) || this.evaluateTimelinesTs(ctx)
    for (const [nodeId, props] of bags) {
      this.sink.apply(nodeId, propsToModifier(props as SampledProperties, this.pivots.get(nodeId)))
    }
    this.sink.flush?.()
    this.onFrame?.(t)
  }

  /** The TS evaluation path: merge every timeline's writes for this context. */
  private evaluateTimelinesTs(ctx: EvalContext): Map<string, Record<string, number>> {
    const out = new Map<string, Record<string, number>>()
    for (const timeline of this.timelines) {
      for (const [nodeId, props] of evaluateTimeline(timeline, ctx)) {
        const existing = out.get(nodeId)
        if (existing) Object.assign(existing, props)
        else out.set(nodeId, { ...props })
      }
    }
    return out
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
