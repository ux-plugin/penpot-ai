/**
 * Positioned `contentEditable` capture surface for interactive text editing.
 *
 * Mirrors Penpot's `v3_editor`: while the canvas machine is in `textEditing`, an
 * absolutely-positioned, transparent `contentEditable` div is laid over the edited
 * shape's screen rect. It owns *only* what the canvas can't do natively — focus,
 * keyboard, native `input`, and IME composition — forwarding each to the WASM text
 * editor. The caret/selection and the text itself are painted by the WASM render
 * loop (gated on `textEditorActive`); the element's own text/caret are kept
 * invisible (transparent color + caret) and its `textContent` is cleared after
 * every input, so it never accumulates state of its own.
 *
 * Pointer caret-placement / drag-select / word-select ARE handled here, exactly
 * like Penpot's `v3_editor`: the element is positioned + `scale(zoom)`-transformed
 * over the shape, so a pointer event's `offsetX/offsetY` are already shape-local
 * (the browser inverts the transform), and we forward them straight to the WASM
 * editor's shape-local pointer APIs — no coordinate math, no screen variants. The
 * canvas pointer sink only handles entering edit mode (double-click) and click-away.
 *
 * Lifecycle: focus the WASM editor on mount, commit + dispose on unmount / shape
 * switch (keyed on the editing shape id). Escape / blur route through the machine
 * (`STOP_TEXT_EDIT`) so the single commit path stays in the unmount cleanup.
 */

import { useEffect, useRef } from 'react'
import { useSelector } from '@xstate/react'
import { useCanvasActor } from '../../renderer/machine/canvas-actor-context'
import { useWorkspaceStore } from '../../renderer/store/workspace-store'
import {
  startTextEdit,
  commitTextEdit,
  syncTextEditGeometry,
  refreshEditorStyles,
} from '../../renderer/handlers/text-edit'
import { requestRender } from '../../renderer/api/rendering'
import { textIsComposing, textEditorDomNode } from '../../renderer/signals/text-editor'
import { viewport as viewportSignal } from '../../renderer/signals/pointer'
import { useSignalCoalesced } from '../../renderer/signals/use-signal-coalesced'
import { getActiveOrSinglePageId, getPage } from '../../renderer/store/doc-proxy'
import {
  CursorDirection,
  textEditorInsertText,
  textEditorInsertParagraph,
  textEditorDeleteBackward,
  textEditorDeleteForward,
  textEditorMoveCursor,
  textEditorSelectAll,
  textEditorCompositionStart,
  textEditorCompositionUpdate,
  textEditorCompositionEnd,
  textEditorPointerDown,
  textEditorPointerMove,
  textEditorPointerUp,
  textEditorSetCursorFromOffset,
  textEditorSelectWordBoundary,
} from '../../renderer/api/text-editor'

/** Caret blink cadence; matches Penpot's `caret-blink-interval-ms`. */
const CARET_BLINK_INTERVAL_MS = 250

interface Selrect {
  x: number
  y: number
  width: number
  height: number
}

function getModule() {
  return useWorkspaceStore.getState().wasmModule
}

/** Read the edited shape's selrect (world coords) + rotation from the model. */
function getGeom(shapeId: string): { selrect: Selrect; rotation: number } | null {
  const pageId = getActiveOrSinglePageId()
  if (!pageId) return null
  const node = getPage(pageId)?.objects[shapeId] as
    | { selrect?: Selrect; rotation?: number }
    | undefined
  if (!node?.selrect) return null
  return { selrect: node.selrect, rotation: node.rotation ?? 0 }
}

export function TextEditorOverlay() {
  const actor = useCanvasActor()
  const shapeId = useSelector(actor, (s) => s.context.textEditingShapeId)
  const vp = useSignalCoalesced(viewportSignal)
  const editorRef = useRef<HTMLDivElement>(null)

  // Focus the WASM editor on enter; commit + dispose on exit / shape switch.
  useEffect(() => {
    if (!shapeId) return
    const module = getModule()
    if (!module) return
    // A just-created shape may not be in the WASM scene yet, so the first focus
    // can fail (caret never shows). Retry on the next frame(s) until it takes.
    let raf = 0
    let tries = 0
    const tryStart = () => {
      if (startTextEdit(module, shapeId) || tries++ >= 10) return
      raf = requestAnimationFrame(tryStart)
    }
    tryStart()
    editorRef.current?.focus()
    // Expose the element so panels can hand keyboard focus back after an
    // interaction (refocusTextEditor) without a caret-moving canvas click.
    textEditorDomNode.value = editorRef.current
    return () => {
      cancelAnimationFrame(raf)
      textEditorDomNode.value = null
      const m = getModule()
      if (m) commitTextEdit(m, shapeId)
    }
  }, [shapeId])

  // Reclaim stranded keyboard focus. While editing, panel inputs (size, hex…)
  // legitimately take DOM focus; when such a control blurs to nothing focusable
  // (body), focus is stranded — typing goes nowhere until the user clicks the
  // text again (which moves the caret and discards a pending caret style).
  // Watch focusout document-wide: when focus leaves a panel control and lands
  // nowhere, hand it back to this editor. Deliberate focus moves (to another
  // panel control, or any focusable element elsewhere) are left alone. Deferred
  // a frame so a canvas click-away can exit edit mode first — the unmount
  // cleanup clears `textEditorDomNode`, making the refocus a no-op.
  useEffect(() => {
    if (!shapeId) return
    const onFocusOut = (e: FocusEvent) => {
      const from = e.target
      const to = e.relatedTarget
      if (!(from instanceof HTMLElement)) return
      if (!from.closest('[data-right-side-panel],[data-floating-panel]')) return
      if (to instanceof HTMLElement) return // deliberate move — don't steal
      requestAnimationFrame(() => textEditorDomNode.value?.focus())
    }
    document.addEventListener('focusout', onFocusOut)
    return () => document.removeEventListener('focusout', onFocusOut)
  }, [shapeId])

  // Caret blink driver (mirrors Penpot's v3_editor): request a render on a steady
  // cadence so `update_blink` toggles the caret and `render_overlay` keeps
  // repainting it. Without this the caret is drawn at most once and then
  // disappears, since our render loop only re-runs itself on editor events.
  useEffect(() => {
    if (!shapeId) return
    let id: ReturnType<typeof setTimeout>
    const tick = () => {
      const m = getModule()
      if (m) requestRender(m, 'cursor-blink')
      id = setTimeout(tick, CARET_BLINK_INTERVAL_MS)
    }
    id = setTimeout(tick, CARET_BLINK_INTERVAL_MS)
    return () => clearTimeout(id)
  }, [shapeId])

  if (!shapeId) return null

  const geom = getGeom(shapeId)
  if (!vp || !geom) return null
  const { selrect, rotation } = geom

  // Lay the element over the shape in *shape-local* space so a pointer event's
  // offsetX/offsetY come back as shape-local coords (the browser inverts the CSS
  // transform), which is exactly what the WASM editor's pointer APIs expect —
  // even when the box is rotated. The transform maps shape-local (lx,ly) to the
  // screen: translate to the shape's screen center, scale by zoom, rotate about
  // the center, then shift the box origin from its center to its top-left:
  //   screen = screenCenter + zoom · R(rotation) · (local − center)
  // Mirrors Penpot's v3_editor, whose contentEditable rides the shape's rotated
  // <g>. Without the rotate(), offsets stay axis-aligned and clicks on a rotated
  // box resolve to the wrong glyph.
  const w = selrect.width
  const h = selrect.height
  const screenCx = (selrect.x + w / 2 - vp.panX) * vp.zoom
  const screenCy = (selrect.y + h / 2 - vp.panY) * vp.zoom

  const afterMutation = () => {
    const m = getModule()
    if (!m || !shapeId) return
    // Grow the shape to fit the text (Penpot syncs size every keystroke) so tile
    // coverage + caret bounds track the text; then repaint.
    syncTextEditGeometry(m, shapeId)
    // Refresh the panel's live style after every edit/selection change (typing,
    // arrows, click caret, drag-select, word/all select all route through here).
    refreshEditorStyles(m)
    requestRender(m, 'text-edit-input')
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const module = getModule()
    if (!module) return
    const wordBoundary = e.ctrlKey || e.altKey
    const extend = e.shiftKey
    let handled = true

    switch (e.key) {
      case 'Escape':
        actor.send({ type: 'STOP_TEXT_EDIT' })
        break
      case 'ArrowLeft':
        textEditorMoveCursor(module, CursorDirection.Left, wordBoundary, extend)
        break
      case 'ArrowRight':
        textEditorMoveCursor(module, CursorDirection.Right, wordBoundary, extend)
        break
      case 'ArrowUp':
        textEditorMoveCursor(module, CursorDirection.Up, false, extend)
        break
      case 'ArrowDown':
        textEditorMoveCursor(module, CursorDirection.Down, false, extend)
        break
      case 'Home':
        textEditorMoveCursor(module, CursorDirection.Home, false, extend)
        break
      case 'End':
        textEditorMoveCursor(module, CursorDirection.End, false, extend)
        break
      case 'Backspace':
        textEditorDeleteBackward(module, wordBoundary)
        break
      case 'Delete':
        textEditorDeleteForward(module, wordBoundary)
        break
      case 'Enter':
        textEditorInsertParagraph(module)
        break
      case 'a':
      case 'A':
        if (e.metaKey || e.ctrlKey) {
          textEditorSelectAll(module)
        } else {
          handled = false
        }
        break
      default:
        handled = false
    }

    if (handled) {
      e.preventDefault()
      afterMutation()
    }
  }

  // Native `input` event (Penpot's model). Printable characters fall through
  // keydown (not prevented) and land here; we forward to WASM then clear the
  // element so it holds no text of its own. Control edits (Backspace/Delete/
  // arrows/Enter) are handled in keydown and prevented, so they don't reach here.
  const onInput = (e: React.FormEvent<HTMLDivElement>) => {
    if (textIsComposing.value) return
    const module = getModule()
    if (!module) return
    const native = e.nativeEvent as InputEvent
    if (native.inputType === 'insertText' && native.data) {
      textEditorInsertText(module, native.data)
      afterMutation()
    } else if (native.inputType === 'insertLineBreak' || native.inputType === 'insertParagraph') {
      textEditorInsertParagraph(module)
      afterMutation()
    }
    e.currentTarget.textContent = ''
  }

  // Pointer caret-placement / drag-select, mirroring v3_editor's on-pointer-*.
  // offsetX/offsetY are relative to this element's *untransformed* box, which —
  // because the element is world-sized and CSS-scaled by zoom — are already in
  // shape-local coordinates (what the WASM editor's shape-local APIs expect).
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const module = getModule()
    if (!module) return
    const n = e.nativeEvent
    e.currentTarget.setPointerCapture(e.pointerId)
    textEditorPointerDown(module, n.offsetX, n.offsetY)
    afterMutation()
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.buttons & 1) === 0) return
    const module = getModule()
    if (!module) return
    const n = e.nativeEvent
    textEditorPointerMove(module, n.offsetX, n.offsetY)
    afterMutation()
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const module = getModule()
    if (!module) return
    const n = e.nativeEvent
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    textEditorPointerUp(module, n.offsetX, n.offsetY)
    afterMutation()
  }

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const module = getModule()
    if (!module) return
    const n = e.nativeEvent
    // Click count: 1 = place caret, 2 = word (handled by onDoubleClick),
    // 3+ = select all the text.
    if (e.detail >= 3) {
      textEditorSelectAll(module)
    } else {
      textEditorSetCursorFromOffset(module, n.offsetX, n.offsetY)
    }
    afterMutation()
  }

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const module = getModule()
    if (!module) return
    const n = e.nativeEvent
    textEditorSelectWordBoundary(module, n.offsetX, n.offsetY)
    afterMutation()
  }

  const onCompositionStart = () => {
    const module = getModule()
    if (!module) return
    textIsComposing.value = true
    textEditorCompositionStart(module)
  }

  const onCompositionUpdate = (e: React.CompositionEvent<HTMLDivElement>) => {
    const module = getModule()
    if (!module) return
    textEditorCompositionUpdate(module, e.data)
    afterMutation()
  }

  const onCompositionEnd = (e: React.CompositionEvent<HTMLDivElement>) => {
    const module = getModule()
    if (!module) return
    textEditorCompositionEnd(module, e.data)
    textIsComposing.value = false
    if (editorRef.current) editorRef.current.textContent = ''
    afterMutation()
  }

  return (
    <div
      ref={editorRef}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onKeyDown={onKeyDown}
      onInput={onInput}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onCompositionStart={onCompositionStart}
      onCompositionUpdate={onCompositionUpdate}
      onCompositionEnd={onCompositionEnd}
      onBlur={(e) => {
        // Don't exit edit mode when focus moves to the properties panel or a
        // floating editor (font picker / colour editor) — those drive the
        // per-range apply, which needs the live selection to stay alive. Only a
        // blur to the canvas / elsewhere ends editing.
        const next = e.relatedTarget
        if (next instanceof HTMLElement && next.closest('[data-right-side-panel],[data-floating-panel]')) {
          return
        }
        actor.send({ type: 'STOP_TEXT_EDIT' })
      }}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: w,
        height: h,
        transform: `translate(${screenCx}px, ${screenCy}px) scale(${vp.zoom}) rotate(${rotation}deg) translate(${-w / 2}px, ${-h / 2}px)`,
        transformOrigin: '0 0',
        margin: 0,
        padding: 0,
        border: 0,
        outline: 'none',
        background: 'transparent',
        // WASM paints the text + caret; keep the DOM ones invisible to avoid doubles.
        color: 'transparent',
        caretColor: 'transparent',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        overflow: 'hidden',
        cursor: 'text',
        // Captures pointers over the text box (caret/drag/word via offsets) and is
        // the keyboard/IME focus target. It sits above the wrapper, so clicks
        // inside the box come here and clicks outside fall to the wrapper (= exit).
        pointerEvents: 'all',
        userSelect: 'text',
        WebkitUserSelect: 'text',
      }}
    />
  )
}
