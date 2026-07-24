import { describe, expect, it } from 'vitest'
import { Ticker } from '../../../../src/lib/renderer/anim/ticker'

/**
 * A deterministic clock + scheduler. This is why `Ticker` takes `now`/`schedule`
 * /`cancel`: the whole clock is exercisable without a browser, so none of these
 * tests depend on real frames firing (which, in a hidden tab, they don't).
 */
function harness() {
  let wall = 0
  let next = 1
  const pending = new Map<number, () => void>()
  const ticks: number[] = []
  let stopped = 0

  const ticker = new Ticker({
    now: () => wall,
    schedule: (cb) => {
      const h = next++
      pending.set(h, cb)
      return h
    },
    cancel: (h) => {
      pending.delete(h)
    },
    onTick: (t) => ticks.push(t),
    onStop: () => {
      stopped++
    },
  })

  /** Advance the wall clock by `ms`, then run whatever frame was scheduled. */
  const advance = (ms: number) => {
    wall += ms
    const [h, cb] = pending.entries().next().value ?? []
    if (cb) {
      pending.delete(h!)
      cb()
    }
  }

  return {
    ticker,
    ticks,
    advance,
    get scheduled() {
      return pending.size
    },
    get stopped() {
      return stopped
    },
  }
}

describe('Ticker', () => {
  it('schedules nothing while idle — no 60fps loop when nothing animates', () => {
    const h = harness()
    h.ticker.setDuration(1000)
    expect(h.scheduled).toBe(0)
    h.ticker.play()
    expect(h.scheduled).toBe(1)
    h.ticker.pause()
    expect(h.scheduled).toBe(0)
  })

  it('advances the playhead off the wall clock', () => {
    const h = harness()
    h.ticker.setDuration(1000)
    h.ticker.play()
    h.advance(16)
    h.advance(16)
    expect(h.ticks).toEqual([16, 32])
    expect(h.ticker.currentTime).toBe(32)
  })

  it('resumes from where it paused rather than from the wall clock', () => {
    const h = harness()
    h.ticker.setDuration(1000)
    h.ticker.play()
    h.advance(100)
    h.ticker.pause()
    h.advance(5000) // wall moves on while paused; the playhead must not
    expect(h.ticker.currentTime).toBe(100)
    h.ticker.play()
    h.advance(10)
    expect(h.ticker.currentTime).toBe(110)
  })

  it('wraps when looping', () => {
    const h = harness()
    h.ticker.setDuration(100)
    h.ticker.setLoop(true)
    h.ticker.play()
    h.advance(250)
    expect(h.ticker.currentTime).toBe(50)
    expect(h.stopped).toBe(0)
  })

  it('clamps to duration and stops once when not looping', () => {
    const h = harness()
    h.ticker.setDuration(100)
    h.ticker.play()
    h.advance(250)
    expect(h.ticker.currentTime).toBe(100)
    expect(h.stopped).toBe(1)
    expect(h.ticker.isPlaying).toBe(false)
    // Stopped means stopped: no further frame was scheduled.
    expect(h.scheduled).toBe(0)
  })

  it('seek emits one frame without starting playback', () => {
    const h = harness()
    h.ticker.setDuration(1000)
    h.ticker.seek(250)
    expect(h.ticks).toEqual([250])
    expect(h.ticker.isPlaying).toBe(false)
    expect(h.scheduled).toBe(0)
  })

  it('seek normalizes out-of-range times', () => {
    const h = harness()
    h.ticker.setDuration(100)
    h.ticker.seek(-50)
    h.ticker.seek(400)
    expect(h.ticks).toEqual([0, 100]) // clamped both ends
    h.ticker.setLoop(true)
    h.ticker.seek(250)
    expect(h.ticker.currentTime).toBe(50) // wrapped
  })

  it('seeking while playing rebases the clock so time continues from there', () => {
    const h = harness()
    h.ticker.setDuration(1000)
    h.ticker.play()
    h.advance(50)
    h.ticker.seek(500)
    h.advance(10)
    expect(h.ticker.currentTime).toBe(510)
  })

  it('play is a no-op with no duration — preserves the empty-timeline guard', () => {
    const h = harness()
    h.ticker.play()
    expect(h.ticker.isPlaying).toBe(false)
    expect(h.scheduled).toBe(0)
  })
})
