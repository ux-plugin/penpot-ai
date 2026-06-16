/**
 * Canvas interaction state machine (XState v5). Replaces scattered Zustand booleans
 * (isMoving, isResizing, …) with explicit states; RxJS handlers run as invoked actors.
 */

import { assign, fromObservable, setup } from 'xstate'
import { startMoveSelected } from '../handlers/move'
import { startRotateSelected } from '../handlers/rotate'
import { startResizeSelected } from '../handlers/resize'
import { handleAreaSelection } from '../handlers/selection'
import { handleDrawShape, pendingTextEdit } from '../handlers/draw-shape'
import { handlePenDraw } from '../handlers/draw-path'
import { startGradientDrag } from '../handlers/gradient'
import type { GradientHandleKind } from '../handlers/gradient'
import type { Point, ResizeHandlePosition } from '../types'

export type DrawTool =
  | 'rect'
  | 'frame'
  | 'text'
  | 'ellipse'
  | 'pen'
  | 'triangle'
  | 'polygon'
  | 'star'

export interface CanvasContext {
  resizeHandle: ResizeHandlePosition | null
  rotationCorner: ResizeHandlePosition | null
  drawTool: DrawTool | null
  areaSelectionAppend: boolean
  areaSelectionRemove: boolean
  /** Shape currently being text-edited (the `textEditing` mode). High-frequency
   * caret/selection geometry lives in signals, not here. */
  textEditingShapeId: string | null
}

export type CanvasEvent =
  | { type: 'POINTER_DOWN_ON_SELECTION'; position: Point }
  | { type: 'POINTER_DOWN_ON_CORNER'; handle: ResizeHandlePosition; position: Point }
  | { type: 'POINTER_DOWN_ON_ROTATION'; corner: ResizeHandlePosition; position: Point }
  | { type: 'POINTER_DOWN_ON_CANVAS'; append: boolean; remove: boolean }
  | { type: 'POINTER_DOWN_ON_GRADIENT_HANDLE'; handle: GradientHandleKind; position: Point }
  | { type: 'POINTER_DOWN_DRAW' }
  | { type: 'POINTER_DOWN_PEN' }
  | { type: 'PAN_START' }
  | { type: 'PAN_END' }
  | { type: 'DRAW_TOOL_ACTIVATE'; tool: DrawTool }
  | { type: 'DRAW_TOOL_DEACTIVATE' }
  | { type: 'START_TEXT_EDIT'; shapeId: string }
  | { type: 'STOP_TEXT_EDIT' }

const canvasMachineSetup = setup({
  types: {
    context: {} as CanvasContext,
    events: {} as CanvasEvent,
  },
  actors: {
    moveActor: fromObservable(({ input }: { input: { position: Point } }) => startMoveSelected(input.position)),
    rotateActor: fromObservable(({ input }: { input: { position: Point } }) =>
      startRotateSelected(input.position),
    ),
    resizeActor: fromObservable(({ input }: { input: { position: Point; handle: ResizeHandlePosition } }) =>
      startResizeSelected(input.position, input.handle),
    ),
    selectActor: fromObservable(
      ({ input }: { input: { append: boolean; remove: boolean; ignoreGroups?: boolean } }) =>
        handleAreaSelection(input.append, input.remove, input.ignoreGroups),
    ),
    drawActor: fromObservable(({ input }: { input: { tool: DrawTool } }) => handleDrawShape(input.tool)),
    penActor: fromObservable(() => handlePenDraw()),
    gradientActor: fromObservable(
      ({ input }: { input: { handle: GradientHandleKind; position: Point } }) =>
        startGradientDrag(input.handle, input.position),
    ),
  },
})

export const canvasMachine = canvasMachineSetup.createMachine({
  id: 'canvas',
  initial: 'idle',
  context: {
    resizeHandle: null,
    rotationCorner: null,
    drawTool: null,
    areaSelectionAppend: false,
    areaSelectionRemove: false,
    textEditingShapeId: null,
  },
  on: {
    DRAW_TOOL_ACTIVATE: {
      actions: assign({ drawTool: ({ event }) => event.tool }),
    },
    DRAW_TOOL_DEACTIVATE: {
      actions: assign({ drawTool: () => null }),
    },
  },
  states: {
    idle: {
      on: {
        POINTER_DOWN_ON_SELECTION: { target: 'moving' },
        POINTER_DOWN_ON_CORNER: {
          target: 'resizing',
          actions: assign({ resizeHandle: ({ event }) => event.handle }),
        },
        POINTER_DOWN_ON_ROTATION: {
          target: 'rotating',
          actions: assign({ rotationCorner: ({ event }) => event.corner }),
        },
        POINTER_DOWN_ON_CANVAS: {
          target: 'selecting',
          actions: assign({
            areaSelectionAppend: ({ event }) => event.append,
            areaSelectionRemove: ({ event }) => event.remove,
          }),
        },
        POINTER_DOWN_ON_GRADIENT_HANDLE: { target: 'draggingGradient' },
        POINTER_DOWN_DRAW: { target: 'drawingShape' },
        POINTER_DOWN_PEN: { target: 'drawingPath' },
        PAN_START: { target: 'panning' },
        START_TEXT_EDIT: {
          target: 'textEditing',
          actions: assign({ textEditingShapeId: ({ event }) => event.shapeId }),
        },
      },
    },
    moving: {
      invoke: {
        src: 'moveActor',
        input: ({ event }) =>
          event.type === 'POINTER_DOWN_ON_SELECTION'
            ? { position: event.position }
            : { position: { x: 0, y: 0 } },
        onDone: { target: 'idle' },
        onError: { target: 'idle' },
      },
      on: {
        // A double-click begins with a mousedown that transiently enters
        // `moving`; the async hit-test that decides to edit a text shape may
        // resolve before the move actor settles. Accept the transition here so
        // the edit isn't dropped (the move actor is auto-stopped on exit).
        START_TEXT_EDIT: {
          target: 'textEditing',
          actions: assign({ textEditingShapeId: ({ event }) => event.shapeId }),
        },
      },
    },
    rotating: {
      invoke: {
        src: 'rotateActor',
        input: ({ event }) =>
          event.type === 'POINTER_DOWN_ON_ROTATION'
            ? { position: event.position }
            : { position: { x: 0, y: 0 } },
        onDone: {
          target: 'idle',
          actions: assign({ rotationCorner: () => null }),
        },
        onError: {
          target: 'idle',
          actions: assign({ rotationCorner: () => null }),
        },
      },
    },
    resizing: {
      invoke: {
        src: 'resizeActor',
        input: ({ event }) =>
          event.type === 'POINTER_DOWN_ON_CORNER'
            ? { position: event.position, handle: event.handle }
            : { position: { x: 0, y: 0 }, handle: 'right' as ResizeHandlePosition },
        onDone: {
          target: 'idle',
          actions: assign({ resizeHandle: () => null }),
        },
        onError: {
          target: 'idle',
          actions: assign({ resizeHandle: () => null }),
        },
      },
    },
    selecting: {
      invoke: {
        src: 'selectActor',
        input: ({ context }) => ({
          append: context.areaSelectionAppend,
          remove: context.areaSelectionRemove,
        }),
        onDone: { target: 'idle' },
        onError: { target: 'idle' },
      },
    },
    drawingShape: {
      invoke: {
        src: 'drawActor',
        input: ({ context }) => ({ tool: context.drawTool ?? 'rect' }),
        onDone: [
          {
            // A freshly drawn text shape drops straight into edit mode so a
            // blinking caret appears (no placeholder text). The id comes via the
            // `pendingTextEdit` ref since observable actors have no typed output.
            guard: () => pendingTextEdit.id != null,
            target: 'textEditing',
            actions: assign({
              textEditingShapeId: () => pendingTextEdit.id,
            }),
          },
          { target: 'idle' },
        ],
        onError: { target: 'idle' },
      },
    },
    // Pen tool: a click-driven path-drawing session that spans many clicks and
    // ends on close / Esc / Enter / double-click (the actor completes itself).
    drawingPath: {
      invoke: {
        src: 'penActor',
        onDone: { target: 'idle' },
        onError: { target: 'idle' },
      },
    },
    draggingGradient: {
      invoke: {
        src: 'gradientActor',
        input: ({ event }) =>
          event.type === 'POINTER_DOWN_ON_GRADIENT_HANDLE'
            ? { handle: event.handle, position: event.position }
            : { handle: 'start' as GradientHandleKind, position: { x: 0, y: 0 } },
        onDone: { target: 'idle' },
        onError: { target: 'idle' },
      },
    },
    panning: {
      on: {
        PAN_END: { target: 'idle' },
      },
    },
    // Text-editing mode. Normal pointer gestures (only wired on `idle`) are
    // naturally suspended here; pointer/keyboard input is routed to the WASM
    // editor by the TextEditorOverlay while this state is active.
    textEditing: {
      on: {
        // Switch directly between text shapes without bouncing through idle.
        START_TEXT_EDIT: {
          actions: assign({ textEditingShapeId: ({ event }) => event.shapeId }),
        },
        STOP_TEXT_EDIT: {
          target: 'idle',
          actions: assign({ textEditingShapeId: () => null }),
        },
      },
    },
  },
})
