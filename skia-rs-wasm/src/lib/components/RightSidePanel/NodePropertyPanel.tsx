import type { RectLikeNode } from '../../renderer/properties/panel-utils'
import { NodeIdentitySection } from './Sections/NodeIdentitySection'
import { PositionSection } from './Sections/PositionSection'
import { MotionRestSection } from './Sections/MotionRestSection'
import { AppearanceSection } from './Sections/AppearanceSection'
import { ShapeSection } from './Sections/ShapeSection'
import { SlotSection } from './Sections/SlotSection'
import { VectorEditSection } from './Sections/VectorEditSection'
import { TypographySection } from './Sections/TypographySection'
import { isTextNode } from './Sections/text-typography'
import { NodeLayoutSection } from './Sections/NodeLayoutSection'
import { supportsLayout } from './Sections/layout-mode'
import { FillsSection } from './Sections/FillsSection'
import { FillBindingSection } from './Sections/FillBindingSection'
import { StrokesSection } from './Sections/StrokesSection'
import { EffectsSection } from './Sections/EffectsSection'
import {
  ThreeDSceneSection,
  ThreeDObjectInspector,
  ThreeDCameraInspector,
} from './Sections/ThreeDObjectSection'
import { useSnapshot } from 'valtio'
import {
  scene3dProxy,
  isScene3D,
  sceneCameras,
  type Scene3DDocument,
} from '../../renderer/three/scene3d-store'
import { useScene3dEditing } from '../../renderer/three/use-scene3d-editing'

export interface NodePropertyPanelProps {
  nodeId: string
  initialNode: RectLikeNode
  readOnly: boolean
}

export function NodePropertyPanel({ nodeId, initialNode, readOnly }: NodePropertyPanelProps) {
  const snap = useSnapshot(scene3dProxy)
  const { editingSceneId } = useScene3dEditing()

  const scene = isScene3D(nodeId)
    ? (snap.scenes.get(nodeId) as Scene3DDocument | undefined)
    : undefined
  // An object is "in focus" — or a camera "selected" — only while editing THIS scene;
  // that's when the inspector swaps from the container's 2D chrome to the component
  // itself. The two are mutually exclusive (see setFocusedObject/setSelectedCamera).
  const editingThis = scene != null && editingSceneId === nodeId
  const focusedObject =
    editingThis && snap.focusedObjectId
      ? scene!.objects.find((o) => o.id === snap.focusedObjectId)
      : undefined
  const selectedCamera =
    editingThis && snap.selectedCameraId
      ? sceneCameras(scene!).find((c) => c.id === snap.selectedCameraId)
      : undefined

  // Camera context: a camera is a component of the scene, so its own properties (lens +
  // placement) are inspected alone — the strip's dropdown only switches between cameras.
  if (scene && selectedCamera) {
    return <ThreeDCameraInspector sceneId={nodeId} camera={selectedCamera} />
  }

  // Object context: inspect the focused object alone (its placeholder container's
  // 2D position/fills/etc. would only confuse — the object's own transform is below).
  if (scene && focusedObject) {
    return <ThreeDObjectInspector sceneId={nodeId} object={focusedObject} />
  }

  return (
    <>
      {readOnly ? (
        <p className="text-xs text-muted-foreground">
          Root frame is read-only here. Use the canvas to navigate.
        </p>
      ) : null}

      <NodeIdentitySection nodeId={nodeId} readOnly={readOnly} initialNode={initialNode} />

      <PositionSection nodeId={nodeId} initialNode={initialNode} readOnly={readOnly} />

      {scene && <ThreeDSceneSection scene={scene} editing={editingSceneId === nodeId} />}

      <MotionRestSection nodeId={nodeId} />

      <AppearanceSection nodeId={nodeId} initialNode={initialNode} readOnly={readOnly} />

      <ShapeSection nodeId={nodeId} initialNode={initialNode} readOnly={readOnly} />

      <SlotSection nodeId={nodeId} initialNode={initialNode} readOnly={readOnly} />

      <VectorEditSection nodeId={nodeId} initialNode={initialNode} readOnly={readOnly} />

      {isTextNode(initialNode) && (
        <TypographySection nodeId={nodeId} initialNode={initialNode} readOnly={readOnly} />
      )}

      {supportsLayout(initialNode) && (
        <NodeLayoutSection nodeId={nodeId} initialNode={initialNode} readOnly={readOnly} />
      )}

      <FillsSection nodeId={nodeId} readOnly={readOnly} initialNode={initialNode} />

      <FillBindingSection nodeId={nodeId} readOnly={readOnly} initialNode={initialNode} />

      <StrokesSection nodeId={nodeId} readOnly={readOnly} initialNode={initialNode} />

      <EffectsSection nodeId={nodeId} readOnly={readOnly} initialNode={initialNode} />
    </>
  )
}
