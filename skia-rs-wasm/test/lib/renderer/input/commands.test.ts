import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { canvasMachine } from '@/lib/renderer/machine/canvas-machine'
import { runCommand, type CommandCtx } from '@/lib/renderer/input/commands'
import { DEFAULT_SHORTCUTS } from '@/lib/renderer/store/shortcuts-store'

/** A ctx whose viewport ops are no-ops (renderer null) — enough for tool/path commands. */
function ctxFor(actor: ReturnType<typeof createActor<typeof canvasMachine>>): CommandCtx {
  return {
    actor,
    renderer: null,
    getViewport: () => null,
    onViewportUpdate: undefined,
    zoomCenter: () => ({ x: 0, y: 0 }),
    shortcuts: DEFAULT_SHORTCUTS,
  }
}

describe('runCommand', () => {
  it('TOOL_TOGGLE activates an inactive tool, then deactivates the active one', () => {
    const a = createActor(canvasMachine).start()
    const ctx = ctxFor(a)
    runCommand({ type: 'TOOL_TOGGLE', tool: 'pen' }, ctx)
    expect(a.getSnapshot().context.drawTool).toBe('pen')
    runCommand({ type: 'TOOL_TOGGLE', tool: 'pen' }, ctx)
    expect(a.getSnapshot().context.drawTool).toBeNull()
  })

  it('TOOL_SELECT exits path editing', () => {
    const a = createActor(canvasMachine).start()
    a.send({ type: 'START_PATH_EDIT', shapeId: 's1' })
    runCommand({ type: 'TOOL_SELECT' }, ctxFor(a))
    expect(a.getSnapshot().matches('pathEditing')).toBe(false)
  })

  it('TOOL_SELECT deactivates an armed draw tool', () => {
    const a = createActor(canvasMachine).start()
    a.send({ type: 'DRAW_TOOL_ACTIVATE', tool: 'rect' })
    runCommand({ type: 'TOOL_SELECT' }, ctxFor(a))
    expect(a.getSnapshot().context.drawTool).toBeNull()
  })

  it('PATH_SUBTOOL switches the active vector-edit sub-tool', () => {
    const a = createActor(canvasMachine).start()
    a.send({ type: 'START_PATH_EDIT', shapeId: 's1' })
    runCommand({ type: 'PATH_SUBTOOL', sub: 'bend' }, ctxFor(a))
    expect(a.getSnapshot().context.pathSubTool).toBe('bend')
  })

  it('PATH_FINISH leaves vector edit', () => {
    const a = createActor(canvasMachine).start()
    a.send({ type: 'START_PATH_EDIT', shapeId: 's1' })
    runCommand({ type: 'PATH_FINISH' }, ctxFor(a))
    expect(a.getSnapshot().matches('pathEditing')).toBe(false)
  })

  it('viewport commands are safe no-ops when renderer/viewport are absent', () => {
    const a = createActor(canvasMachine).start()
    const ctx = ctxFor(a)
    expect(() => {
      runCommand({ type: 'PAN', dx: 1, dy: 0 }, ctx)
      runCommand({ type: 'ZOOM_IN' }, ctx)
      runCommand({ type: 'ZOOM_RESET' }, ctx)
    }).not.toThrow()
  })
})
