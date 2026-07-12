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

/** Vector-edit sub-tool (Move / Add points / Bend), held while in `pathEditing`. */
export type PathSubTool = 'move' | 'add' | 'bend'

/** Gizmo sub-tool (translate / rotate / scale), held while in `scene3dEditing`. */
export type Scene3DGizmoMode = 'translate' | 'rotate' | 'scale'

export interface CanvasContext {
  resizeHandle: ResizeHandlePosition | null
  rotationCorner: ResizeHandlePosition | null
  drawTool: DrawTool | null
  areaSelectionAppend: boolean
  areaSelectionRemove: boolean
  /** Shape currently being text-edited (the `textEditing` mode). High-frequency
   * caret/selection geometry lives in signals, not here. */
  textEditingShapeId: string | null
  /** Path node currently in vector-edit mode (the `pathEditing` mode). Live anchor
   * drag geometry lives in signals, not here. */
  pathEditingShapeId: string | null
  /** While the pen sub-mode is active, the vector-network node id the next stroke
   * draws from (the "current point"), or null. Drives branch / extend / close. */
  pathDraftFromNode: number | null
  /** The active vector-edit sub-tool. Replaces the old `selecting`/`pen`/`bending`
   *  sub-states, so the activity tree (idle/dragging/placing) isn't triplicated. */
  pathSubTool: PathSubTool
  /** Scene currently in 3D-edit mode (the `scene3dEditing` mode), or null. The
   *  focused object within it lives in scene3dProxy (overlay/inspector concern). */
  scene3dEditingId: string | null
  /** The active gizmo sub-tool while editing a 3D scene. */
  scene3dGizmoMode: Scene3DGizmoMode
}

export type CanvasEvent =
  | { type: 'POINTER_DOWN_ON_SELECTION'; position: Point }
  | { type: 'POINTER_DOWN_ON_CORNER'; handle: ResizeHandlePosition; position: Point }
  | { type: 'POINTER_DOWN_ON_ROTATION'; corner: ResizeHandlePosition; position: Point }
  | { type: 'POINTER_DOWN_ON_CANVAS'; append: boolean; remove: boolean }
  | { type: 'POINTER_DOWN_ON_GRADIENT_HANDLE'; handle: GradientHandleKind; position: Point }
  | { type: 'POINTER_DOWN_DRAW' }
  | { type: 'PAN_START' }
  | { type: 'PAN_END' }
  | { type: 'DRAW_TOOL_ACTIVATE'; tool: DrawTool }
  | { type: 'DRAW_TOOL_DEACTIVATE' }
  | { type: 'START_TEXT_EDIT'; shapeId: string }
  | { type: 'STOP_TEXT_EDIT' }
  | { type: 'START_PATH_EDIT'; shapeId: string }
  | { type: 'STOP_PATH_EDIT' }
  // Path-editing sub-interaction (R3). The overlay does the hit-testing and sends
  // these semantic events; the machine holds the sub-mode + draft state.
  | { type: 'PATH_GRAB_NODE'; node: number }
  | { type: 'PATH_GRAB_HANDLE'; node: number; side: 'in' | 'out' }
  | { type: 'PATH_POINTER_UP' }
  | { type: 'PATH_CANCEL' }
  | { type: 'PATH_SET_SUBTOOL'; subTool: PathSubTool }
  | { type: 'PATH_PEN_DOWN' }
  | { type: 'PATH_SET_DRAFT_FROM'; node: number | null }
  // 3D-scene edit mode. Entered by selecting a scene + "Edit in 3D", picking an
  // object in the inspector, or creating a scene. The focused object lives in
  // scene3dProxy; the machine owns the mode + gizmo sub-tool.
  | { type: 'SCENE3D_EDIT_ENTER'; sceneId: string }
  | { type: 'SCENE3D_EDIT_EXIT' }
  | { type: 'SCENE3D_SET_GIZMO'; mode: Scene3DGizmoMode }

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
    pathEditingShapeId: null,
    pathDraftFromNode: null,
    pathSubTool: 'move',
    scene3dEditingId: null,
    scene3dGizmoMode: 'translate',
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
          target: 'marqueeSelect',
          actions: assign({
            areaSelectionAppend: ({ event }) => event.append,
            areaSelectionRemove: ({ event }) => event.remove,
          }),
        },
        POINTER_DOWN_ON_GRADIENT_HANDLE: { target: 'draggingGradient' },
        POINTER_DOWN_DRAW: { target: 'drawingShape' },
        PAN_START: { target: 'panning' },
        START_TEXT_EDIT: {
          target: 'textEditing',
          actions: assign({ textEditingShapeId: ({ event }) => event.shapeId }),
        },
        START_PATH_EDIT: {
          target: 'pathEditing',
          actions: assign({ pathEditingShapeId: ({ event }) => event.shapeId }),
        },
        SCENE3D_EDIT_ENTER: {
          target: 'scene3dEditing',
          actions: assign({ scene3dEditingId: ({ event }) => event.sceneId }),
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
        START_PATH_EDIT: {
          target: 'pathEditing',
          actions: assign({ pathEditingShapeId: ({ event }) => event.shapeId }),
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
    // Marquee / area selection drag (renamed from `selecting` to avoid colliding
    // with the path-editing context, which used to have a `selecting` sub-state).
    marqueeSelect: {
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
    // Vector-edit mode. Like `textEditing`, normal pointer gestures (wired on
    // `idle`) are naturally suspended; the PathEditorOverlay drives anchor/handle
    // dragging while this state is active and the surface treats any stray
    // mousedown as a click-away that exits.
    // Vector edit. The SUB-TOOL (Move / Add / Bend) lives in context — it's an
    // orthogonal choice, not a state — so the activity tree below is ONE flat
    // machine instead of three identical copies (R3, Phase B):
    //   idle     — hovering; can grab a node/handle (Move/Bend) or place (Add)
    //   dragging — a node/handle drag is in flight (overlay drives the geometry)
    //   placing  — Add just dropped a node; the pointer may drag out a handle
    // The overlay hit-tests and sends semantic events; the machine owns mode+subtool.
    pathEditing: {
      initial: 'idle',
      // Entering fresh from another mode starts on Move with no pen draft.
      entry: assign({ pathDraftFromNode: () => null, pathSubTool: () => 'move' }),
      on: {
        // Switch directly between path shapes without bouncing through idle.
        START_PATH_EDIT: {
          target: '.idle',
          actions: assign({
            pathEditingShapeId: ({ event }) => event.shapeId,
            pathDraftFromNode: () => null,
            pathSubTool: () => 'move',
          }),
        },
        STOP_PATH_EDIT: {
          target: 'idle',
          actions: assign({
            pathEditingShapeId: () => null,
            pathDraftFromNode: () => null,
            // Finishing returns to Select — drop the pen tool too, so exiting a
            // pen-drawn path doesn't leave the Pen armed (Phase C).
            drawTool: () => null,
          }),
        },
        // The draft-from node (pen's "current point") can change in any sub-state.
        PATH_SET_DRAFT_FROM: {
          actions: assign({ pathDraftFromNode: ({ event }) => event.node }),
        },
        // Move / Add / Bend is just a context value now — one event, no state churn.
        PATH_SET_SUBTOOL: {
          actions: assign({ pathSubTool: ({ event }) => event.subTool }),
        },
        // Esc cancels the pen draft from anywhere and returns to a clean idle.
        PATH_CANCEL: {
          target: '.idle',
          actions: assign({ pathDraftFromNode: () => null }),
        },
      },
      states: {
        idle: {
          on: {
            PATH_GRAB_NODE: { target: 'dragging' },
            PATH_GRAB_HANDLE: { target: 'dragging' },
            PATH_PEN_DOWN: { target: 'placing' },
          },
        },
        dragging: {
          on: {
            PATH_POINTER_UP: { target: 'idle' },
          },
        },
        placing: {
          on: {
            PATH_POINTER_UP: { target: 'idle' },
          },
        },
      },
    },
    // 3D-scene edit mode (sibling of pathEditing). Like textEditing/pathEditing,
    // normal pointer gestures (wired on `idle`) are naturally suspended; the
    // Scene3DLayer drives the gizmo/orbit/raycast while this is active and the
    // bottom toolbar shows the contextual add/gizmo menu. The focused object is
    // overlay state (scene3dProxy); the machine owns the mode + gizmo sub-tool.
    scene3dEditing: {
      // (Re)start on the Move (translate) gizmo each time edit mode begins.
      entry: assign({ scene3dGizmoMode: (): Scene3DGizmoMode => 'translate' }),
      on: {
        // Switch directly between scenes (e.g. picking another scene's object).
        SCENE3D_EDIT_ENTER: {
          actions: assign({ scene3dEditingId: ({ event }) => event.sceneId }),
        },
        SCENE3D_EDIT_EXIT: {
          target: 'idle',
          actions: assign({ scene3dEditingId: () => null }),
        },
        SCENE3D_SET_GIZMO: {
          actions: assign({ scene3dGizmoMode: ({ event }) => event.mode }),
        },
        // A mousedown on empty canvas (outside the edited scene's box; clicks inside
        // it are captured by the 3D edit surface and never reach the 2D handler) leaves
        // 3D-edit and behaves like a normal empty-canvas click: run the marquee/deselect.
        // Clearing the selection there also satisfies the overlay's selection-driven
        // exit; setting scene3dEditingId null here makes the exit immediate on press.
        POINTER_DOWN_ON_CANVAS: {
          target: 'marqueeSelect',
          actions: assign({
            scene3dEditingId: () => null,
            areaSelectionAppend: ({ event }) => event.append,
            areaSelectionRemove: ({ event }) => event.remove,
          }),
        },
      },
    },
  },
})
