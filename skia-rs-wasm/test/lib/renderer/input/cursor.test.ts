import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { canvasMachine } from '@/lib/renderer/machine/canvas-machine'
import { resolveCanvasCursor } from '@/lib/renderer/input/cursor'
import { PEN_CURSOR, SELECT_CURSOR } from '@/lib/components/cursors'

const noMods = { alt: false, panHeld: false }

function snap(send: ((a: ReturnType<typeof createActor<typeof canvasMachine>>) => void) | null = null) {
  const a = createActor(canvasMachine).start()
  send?.(a)
  return a.getSnapshot()
}

describe('resolveCanvasCursor', () => {
  it('idle selection → arrow; pan modifier held → grab', () => {
    expect(resolveCanvasCursor(snap(), noMods, null)).toBe(SELECT_CURSOR)
    expect(resolveCanvasCursor(snap(), { alt: false, panHeld: true }, null)).toBe('grab')
  })

  it('pen draw tool → nib cursor', () => {
    const s = snap((a) => a.send({ type: 'DRAW_TOOL_ACTIVATE', tool: 'pen' }))
    expect(resolveCanvasCursor(s, noMods, null)).toBe(PEN_CURSOR)
  })

  it('non-pen draw tool → crosshair', () => {
    const s = snap((a) => a.send({ type: 'DRAW_TOOL_ACTIVATE', tool: 'rect' }))
    expect(resolveCanvasCursor(s, noMods, null)).toBe('crosshair')
  })

  it('path editing Add → nib; Add + Alt → arrow (transient Bend)', () => {
    const s = snap((a) => {
      a.send({ type: 'START_PATH_EDIT', shapeId: 's1' })
      a.send({ type: 'PATH_SET_SUBTOOL', subTool: 'add' })
    })
    expect(resolveCanvasCursor(s, noMods, null)).toBe(PEN_CURSOR)
    expect(resolveCanvasCursor(s, { alt: true, panHeld: false }, null)).toBe(SELECT_CURSOR)
  })

  it('path editing Move → arrow', () => {
    const s = snap((a) => a.send({ type: 'START_PATH_EDIT', shapeId: 's1' }))
    expect(resolveCanvasCursor(s, noMods, null)).toBe(SELECT_CURSOR)
  })
})
