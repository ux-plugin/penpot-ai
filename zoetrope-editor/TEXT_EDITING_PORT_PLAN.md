# Text-editing port plan — mirror Penpot's `v3_editor` + single pointer sink

> **Status: COMPLETED (2026-06).** The port shipped. The "FINAL architecture"
> section reflects the design as built — note it diverges from the original
> goal below (the single pointer-sink was reverted, double-click detection is
> manual, and Phase 3 was dropped). The "Goal" and phased roadmap are the
> original plan, retained as historical context; the implementation notes at
> the end document what actually landed.

## Goal
Replace the ad-hoc text-input layer with a faithful port of Penpot's model:
- **One pointer sink** (the viewport handlers) drives *all* interactions and forwards to the
  text editor when editing is active — exactly like `actions.cljs`.
- **One positioned `contentEditable`** over the shape owns only what the canvas can't do:
  focus / input / keydown / composition / clipboard — like `v3_editor.cljs`.
- **Mouse position stays a signal** (`pointerPos`/`worldPointerPos`), written once per move by the
  sink, consumed by gestures (via XState actors) and by the text editor (gated, shape-local offset).

## Three layers and how they map to Penpot

| Concern | Penpot | Ours |
|---|---|---|
| Mode (discrete) | re-frame edition state | XState `canvasMachine` (`idle…textEditing`) + `textEditingShapeId` |
| Mouse position (hot) | `ms/mouse-position`, `…-shift/alt/ctrl/mod` | signals `pointerPos`/`worldPointerPos`, `modShift/alt/ctrl/meta` |
| Gesture subscription | `(->> ms/mouse-position … (rx/take-until stopper))` | XState actor on `signalToObservable(pointerPos)` |
| Pointer entry | `actions.cljs` `on-pointer-down/move/up` | single sink `use-viewport-interactions` |
| Caret/selection (hot) | wasm overlay | signals `textCaretRect`/`textSelectionRects`, drawn by render loop |
| Keyboard/IME | `v3_editor.cljs` contentEditable | `TextEditorOverlay` contentEditable |

## Architecture (the pieces)

### A. Single pointer sink — `use-viewport-interactions.ts`
All pointer events land here. On **every** move it writes the hot signals, then dispatches by mode.
- Always (mode-agnostic): `pointerPos.value = {x,y}`, `modShift/alt/ctrl/meta.value = …`
  (`worldPointerPos` auto-derives via the `viewport` signal). This is our `ms/mouse-position`.
- **Not editing:** canvas gestures. The machine, on entering `moving/resizing/rotating/drawing`,
  invokes an actor subscribed to `signalToObservable(pointerPos)` that drags off the signal and
  stops via the STOP event (= Penpot's `take-until stopper`). The sink does **not** poll gestures.
- **Editing (`textEditing` active):** the sink does NOT use `pointerPos` for the editor; it uses
  element-local **offset** instead:
  - `pointerdown` → `setPointerCapture` on the contentEditable so the target stays pinned and
    `offsetX/offsetY` are **shape-local** (Penpot's coord trick) → `textEditorPointerDown(offset)`.
  - `pointermove` → `textEditorPointerMove(offset)`  ·  `pointerup` → release + `…PointerUp(offset)`.
  - single `click` → `setCursorFromOffset(offset)`  ·  `dblclick` → `selectWordBoundary(offset)`.
  - click-away (pointerdown outside shape rect) → `machine.send(STOP_TEXT_EDIT)`.
  - Forward to WASM is **gated on edit mode** (avoid Penpot's "called on every move" waste).
- **Entry to editing:** `dblclick` when not editing → hit-test under `worldPointerPos` → text shape?
  → `machine.send(START_TEXT_EDIT, shapeId)`. (Mirrors `on-double-click` reading `@hover`.)

### B. Positioned contentEditable — `components/Overlay/TextEditorOverlay.tsx` (rewrite)
Mounts only while `textEditingShapeId` is set. Owns DOM-native input only (no pointer logic):
- Position over shape **screen rect** from selrect + `worldToScreen` + zoom (+ `getTextDimensions`
  for height / vertical-align). Absolute, `pointerEvents:'all'`, CSS transform for zoom (rotation
  later). Re-position on the `viewport` signal.
- `onFocus` → `startTextEdit(shapeId)`  ·  `onBlur` → `commitTextEdit(shapeId)`.
- `onInput` (native) → read `inputType`/`data` → `insertText` → clear `textContent`
  (replaces the broken `onBeforeInput`+`preventDefault`).
- `onKeyDown` → Escape(blur), Enter(insertParagraph), Backspace, Delete, arrows/Home/End
  (moveCursor 0–5), Ctrl/Cmd+A(selectAll).
- `onCompositionStart/Update/End` → IME, guarded by `textIsComposing`.
- clipboard paste/copy/cut (paste = plain text for MVP). Auto-focus on mount.
- Caret blink already handled by the render loop (`textEditorUpdateBlink`).

### C. Hot caret/selection signals + render loop (already exists)
`textEditorActive`/`textCaretRect`/`textSelectionRects`/`textIsComposing`; `api/rendering.ts`
draws them each frame when active. Keep as-is (after stripping debug).

## Phases

### Phase 0 — Revert divergent + debug code
- Delete `handlers/dbg.ts`; strip every `dbg()` call (sink, overlay, `text-edit.ts`).
- Strip debug from `api/rendering.ts` (`__dbgFrame`, `render:loop` POST); keep the real loop.
- Remove invented input layer in the sink: window-level dblclick detector, `lastClickClientRef`,
  old in-edit routing block.
- Keep verified: text-tool button, `createText`, worker selrect hit-test fallback,
  machine `textEditing` state + signals.
- Run debug-mode cleanup (revert per `instrumentation.json`, kill server, delete `.runtime/`).

### Phase 1 — Positioned contentEditable (focus / input / keydown)
- Rewrite `TextEditorOverlay.tsx` per **B** (no pointer handlers).
- Verify: dblclick text shape → caret element over it, **typing works**, Enter/Backspace/arrows/
  Escape work, blur commits. **← first test checkpoint.**

### Phase 2 — Pointer routing through the single sink
- Add the `textEditing` branch + mode-agnostic signal writes to the sink per **A**
  (pointer down/move/up→offset, click→cursor, dblclick→word, click-away→stop, setPointerCapture).
- Confirm gesture actors still drive off `pointerPos` unchanged when not editing.
- Verify: click places caret, drag selects, double-click selects a word.

### Phase 3 — Continuous content sync
- After each mutation push content back via `applyChanges` (Penpot's
  `sync-wasm-text-editor-content!`) so shape / worker / undo stay live, not only on exit.

## Files
- **Rewrite:** `components/Overlay/TextEditorOverlay.tsx`
- **Edit:** `hooks/use-viewport-interactions.ts`, `handlers/text-edit.ts`, `api/rendering.ts`
- **Delete:** `handlers/dbg.ts`
- **Untouched:** worker hit-test, `canvas-machine.ts`, `node-factory.ts`, `ShapeToolbar.tsx`,
  `signals/pointer.ts` (mouse position already correct)

## Implementation notes (what the code actually does vs. the plan above)
Two findings from `render-wasm` changed the final shape:

1. **Pointers live on the contentEditable, not the canvas sink.** Because the editor
   element needs `pointerEvents:'all'` to receive focus, inside-clicks land on it and
   never reach the canvas — so caret/drag/word-select are handled by `onPointerDown/
   Move/Up` + `onDoubleClick` *on the element*, using `offsetX/offsetY` (shape-local
   thanks to the world-size + `scale(zoom)`). This matches `v3_editor` exactly. The
   canvas sink still owns all non-editing gestures and treats any canvas mousedown
   during editing as click-away → `STOP_TEXT_EDIT`.

2. **Double-click entry is detected manually**, not via native `dblclick`: the browser
   withholds `dblclick` when the two presses hit different elements (canvas → selection
   overlay). A container-level (bubble) `mousedown` sees both presses; we detect a
   double by time (<450ms) + client-distance (<8px, DPR-independent).

3. **Phase 3 (continuous sync) dropped — would be harmful.** `text_editor_insert_text`
   / delete / composition mutate the WASM shape's `TextContent` in place and
   `mark_touched`, so text renders live and undo lives in WASM; `render_overlay` only
   draws cursor/selection. Pushing JS content back via `applyChanges` mid-edit would
   overwrite the live buffer and reset the cursor. `commitTextEdit` syncs editor→JS on
   exit, which is the correct (and complete) design.

## FINAL architecture (single-sink reverted — too much to maintain)
We reverted the pure single-sink + WASM screen variants: it added a parallel WASM
ABI, an upstream-merge tax, and hand-rolled hit-testing to avoid a trivial
coordinate transform. Final shape:

- **Wrapper element** kept as the single body pointer surface (canvas
  `pointerEvents:'none'`). Being one element makes native `dblclick` for entering
  editing reliable — our DOM equivalent of Penpot's single `viewport-controls`.
- **Entry** = native `dblclick` on the wrapper → hit-test → `START_TEXT_EDIT`
  (Penpot uses native `dblclick` on `viewport-controls` too; no manual detector).
- **Text pointers** (caret/drag/word) handled on the `contentEditable`, which is
  positioned + `scale(zoom)`-transformed over the shape so `offsetX/offsetY` are
  shape-local for free → forwarded to the shape-local WASM pointer APIs. Exactly
  `v3_editor`. No screen variants, no JS coordinate math.
- **Sink during editing** = click-away only (mousedown reaching the wrapper →
  `STOP_TEXT_EDIT`); inside clicks land on the contentEditable above it.
- **Kept fixes:** caret blink driver (250 ms), text `growType: auto-height`.
- **WASM** reverted to upstream (the `*_screen` variants removed).

## Single-sink refactor (HISTORICAL — reverted)
Decision: one wrapper surface, one dispatch. Verified against render-wasm: the
`text_editor_pointer_{down,move,up}` + `set_cursor_from_offset` family takes
SHAPE-LOCAL coords; only `set_cursor_from_point` took SCREEN. So we added
SCREEN-coord variants in render-wasm (`text_editor_pointer_{down,move,up}_screen`,
`text_editor_select_word_boundary_screen`) that transform via view+shape matrices
internally — the sink forwards CSS-pixel screen coords with zero JS matrix math.

Stage 1 (LANDED): full-size wrapper `<div>` over the canvas is the sole pointer
surface (`pointerEvents:'all'`); canvas + contentEditable are `pointerEvents:'none'`
(editor is focus-only, focused programmatically). All listeners moved onto the
wrapper. Native `dblclick` enters editing (both presses land on the wrapper, so it
fires reliably — manual detector gone). While editing, the sink forwards screen
coords to the `*_screen` WASM variants (down/move/up = caret + drag-select,
dblclick = word). `MoveHitArea` set `pointerEvents:'none'` (move flows through the
sink); resize/rotation handles stay on old SVG handlers transiently.

Stage 2 (TODO): extract pure `hitTestSelection(worldPoint, wasmSelectionRect,
viewport)` from the handle geometry; dispatch resize/rotate/move from the sink;
flip handle SVGs to `pointerEvents:'none'`.

Stage 3 (TODO): delete dead path — `usePointerDownFactory` handle handlers,
`MoveHitArea`/`RotationHitArea` pointer props, per-handle `setPointerCapture`.

## Primary risk
Pointer→shape-local mapping for `textEditorPointer*`/`setCursorFromOffset`. Mitigation: replicate
Penpot's `setPointerCapture`-on-editor trick so `offsetX/offsetY` are shape-local. Typing flows
through `input`/`focus` independently, so caret-placement error won't block input (Phase 1 verifies
typing before Phase 2 touches pointers).

## Debug policy
Clean-first: no instrumentation in new code; add light probes only if a wall is hit.
