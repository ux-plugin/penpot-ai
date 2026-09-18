/**
 * Ticker — a gated animation clock.
 *
 * While playing it advances a playhead off a wall clock and calls `onTick` each
 * frame; while idle it schedules nothing (no 60fps loop when nothing animates).
 * `seek` moves the playhead and emits one discrete frame, for scrubbing.
 *
 * This is the clock extracted from `PlaybackController`, which is really a
 * *timeline evaluator with a clock inside*. Motion drives shape modifiers per
 * frame; the shader focus preview drives `u_time`. Same clock, different work —
 * so the clock lives here and each consumer supplies `onTick`.
 *
 * The clock and frame scheduler are injectable so it's testable without a
 * browser (see `test/lib/renderer/anim/ticker.test.ts`); they default to
 * performance.now / requestAnimationFrame.
 *
 * **Time is bounded on purpose.** `u_time` reaches shaders as an f32, whose
 * 24-bit mantissa loses resolution as the playhead grows — a free-running
 * clock visibly quantizes after a few hours. A duration also gives scrubbing a
 * range and makes a frame reproducible. Wrapping does mean a discontinuity at
 * the loop point unless the animation's period divides `duration` — which is
 * the authoring goal (a seamless loop), not a defect.
 */

export interface TickerOptions {
  now?: () => number
  schedule?: (cb: () => void) => number
  cancel?: (handle: number) => void
  /** Invoked for every rendered frame (play or seek) with the playhead time. */
  onTick: (timeMs: number) => void
  /** Invoked when a non-looping run reaches `duration` and stops. */
  onStop?: () => void
}

export class Ticker {
  private durationMs = 0
  private timeMs = 0
  private playing = false
  private startWall = 0
  private handle: number | null = null
  private loopEnabled = false

  private readonly now: () => number
  private readonly schedule: (cb: () => void) => number
  private readonly cancel: (handle: number) => void
  private readonly onTick: (timeMs: number) => void
  private readonly onStop?: () => void

  constructor(options: TickerOptions) {
    this.now = options.now ?? (() => performance.now())
    this.schedule = options.schedule ?? ((cb) => requestAnimationFrame(cb))
    this.cancel = options.cancel ?? ((h) => cancelAnimationFrame(h))
    this.onTick = options.onTick
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

  setDuration(durationMs: number): void {
    this.durationMs = durationMs
  }

  setLoop(loop: boolean): void {
    this.loopEnabled = loop
  }

  /** Start advancing. No-op when already playing or when there's no duration. */
  play(): void {
    if (this.playing || this.durationMs <= 0) return
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

  /** Jump to `t` (ms) and emit that frame once, without starting playback. */
  seek(t: number): void {
    this.timeMs = this.normalize(t)
    if (this.playing) this.startWall = this.now() - this.timeMs
    this.onTick(this.timeMs)
  }

  private tick = (): void => {
    if (!this.playing) return
    const raw = this.now() - this.startWall
    if (!this.loopEnabled && raw >= this.durationMs) {
      this.timeMs = this.durationMs
      this.onTick(this.timeMs)
      this.playing = false
      this.handle = null
      this.onStop?.()
      return
    }
    this.timeMs = this.normalize(raw)
    this.onTick(this.timeMs)
    this.handle = this.schedule(this.tick)
  }

  /** Clamp (or wrap when looping) a master time into range. */
  private normalize(t: number): number {
    if (this.durationMs <= 0) return 0
    if (this.loopEnabled) {
      const m = t % this.durationMs
      return m < 0 ? m + this.durationMs : m
    }
    return Math.max(0, Math.min(t, this.durationMs))
  }
}
