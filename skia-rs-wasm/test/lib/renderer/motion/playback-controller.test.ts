import { describe, expect, it } from 'vitest'
import { PlaybackController, type ModifierSink, type PlaybackOptions } from '../../../../src/lib/renderer/motion/playback-controller'
import type { Modifier } from '../../../../src/lib/renderer/motion/modifier'
import type { Timeline } from '../../../../src/lib/renderer/anim/types'

/** Manual clock + frame pump so playback is deterministic without a browser. */
function harness() {
  let now = 0
  let pending: (() => void) | null = null
  const opts = {
    now: () => now,
    schedule: (cb: () => void) => {
      pending = cb
      return 1
    },
    cancel: () => {
      pending = null
    },
  }
  return {
    opts,
    /** Advance the clock to `t` and run the pending frame, if any. */
    frame(t: number) {
      now = t
      const cb = pending
      pending = null
      cb?.()
    },
    hasPending: () => pending !== null,
  }
}

function recordingSink() {
  const calls: Array<{ id: string; mod: Modifier }> = []
  let flushes = 0
  const sink: ModifierSink = {
    apply(id, mod) {
      calls.push({ id, mod })
    },
    flush() {
      flushes++
    },
  }
  return { sink, calls, flushes: () => flushes }
}

const timelineX: Timeline = {
  id: 'tl-s1',
  duration: 1000,
  bindings: [
    {
      target: { object: { kind: 'node', id: 's1' }, prop: 'x' },
      curve: { domain: { kind: 'time' }, keys: [{ at: 0, value: 0 }, { at: 1000, value: 200 }] },
    },
  ],
}

function setup(timelines: Timeline[] = [timelineX], extra: Partial<PlaybackOptions> = {}) {
  const h = harness()
  const r = recordingSink()
  const ctrl = new PlaybackController(r.sink, { ...h.opts, ...extra })
  ctrl.setTimelines(timelines)
  return { h, r, ctrl }
}

const lastMod = (r: ReturnType<typeof recordingSink>) => r.calls[r.calls.length - 1].mod

describe('PlaybackController', () => {
  it('plays and pushes an interpolated modifier each frame', () => {
    const { h, r, ctrl } = setup()
    ctrl.play()
    expect(ctrl.isPlaying).toBe(true)
    h.frame(0)
    expect(r.calls[r.calls.length - 1].id).toBe('s1')
    expect(lastMod(r).matrix.e).toBeCloseTo(0, 6)
    h.frame(500)
    expect(lastMod(r).matrix.e).toBeCloseTo(100, 6)
    expect(h.hasPending()).toBe(true)
  })

  it('renders the final frame and stops at the end of a non-looping clip', () => {
    const { h, r, ctrl } = setup()
    ctrl.play()
    h.frame(1000)
    expect(lastMod(r).matrix.e).toBeCloseTo(200, 6)
    expect(ctrl.currentTime).toBe(1000)
    expect(ctrl.isPlaying).toBe(false)
    expect(h.hasPending()).toBe(false)
  })

  it('wraps the playhead when looping', () => {
    const { h, r, ctrl } = setup()
    ctrl.setLoop(true)
    ctrl.play()
    h.frame(1500) // 1500 mod 1000 = 500 → x = 100
    expect(ctrl.currentTime).toBeCloseTo(500, 6)
    expect(lastMod(r).matrix.e).toBeCloseTo(100, 6)
    expect(ctrl.isPlaying).toBe(true)
    expect(h.hasPending()).toBe(true)
  })

  it('pause stops scheduling and further frames are inert', () => {
    const { h, r, ctrl } = setup()
    ctrl.play()
    h.frame(200)
    const count = r.calls.length
    ctrl.pause()
    expect(ctrl.isPlaying).toBe(false)
    expect(h.hasPending()).toBe(false)
    h.frame(400)
    expect(r.calls.length).toBe(count)
  })

  it('seek renders one frame without starting playback', () => {
    const { h, r, ctrl } = setup()
    ctrl.seek(250) // x = 50
    expect(ctrl.isPlaying).toBe(false)
    expect(ctrl.currentTime).toBe(250)
    expect(lastMod(r).matrix.e).toBeCloseTo(50, 6)
    expect(h.hasPending()).toBe(false)
  })

  it('flushes once per rendered frame', () => {
    const { h, r, ctrl } = setup()
    ctrl.play()
    h.frame(0)
    h.frame(500)
    expect(r.flushes()).toBe(2)
  })

  it('applies a modifier for every clip target each frame', () => {
    const timelineO: Timeline = {
      id: 'tl-s2',
      duration: 1000,
      bindings: [
        {
          target: { object: { kind: 'node', id: 's2' }, prop: 'opacity' },
          curve: { domain: { kind: 'time' }, keys: [{ at: 0, value: 0 }, { at: 1000, value: 1 }] },
        },
      ],
    }
    const { h, r, ctrl } = setup([timelineX, timelineO])
    ctrl.play()
    h.frame(500)
    const ids = r.calls.slice(-2).map((c) => c.id).sort()
    expect(ids).toEqual(['s1', 's2'])
    expect(r.calls.find((c) => c.id === 's2')!.mod.opacity).toBeCloseTo(0.5, 6)
  })

  it('reports the playhead time via onFrame after each rendered frame', () => {
    const times: number[] = []
    const { h, ctrl } = setup([timelineX], { onFrame: (t) => times.push(t) })
    ctrl.play()
    h.frame(0)
    h.frame(300)
    expect(times).toEqual([0, 300])
  })

  it('calls onStop when a non-looping timeline reaches its end', () => {
    let stops = 0
    const { h, ctrl } = setup([timelineX], {
      onStop: () => {
        stops++
      },
    })
    ctrl.play()
    h.frame(1000)
    expect(stops).toBe(1)
    expect(ctrl.isPlaying).toBe(false)
  })
})
