import type { Node } from '@xyflow/react';
import type { FrameProperties } from '@widget/utils/extractFrameProperties';

// Re-export FrameProperties for convenience
export type { FrameProperties };

/**
 * Type alias for a React Flow Node created from a Figma FrameNode.
 */
export type ReactFlowFrameNode = Node<{ label: string }, 'default'>;

/**
 * Creates a React Flow Node from Figma FrameProperties.
 *
 * This function transforms Figma FrameNode properties into a format
 * compatible with React Flow's Node interface, with styling applied
 * directly in the node definition.
 *
 * @param frameProperties - The Figma FrameProperties to convert
 * @param parentId - Optional parent node ID for nested frames
 * @returns A React Flow Node object representing the frame
 *
 * @example
 * ```tsx
 * import { createReactFlowNode } from '@utils/createReactFlowNode';
 * import { ReactFlow } from '@xyflow/react';
 *
 * // Create a node from frame properties
 * const node = createReactFlowNode(frameProperties);
 *
 * // Use in ReactFlow
 * <ReactFlow nodes={[node]} />
 * ```
 *
 * @see https://developers.figma.com/docs/plugins/api/FrameNode/
 * @see https://reactflow.dev/api-reference/types/node
 */
export function createReactFlowNode(
  frameProperties: FrameProperties,
  parentId?: string
): ReactFlowFrameNode {
  const locked = frameProperties.locked;
  const visible = frameProperties.visible;
  const opacity = locked ? 0.5 : frameProperties.opacity;
  
  return {
    id: frameProperties.id,
    type: 'default',
    position: {
      x: frameProperties.x,
      y: frameProperties.y,
    },
    data: {
      label: frameProperties.name,
    },
    width: frameProperties.width,
    height: frameProperties.height,
    hidden: !visible,
    draggable: !locked,
    selectable: !locked,
    style: {
      backgroundColor: '#ffffff',
      border: '2px solid #d1d5db',
      borderRadius: '8px',
      padding: '12px 16px',
      minWidth: '150px',
      boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
      opacity: opacity,
      transform: `rotate(${frameProperties.rotation}deg)`,
      cursor: locked ? 'not-allowed' : 'grab',
      fontSize: '14px',
      fontWeight: 600,
    },
    ...(parentId && { parentId }),
  };
}

/**
 * Creates React Flow Nodes from FrameProperties and all its nested children.
 *
 * This function recursively processes Figma FrameProperties and its children,
 * creating a flat array of React Flow nodes suitable for use with React Flow.
 *
 * @param frameProperties - The root Figma FrameProperties to convert
 * @param parentId - Optional parent node ID for the root frame
 * @returns An array of React Flow Node objects
 */
export function createReactFlowNodesFromFrame(
  frameProperties: FrameProperties,
  parentId?: string
): ReactFlowFrameNode[] {
  const nodes: ReactFlowFrameNode[] = [];

  // Create node for the current frame
  const currentNode = createReactFlowNode(frameProperties, parentId);
  nodes.push(currentNode);

  // Recursively process children
  if (frameProperties.children && frameProperties.children.length > 0) {
    for (const child of frameProperties.children) {
      const childNodes = createReactFlowNodesFromFrame(child, frameProperties.id);
      nodes.push(...childNodes);
    }
  }

  return nodes;
}
