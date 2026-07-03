/**
 * EditResumeChip — the transient "get back to where I was" affordance.
 *
 * After you leave a 3D-scene edit, this offers a one-click resume so you don't have to
 * hunt the layers tree. Shows only when NOT editing and there's a remembered last-exit;
 * auto-dismisses after a while so it doesn't linger. (Tab cycles recent edits *while*
 * editing; this covers resuming *after* leaving.)
 */

import { useEffect } from 'react'
import { useSnapshot } from 'valtio'
import { useSelector } from '@xstate/react'
import { Undo2 } from 'lucide-react'
import { useCanvasActor } from '../renderer/machine/canvas-actor-context'
import { useSignalCoalesced } from '../renderer/signals/use-signal-coalesced'
import { lastExited, clearLastExited } from '../renderer/three/edit-history'
import { scene3dProxy, setFocusedObject } from '../renderer/three/scene3d-store'
import { setSelectedIds } from '../renderer/store/document-selection'

const RESUME_TIMEOUT_MS = 8000

export function EditResumeChip() {
  const actor = useCanvasActor()
  const editingSceneId = useSelector(actor, (s) => s.context.scene3dEditingId)
  const last = useSignalCoalesced(lastExited)
  const sceneSnap = useSnapshot(scene3dProxy)

  useEffect(() => {
    if (!last || editingSceneId) return
    const t = setTimeout(clearLastExited, RESUME_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [last, editingSceneId])

  if (!last || editingSceneId || !sceneSnap.scenes.has(last.targetId)) return null

  const resume = () => {
    const target = last.targetId
    const first = scene3dProxy.scenes.get(target)?.objects[0]?.id ?? null
    // Re-enter like any other enter site: select first (upholds the invariant), focus
    // the first object, drop into edit.
    setSelectedIds(new Set([target]))
    setFocusedObject(first)
    actor.send({ type: 'SCENE3D_EDIT_ENTER', sceneId: target })
    clearLastExited()
  }

  return (
    <button
      type="button"
      onClick={resume}
      className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/80 bg-white px-3 py-1.5 text-xs font-medium text-violet-700 shadow-md hover:bg-violet-50"
    >
      <Undo2 className="size-3.5" /> Resume {last.name}
    </button>
  )
}
