import type { RectLikeNode } from '../../renderer/properties/panel-utils'
import { NodeIdentitySection } from './Sections/NodeIdentitySection'
import { PositionSection } from './Sections/PositionSection'
import { MotionRestSection } from './Sections/MotionRestSection'
import { AppearanceSection } from './Sections/AppearanceSection'
import { ShapeSection } from './Sections/ShapeSection'
import { VectorEditSection } from './Sections/VectorEditSection'
import { TypographySection } from './Sections/TypographySection'
import { isTextNode } from './Sections/text-typography'
import { NodeLayoutSection } from './Sections/NodeLayoutSection'
import { supportsLayout } from './Sections/layout-mode'
import { FillsSection } from './Sections/FillsSection'
import { FillBindingSection } from './Sections/FillBindingSection'
import { StrokesSection } from './Sections/StrokesSection'
import { EffectsSection } from './Sections/EffectsSection'
import { ThreeDObjectSection } from './Sections/ThreeDObjectSection'
import { isScene3D } from '../../renderer/three/scene3d-store'

export interface NodePropertyPanelProps {
  nodeId: string
  initialNode: RectLikeNode
  readOnly: boolean
}

export function NodePropertyPanel({ nodeId, initialNode, readOnly }: NodePropertyPanelProps) {
  return (
    <>
      {readOnly ? (
        <p className="text-xs text-muted-foreground">
          Root frame is read-only here. Use the canvas to navigate.
        </p>
      ) : null}

      <NodeIdentitySection nodeId={nodeId} readOnly={readOnly} initialNode={initialNode} />

      <PositionSection nodeId={nodeId} initialNode={initialNode} readOnly={readOnly} />

      {isScene3D(nodeId) && <ThreeDObjectSection nodeId={nodeId} />}

      <MotionRestSection nodeId={nodeId} />

      <AppearanceSection nodeId={nodeId} initialNode={initialNode} readOnly={readOnly} />

      <ShapeSection nodeId={nodeId} initialNode={initialNode} readOnly={readOnly} />

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
