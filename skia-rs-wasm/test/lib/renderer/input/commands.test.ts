import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { canvasMachine } from '@/lib/renderer/machine/canvas-machine'
import { runCommand, type CommandCtx } from '@/lib/renderer/input/commands'
import { DEFAULT_SHORTCUTS } from '@/lib/renderer/store/shortcuts-store'
import { sceneFrameViewRequest, setFocusedObject, scene3dProxy } from '@/lib/renderer/three/scene3d-store'

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

  it('SCENE3D_GIZMO switches the gizmo sub-tool', () => {
    const a = createActor(canvasMachine).start()
    a.send({ type: 'SCENE3D_EDIT_ENTER', sceneId: 's1' })
    runCommand({ type: 'SCENE3D_GIZMO', mode: 'scale' }, ctxFor(a))
    expect(a.getSnapshot().context.scene3dGizmoMode).toBe('scale')
  })

  it('SCENE3D_EXIT and TOOL_SELECT both leave 3D-scene editing', () => {
    const a = createActor(canvasMachine).start()
    a.send({ type: 'SCENE3D_EDIT_ENTER', sceneId: 's1' })
    runCommand({ type: 'SCENE3D_EXIT' }, ctxFor(a))
    expect(a.getSnapshot().matches('scene3dEditing')).toBe(false)
    a.send({ type: 'SCENE3D_EDIT_ENTER', sceneId: 's2' })
    runCommand({ type: 'TOOL_SELECT' }, ctxFor(a))
    expect(a.getSnapshot().matches('scene3dEditing')).toBe(false)
  })

  it('SCENE3D_FRAME_VIEW bumps the frame-view request signal', () => {
    const before = sceneFrameViewRequest.value
    runCommand({ type: 'SCENE3D_FRAME_VIEW' }, ctxFor(createActor(canvasMachine).start()))
    expect(sceneFrameViewRequest.value).toBe(before + 1)
  })

  it('DELETE_SELECTION is a safe no-op with no active page', () => {
    const a = createActor(canvasMachine).start()
    expect(() => runCommand({ type: 'DELETE_SELECTION' }, ctxFor(a))).not.toThrow()
  })

  it('SCENE3D_DELETE clears the focused object (safe no-op without a doc)', () => {
    const a = createActor(canvasMachine).start()
    a.send({ type: 'SCENE3D_EDIT_ENTER', sceneId: 's1' })
    setFocusedObject('cube-1')
    expect(() => runCommand({ type: 'SCENE3D_DELETE' }, ctxFor(a))).not.toThrow()
    expect(scene3dProxy.focusedObjectId).toBeNull()
  })

  it('SCENE3D_RECENTER is a safe no-op without a renderer/canvas', () => {
    const a = createActor(canvasMachine).start()
    a.send({ type: 'SCENE3D_EDIT_ENTER', sceneId: 's1' })
    expect(() => runCommand({ type: 'SCENE3D_RECENTER' }, ctxFor(a))).not.toThrow()
  })
})
