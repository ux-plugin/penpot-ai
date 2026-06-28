import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { canvasMachine } from '../../../../src/lib/renderer/machine/canvas-machine'

/** Start an actor already inside path editing on `shapeId`. */
function editing(shapeId = 's1') {
  const actor = createActor(canvasMachine).start()
  actor.send({ type: 'START_PATH_EDIT', shapeId })
  return actor
}

describe('canvas-machine — pathEditing (Phase B: sub-tool in context, flat activity)', () => {
  it('START_PATH_EDIT enters pathEditing.idle on Move with the shape and no draft', () => {
    const a = editing('abc')
    const s = a.getSnapshot()
    expect(s.matches({ pathEditing: 'idle' })).toBe(true)
    expect(s.context.pathEditingShapeId).toBe('abc')
    expect(s.context.pathDraftFromNode).toBeNull()
    expect(s.context.pathSubTool).toBe('move')
  })

  it('grab a node → dragging → pointer up → idle', () => {
    const a = editing()
    a.send({ type: 'PATH_GRAB_NODE', node: 2 })
    expect(a.getSnapshot().matches({ pathEditing: 'dragging' })).toBe(true)
    a.send({ type: 'PATH_POINTER_UP' })
    expect(a.getSnapshot().matches({ pathEditing: 'idle' })).toBe(true)
  })

  it('grab a handle → dragging → cancel → idle', () => {
    const a = editing()
    a.send({ type: 'PATH_GRAB_HANDLE', node: 0, side: 'out' })
    expect(a.getSnapshot().matches({ pathEditing: 'dragging' })).toBe(true)
    a.send({ type: 'PATH_CANCEL' })
    expect(a.getSnapshot().matches({ pathEditing: 'idle' })).toBe(true)
  })

  it('PATH_SET_SUBTOOL switches Move / Add / Bend without leaving idle', () => {
    const a = editing()
    a.send({ type: 'PATH_SET_SUBTOOL', subTool: 'add' })
    expect(a.getSnapshot().context.pathSubTool).toBe('add')
    expect(a.getSnapshot().matches({ pathEditing: 'idle' })).toBe(true)
    a.send({ type: 'PATH_SET_SUBTOOL', subTool: 'bend' })
    expect(a.getSnapshot().context.pathSubTool).toBe('bend')
    a.send({ type: 'PATH_SET_SUBTOOL', subTool: 'move' })
    expect(a.getSnapshot().context.pathSubTool).toBe('move')
  })

  it('Add: pen-down → placing → pointer up → idle', () => {
    const a = editing()
    a.send({ type: 'PATH_SET_SUBTOOL', subTool: 'add' })
    a.send({ type: 'PATH_PEN_DOWN' })
    expect(a.getSnapshot().matches({ pathEditing: 'placing' })).toBe(true)
    a.send({ type: 'PATH_POINTER_UP' })
    expect(a.getSnapshot().matches({ pathEditing: 'idle' })).toBe(true)
  })

  it('PATH_SET_DRAFT_FROM tracks the pen current point and clears on cancel', () => {
    const a = editing()
    a.send({ type: 'PATH_SET_SUBTOOL', subTool: 'add' })
    a.send({ type: 'PATH_SET_DRAFT_FROM', node: 5 })
    expect(a.getSnapshot().context.pathDraftFromNode).toBe(5)
    a.send({ type: 'PATH_CANCEL' })
    const s = a.getSnapshot()
    expect(s.matches({ pathEditing: 'idle' })).toBe(true)
    expect(s.context.pathDraftFromNode).toBeNull()
  })

  it('STOP_PATH_EDIT exits to idle, clears context, and drops the tool (back to Select)', () => {
    const a = createActor(canvasMachine).start()
    a.send({ type: 'DRAW_TOOL_ACTIVATE', tool: 'pen' })
    a.send({ type: 'START_PATH_EDIT', shapeId: 'z' })
    a.send({ type: 'PATH_SET_SUBTOOL', subTool: 'add' })
    a.send({ type: 'PATH_SET_DRAFT_FROM', node: 3 })
    a.send({ type: 'STOP_PATH_EDIT' })
    const s = a.getSnapshot()
    expect(s.matches('idle')).toBe(true)
    expect(s.context.pathEditingShapeId).toBeNull()
    expect(s.context.pathDraftFromNode).toBeNull()
    expect(s.context.drawTool).toBeNull()
  })

  it('switching shapes mid-edit resets to idle on Move and clears the draft', () => {
    const a = editing('first')
    a.send({ type: 'PATH_SET_SUBTOOL', subTool: 'add' })
    a.send({ type: 'PATH_SET_DRAFT_FROM', node: 9 })
    a.send({ type: 'START_PATH_EDIT', shapeId: 'second' })
    const s = a.getSnapshot()
    expect(s.matches({ pathEditing: 'idle' })).toBe(true)
    expect(s.context.pathEditingShapeId).toBe('second')
    expect(s.context.pathDraftFromNode).toBeNull()
    expect(s.context.pathSubTool).toBe('move')
  })
})
