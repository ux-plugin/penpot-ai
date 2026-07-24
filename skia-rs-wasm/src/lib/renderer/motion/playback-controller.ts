/**
 * PlaybackController — timeline playback. It owns a `Ticker` (the gated clock);
 * each frame it evaluates its timelines at the playhead and pushes the resulting
 * modifiers to a sink. `seek` renders one discrete frame for scrubbing.
 *
 * The clock itself lives in `anim/ticker` because it isn't specific to
 * timelines — the shader focus preview drives `u_time` off the same one. What's
 * here is the timeline half: evaluate → modifiers → sink.
 *
 * The clock and frame scheduler are injectable so the controller is testable
 * without a browser; they default to performance.now / requestAnimationFrame. A
 * `params` provider supplies live parameter values to param-domain bindings each
 * frame (defaults to none) — the seam the parameter panel wires into.
 */

import type { Timeline } from '../anim/types'
import { evaluateTimeline } from '../anim/evaluate'
import type { EvalContext } from '../anim/sample'
import { Ticker } from '../anim/ticker'
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
  private pivots: Map<string, Pivot>

  private readonly ticker: Ticker
  private readonly sink: ModifierSink
  private readonly getParams: () => Record<string, number>
  private readonly evaluateFrame?: (ctx: EvalContext) => Map<string, Record<string, number>> | null
  private readonly onFrame?: (timeMs: number) => void

  constructor(sink: ModifierSink, options: PlaybackOptions = {}) {
    this.sink = sink
    this.pivots = options.pivots ?? new Map()
    this.getParams = options.params ?? (() => ({}))
    this.evaluateFrame = options.evaluateFrame
    this.onFrame = options.onFrame
    this.ticker = new Ticker({
      now: options.now,
      schedule: options.schedule,
      cancel: options.cancel,
      onTick: (t) => this.renderFrame(t),
      onStop: options.onStop,
    })
  }

  get currentTime(): number {
    return this.ticker.currentTime
  }

  get duration(): number {
    return this.ticker.duration
  }

  get isPlaying(): boolean {
    return this.ticker.isPlaying
  }

  setTimelines(timelines: Timeline[]): void {
    this.timelines = timelines
    // The master duration is the longest timeline; each timeline still owns its
    // own loop/clamp. Zero (no timelines) makes the Ticker's `play` a no-op,
    // which is exactly the old empty-timeline guard.
    this.ticker.setDuration(timelines.reduce((max, t) => Math.max(max, t.duration), 0))
  }

  setLoop(loop: boolean): void {
    this.ticker.setLoop(loop)
  }

  /** Per-target rotation/scale pivot (shape centre). Recompute before play/seek. */
  setPivots(pivots: Map<string, Pivot>): void {
    this.pivots = pivots
  }

  play(): void {
    this.ticker.play()
  }

  pause(): void {
    this.ticker.pause()
  }

  /** Jump to `t` (ms) and render that frame once, without starting playback. */
  seek(t: number): void {
    this.ticker.seek(t)
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

}
