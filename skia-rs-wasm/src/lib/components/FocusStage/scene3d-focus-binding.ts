/**
 * scene3d-focus-binding — makes 3D-edit mode a citizen of the single `focusStage`
 * slot, so it can't coexist with another focus mode (the shader stage, etc.).
 *
 * 3D edit's authoritative state stays in the canvasMachine (`scene3dEditingId`) —
 * this only mirrors that state into the focus slot:
 *
 *   machine enters 3D edit  → open a `scene-3d` session (shared header only)
 *   machine leaves 3D edit  → close it
 *   another session opens    → its eviction fires our `onExit`, which tells the
 *                              machine to leave 3D edit
 *
 * The session declares no `center`/rails/`undoScope`: 3D keeps its own canvas
 * overlay, floating toolbar and undo untouched. It contributes only the shared
 * `FocusStage` header (title + exit), so the header reads the same as every other
 * focus mode. See [[project_3d_canvas_spline]].
 */

import { useEffect } from 'react'
import { useCanvasActor } from '../../renderer/machine/canvas-actor-context'
import { openFocusStage, closeFocusStage, focusStage } from '../../renderer/signals/focus-stage'

const SCENE3D_STAGE_ID = 'scene-3d'

// A fixed title (not the scene's name) on purpose: the machine can switch which
// scene is edited without leaving 3D-edit (scene cycling), and re-opening the
// session to refresh a per-scene title would fire the old session's `onExit` and
// tear edit mode down. A constant is always correct and matches the shader
// stage's generic header.
function openScene3dSession(onExit: () => void): void {
  openFocusStage({ id: SCENE3D_STAGE_ID, title: '3D scene', onExit })
}

/**
 * Mount ONCE inside the canvas-actor provider. Subscribes to `scene3dEditingId`
 * and keeps the focus slot in step with it. Guards keep the machine↔slot loop
 * from cycling: we only open when the slot isn't already ours, only close when it
 * still is, and `onExit` only re-sends EXIT when the machine is actually editing.
 */
export function useScene3dFocusStageBinding(): void {
  const actor = useCanvasActor()
  useEffect(() => {
    const exitMachine = () => {
      if (actor.getSnapshot().context.scene3dEditingId) {
        actor.send({ type: 'SCENE3D_EDIT_EXIT' })
      }
    }
    const sync = (editingId: string | null) => {
      const stageOpen = focusStage.peek()?.id === SCENE3D_STAGE_ID
      if (editingId && !stageOpen) openScene3dSession(exitMachine)
      else if (!editingId && stageOpen) closeFocusStage()
    }

    let prev = actor.getSnapshot().context.scene3dEditingId
    sync(prev) // reconcile any edit already in progress at mount
    const sub = actor.subscribe((s) => {
      const cur = s.context.scene3dEditingId
      if (cur === prev) return
      prev = cur
      sync(cur)
    })
    return () => sub.unsubscribe()
  }, [actor])
}
