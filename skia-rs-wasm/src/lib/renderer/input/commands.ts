/**
 * Command model — the discrete canvas intents that keyboard (and, where simple,
 * mouse) bindings resolve to. A Command is plain data; `runCommand` is the ONE
 * place that maps each intent to machine events / viewport ops. Keeping the intent
 * (what the user asked for) separate from the effect (how it's applied) is what
 * lets a new shortcut be a single row in the bindings table instead of another
 * branch in an if/else ladder (see input/key-bindings.ts).
 *
 * Cursor is deliberately NOT a command side effect: it's derived reactively from
 * machine + modifier state by input/cursor.ts, so commands only move the model.
 */

import { Viewport, type ViewportData } from '../viewport'
import type { Renderer } from '../renderer'
import type { CanvasActorRef } from '../machine/canvas-actor-types'
import type { DrawTool, PathSubTool, Scene3DGizmoMode } from '../machine/canvas-machine'
import type { ShortcutsConfig } from '../types'
import { requestSceneFrameView, setFocusedObject, scene3dProxy } from '../three/scene3d-store'
import { commitRemoveObject } from '../three/scene3d-commit'
import { deleteSelectedNodes } from '../handlers/delete-selection'

export type Command =
  // Toolbar tools (toggle: pressing the active tool's key turns it off).
  | { type: 'TOOL_TOGGLE'; tool: DrawTool }
  // Select tool (V): leave the current draw tool / path edit, back to selection.
  | { type: 'TOOL_SELECT' }
  // Vector-edit sub-tool while in pathEditing (Move / Add / Bend).
  | { type: 'PATH_SUBTOOL'; sub: PathSubTool }
  // Finish vector edit (Esc / Enter) — back to Select.
  | { type: 'PATH_FINISH' }
  // Cancel an armed draw tool (Esc).
  | { type: 'DRAW_CANCEL' }
  // Viewport: pan by unit direction (× panStep), zoom about centre, reset.
  | { type: 'PAN'; dx: number; dy: number }
  | { type: 'ZOOM_IN' }
  | { type: 'ZOOM_OUT' }
  | { type: 'ZOOM_RESET' }
  // Delete the current selection (Backspace / Delete).
  | { type: 'DELETE_SELECTION' }
  // 3D-scene editing: switch the gizmo sub-tool, frame/reset the view, delete the
  // focused object, or leave.
  | { type: 'SCENE3D_GIZMO'; mode: Scene3DGizmoMode }
  | { type: 'SCENE3D_FRAME_VIEW' }
  | { type: 'SCENE3D_DELETE' }
  | { type: 'SCENE3D_EXIT' }

export interface CommandCtx {
  actor: CanvasActorRef
  renderer: Renderer | null
  /** Current viewport data (null before first frame). */
  getViewport: () => ViewportData | null
  /** Push a new viewport after a pan/zoom (consumer updates the store). */
  onViewportUpdate?: (next: Viewport) => void
  /** Zoom-about point in surface-local px (usually the surface centre). */
  zoomCenter: () => { x: number; y: number } | null
  shortcuts: ShortcutsConfig
}

function applyViewport(ctx: CommandCtx, mutate: (v: Viewport) => void): void {
  const vp = ctx.getViewport()
  if (!vp || !ctx.renderer) return
  const next = Viewport.from(vp)
  mutate(next)
  ctx.renderer.applyViewport(next)
  ctx.onViewportUpdate?.(next)
}

/** Apply one command's effect. Pure routing — no cursor, no DOM. */
export function runCommand(cmd: Command, ctx: CommandCtx): void {
  const { actor } = ctx
  switch (cmd.type) {
    case 'TOOL_TOGGLE': {
      const active = actor.getSnapshot().context.drawTool === cmd.tool
      actor.send(active ? { type: 'DRAW_TOOL_DEACTIVATE' } : { type: 'DRAW_TOOL_ACTIVATE', tool: cmd.tool })
      return
    }
    case 'TOOL_SELECT': {
      const snap = actor.getSnapshot()
      if (snap.matches('pathEditing')) actor.send({ type: 'STOP_PATH_EDIT' })
      else if (snap.matches('scene3dEditing')) actor.send({ type: 'SCENE3D_EDIT_EXIT' })
      else if (snap.context.drawTool != null) actor.send({ type: 'DRAW_TOOL_DEACTIVATE' })
      return
    }
    case 'PATH_SUBTOOL':
      actor.send({ type: 'PATH_SET_SUBTOOL', subTool: cmd.sub })
      return
    case 'PATH_FINISH':
      actor.send({ type: 'STOP_PATH_EDIT' })
      return
    case 'DRAW_CANCEL':
      actor.send({ type: 'DRAW_TOOL_DEACTIVATE' })
      return
    case 'PAN': {
      const step = ctx.shortcuts.panStep
      applyViewport(ctx, (v) => v.pan(cmd.dx * step, cmd.dy * step))
      return
    }
    case 'ZOOM_IN':
    case 'ZOOM_OUT': {
      const c = ctx.zoomCenter()
      if (!c) return
      const factor = cmd.type === 'ZOOM_IN' ? ctx.shortcuts.zoomInFactor : ctx.shortcuts.zoomOutFactor
      applyViewport(ctx, (v) => v.zoomAt(c, factor))
      return
    }
    case 'ZOOM_RESET':
      applyViewport(ctx, (v) => v.reset())
      return
    case 'DELETE_SELECTION':
      void deleteSelectedNodes()
      return
    case 'SCENE3D_GIZMO':
      actor.send({ type: 'SCENE3D_SET_GIZMO', mode: cmd.mode })
      return
    case 'SCENE3D_FRAME_VIEW':
      // View pose isn't machine state (like dolly/pan); nudge the overlay to refit.
      requestSceneFrameView()
      return
    case 'SCENE3D_DELETE': {
      const objId = scene3dProxy.focusedObjectId
      const sceneId = actor.getSnapshot().context.scene3dEditingId
      if (objId && sceneId) {
        setFocusedObject(null)
        void commitRemoveObject(sceneId, objId)
      }
      return
    }
    case 'SCENE3D_EXIT':
      actor.send({ type: 'SCENE3D_EDIT_EXIT' })
      return
  }
}
