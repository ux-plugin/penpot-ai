/**
 * useScene3dEditing — the React surface over the `scene3dEditing` canvasMachine state.
 *
 * 3D-edit mode (and which scene is being edited + the gizmo sub-tool) lives in the
 * canvas machine, beside `pathEditing`, so it's one-mode-at-a-time and the bottom
 * toolbar can react to `s.matches('scene3dEditing')`. The focused object within the
 * scene is overlay state (`scene3dProxy`), set here alongside the machine events so
 * callers get one coordinated entry point.
 */

import { useCallback } from 'react'
import { useSelector } from '@xstate/react'
import { useCanvasActor } from '../machine/canvas-actor-context'
import type { Scene3DGizmoMode } from '../machine/canvas-machine'
import { setFocusedObject } from './scene3d-store'

export function useScene3dEditing() {
  const actor = useCanvasActor()
  const editingSceneId = useSelector(actor, (s) => s.context.scene3dEditingId)
  const gizmoMode = useSelector(actor, (s) => s.context.scene3dGizmoMode)

  const enter = useCallback(
    (sceneId: string, focusObjectId: string | null = null) => {
      actor.send({ type: 'SCENE3D_EDIT_ENTER', sceneId })
      setFocusedObject(focusObjectId)
    },
    [actor],
  )
  const exit = useCallback(() => {
    actor.send({ type: 'SCENE3D_EDIT_EXIT' })
    setFocusedObject(null)
  }, [actor])
  const setGizmo = useCallback(
    (mode: Scene3DGizmoMode) => actor.send({ type: 'SCENE3D_SET_GIZMO', mode }),
    [actor],
  )

  return { actor, editingSceneId, gizmoMode, enter, exit, setGizmo }
}
