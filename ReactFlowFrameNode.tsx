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
  nodeType?: 'FRAME' | 'TEXT';
  text?: string;
}

/**
 * Type for a React Flow Node created from a Figma FrameNode or TextNode.
 */
export type FigmaNodeType = Node<FigmaNodeData, 'figmaNode' | 'textNode'>;

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

/**
 * React Flow Frame Node Component
 * 
 * A memoized React component that renders a Figma frame as a React Flow node.
 * Supports locked state, visibility, rotation, and custom styling.
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

  console.log(`[ReactFlowFrameNode] Rendering node "${label}" at position:`, {
    x: positionAbsoluteX,
    y: positionAbsoluteY,
    label,
  });

  return (
    <div
      className="figma-node"
      style={{
        backgroundColor: NODE_STYLES.backgroundColor,
        border: NODE_STYLES.border,
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

/**
 * React Flow Text Node Component
 * 
 * A memoized React component that renders a Figma text node as a React Flow node.
 * Supports locked state, visibility, rotation, and displays text content.
 * 
 * @param props - NodeProps containing node data and dimensions
 * @returns A styled node component with handles for connections
 */
export const ReactFlowTextNode = memo((props: NodeProps<Node<FigmaNodeData>>) => {
  const { data, width = 150, positionAbsoluteX, positionAbsoluteY } = props;
  const locked = data?.locked ?? false;
  const opacity = locked ? LOCKED_OPACITY : (data?.opacity ?? 1);
  const rotation = data?.rotation ?? 0;
  const label = data?.label ?? '';
  const text = data?.text ?? '';

  console.log(`[ReactFlowTextNode] Rendering text node "${label}" at position:`, {
    x: positionAbsoluteX,
    y: positionAbsoluteY,
    label,
    text: text.substring(0, 50) + (text.length > 50 ? '...' : ''),
  });

  return (
    <div
      className="figma-text-node"
      style={{
        backgroundColor: '#f3f4f6',
        border: '2px dashed #9ca3af',
        borderRadius: '4px',
        padding: '8px 12px',
        minWidth: typeof width === 'number' ? width : NODE_STYLES.minWidth,
        boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
        opacity: opacity,
        transform: `rotate(${rotation}deg)`,
        cursor: locked ? NODE_STYLES.cursorLocked : NODE_STYLES.cursorNormal,
        fontSize: NODE_STYLES.fontSize,
        fontWeight: NODE_STYLES.fontWeight,
      }}
    >
      <div className="figma-text-node-content">
        <div className="figma-text-node-label" style={{ fontWeight: 700, marginBottom: '4px', color: '#4b5563' }}>
          {label}
        </div>
        <div className="figma-text-node-text" style={{ 
          fontSize: '12px', 
          color: '#6b7280',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: '100px',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}>
          {text}
        </div>
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

ReactFlowTextNode.displayName = 'ReactFlowTextNode';
