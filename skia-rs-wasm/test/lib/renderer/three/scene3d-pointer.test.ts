import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createActor } from 'xstate'
import { canvasMachine } from '@/lib/renderer/machine/canvas-machine'
import { resolveScene3dPointerDown } from '@/lib/renderer/three/scene3d-pointer'
import {
  scene3dProxy,
  setFocusedObject,
  type Scene3DInstance,
} from '@/lib/renderer/three/scene3d-store'

// The resolver only forwards the instance to `pick` (and null-checks it), so a bare
// stand-in is enough — no real three.js scene needed.
const fakeInstance = {} as Scene3DInstance

function editingActor() {
  const a = createActor(canvasMachine).start()
  a.send({ type: 'SCENE3D_EDIT_ENTER', sceneId: 's1' })
  return a
}

describe('resolveScene3dPointerDown', () => {
  beforeEach(() => setFocusedObject(null))

  it('is inactive (no pick, no focus change) when not in 3D-edit mode', () => {
    const a = createActor(canvasMachine).start()
    const pick = vi.fn(() => 'obj1')
    const out = resolveScene3dPointerDown(0, 0, { actor: a, instance: fakeInstance, gizmoActive: false, pick })
    expect(out).toBe('inactive')
    expect(pick).not.toHaveBeenCalled()
    expect(scene3dProxy.focusedObjectId).toBeNull()
  })

  it('yields to the gizmo when a handle is engaged (skips the raycast)', () => {
    const pick = vi.fn(() => 'obj1')
    const out = resolveScene3dPointerDown(0, 0, { actor: editingActor(), instance: fakeInstance, gizmoActive: true, pick })
    expect(out).toBe('gizmo')
    expect(pick).not.toHaveBeenCalled()
  })

  it('focuses the hit object', () => {
    const out = resolveScene3dPointerDown(0.1, -0.2, {
      actor: editingActor(),
      instance: fakeInstance,
      gizmoActive: false,
      pick: () => 'cube-7',
    })
    expect(out).toBe('focus')
    expect(scene3dProxy.focusedObjectId).toBe('cube-7')
  })

  it('orbits and leaves focus untouched on empty space', () => {
    setFocusedObject('prev')
    const out = resolveScene3dPointerDown(0, 0, {
      actor: editingActor(),
      instance: fakeInstance,
      gizmoActive: false,
      pick: () => null,
    })
    expect(out).toBe('orbit')
    expect(scene3dProxy.focusedObjectId).toBe('prev')
  })

  it('orbits (no raycast) when the instance is not built yet', () => {
    const pick = vi.fn(() => 'obj1')
    const out = resolveScene3dPointerDown(0, 0, { actor: editingActor(), instance: null, gizmoActive: false, pick })
    expect(out).toBe('orbit')
    expect(pick).not.toHaveBeenCalled()
  })
})
