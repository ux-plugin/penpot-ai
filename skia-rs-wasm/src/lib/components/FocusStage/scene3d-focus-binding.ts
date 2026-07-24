/**
 * scene3d-focus-binding — makes 3D-edit mode a citizen of the single `focusStage`
 * slot, so it can't coexist with another focus mode (the shader stage, etc.).
 *
 * 3D edit's authoritative state stays in the canvasMachine (`scene3dEditingId`) —
 * this only mirrors that state into the focus slot:
 *
 *   machine enters 3D edit  → open a `scene-3d` session + focus sub-history buffer
 *   machine leaves 3D edit  → close it, folding the session's edits into one entry
 *   another session opens    → its eviction fires our `onExit`, which tells the
 *                              machine to leave 3D edit
 *
 * The session declares no `center`/rails: 3D keeps its own canvas overlay and
 * floating toolbar. It contributes the shared `FocusStage` header (title + exit),
 * plus a focus sub-history buffer: while editing, Cmd+Z steps through the 3D
 * sub-edits, and on exit the whole session folds into ONE canvas undo entry (the
 * same collapse-on-exit as the shader stage — 3D commits through the same
 * `commitNodePartialUpdate` pipeline, so the open buffer captures them with no
 * 3D-specific plumbing). See [[project_3d_canvas_spline]] and [[project_undo_model]].
 */

import { useEffect } from 'react'
import { useCanvasActor } from '../../renderer/machine/canvas-actor-context'
import { openFocusStage, closeFocusStage, focusStage } from '../../renderer/signals/focus-stage'
import { beginFocusBuffer, endFocusBuffer } from '../../history/history-store'

const SCENE3D_STAGE_ID = 'scene-3d'

/** Per-open session counter — each 3D edit session labels its one folded entry. */
let SCENE3D_SESSION_SEQ = 0

// A fixed title (not the scene's name) on purpose: the machine can switch which
// scene is edited without leaving 3D-edit (scene cycling), and re-opening the
// session to refresh a per-scene title would fire the old session's `onExit` and
// tear edit mode down. A constant is always correct and matches the shader
// stage's generic header.
function openScene3dSession(exitMachine: () => void): void {
  // Open the stage FIRST so a replaced session's `onExit` (folding ITS buffer)
  // runs before we open ours; then open the 3D sub-history buffer.
  openFocusStage({
    id: SCENE3D_STAGE_ID,
    title: '3D scene',
    // Every exit path (explicit EXIT, eviction, mousedown-off-scene) funnels
    // here exactly once: leave edit mode AND fold the session's edits into one
    // canvas undo entry.
    onExit: () => {
      exitMachine()
      endFocusBuffer()
    },
  })
  beginFocusBuffer(`scene-3d:${(SCENE3D_SESSION_SEQ += 1)}`)
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
