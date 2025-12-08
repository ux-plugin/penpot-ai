import { memo } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import { Handle as HandleComponent, Position as PositionEnum } from '@xyflow/react';

/**
 * Interface for Figma Node data
 */
export interface FigmaNodeData extends Record<string, unknown> {
  label: string;
  locked?: boolean;
  visible?: boolean;
  opacity?: number;
  rotation?: number;
  nodeType?: 'FRAME' | 'COMPONENT' | 'COMPONENT_SET';
}

/**
 * Type for a React Flow Node created from a Figma FrameNode, ComponentNode, or ComponentSetNode.
 */
export type FigmaNodeType = Node<FigmaNodeData, 'figmaNode'>;

/**
 * Constants for node styling
 */
const LOCKED_OPACITY = 0.5;

const NODE_STYLES = {
  backgroundColor: '#ffffff',
  border: '2px solid #d1d5db',
  borderRadius: '8px',
  padding: '12px 16px',
  minWidth: '150px',
  boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
  fontSize: 14,
  fontWeight: 600,
  cursorNormal: 'grab',
  cursorLocked: 'not-allowed',
} as const;

const NODE_TYPE_STYLES = {
  FRAME: {
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
  },
  COMPONENT: {
    borderColor: '#8b5cf6',
    backgroundColor: '#f5f3ff',
  },
  COMPONENT_SET: {
    borderColor: '#a855f7',
    backgroundColor: '#faf5ff',
  },
} as const;

/**
 * React Flow Frame Node Component
 * 
 * A memoized React component that renders a Figma frame, component, or component set as a React Flow node.
 * Supports locked state, visibility, rotation, and custom styling.
 * Different node types (FRAME, COMPONENT, COMPONENT_SET) are visually distinguished by border and background colors.
 * 
 * @param props - NodeProps containing node data and dimensions
 * @returns A styled node component with handles for connections
 */
export const ReactFlowFrameNode = memo((props: NodeProps<Node<FigmaNodeData>>) => {
  const { data, width = 150, positionAbsoluteX, positionAbsoluteY } = props;
  const locked = data?.locked ?? false;
  const opacity = locked ? LOCKED_OPACITY : (data?.opacity ?? 1);
  const rotation = data?.rotation ?? 0;
  const label = data?.label ?? '';
  const nodeType = data?.nodeType ?? 'FRAME';

  // Get type-specific styling
  const typeStyles = NODE_TYPE_STYLES[nodeType];

  console.log(`[ReactFlowFrameNode] Rendering ${nodeType} node "${label}" at position:`, {
    x: positionAbsoluteX,
    y: positionAbsoluteY,
    label,
    nodeType,
  });

  return (
    <div
      className="figma-node"
      style={{
        backgroundColor: typeStyles.backgroundColor,
        border: `2px solid ${typeStyles.borderColor}`,
        borderRadius: NODE_STYLES.borderRadius,
        padding: NODE_STYLES.padding,
        minWidth: typeof width === 'number' ? width : NODE_STYLES.minWidth,
        boxShadow: NODE_STYLES.boxShadow,
        opacity: opacity,
        transform: `rotate(${rotation}deg)`,
        cursor: locked ? NODE_STYLES.cursorLocked : NODE_STYLES.cursorNormal,
        fontSize: NODE_STYLES.fontSize,
        fontWeight: NODE_STYLES.fontWeight,
      }}
    >
      <div className="figma-node-content">
        <div className="figma-node-label">{label}</div>
        {nodeType !== 'FRAME' && (
          <div style={{ fontSize: 10, color: '#6b7280', marginTop: 4 }}>
            {nodeType === 'COMPONENT' ? '◆ Component' : '◆ Component Set'}
          </div>
        )}
      </div>
      <HandleComponent
        type="target"
        position={PositionEnum.Top}
        style={{ opacity: 0 }}
      />
      <HandleComponent
        type="source"
        position={PositionEnum.Bottom}
        style={{ opacity: 0 }}
      />
    </div>
  );
});

ReactFlowFrameNode.displayName = 'ReactFlowFrameNode';
