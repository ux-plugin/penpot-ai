import type { Node } from '@xyflow/react';

import { FrameProperties } from "@/shared/types/types.ts";

// Re-export FrameProperties for convenience
export type { FrameProperties };

/**
 * Type alias for a React Flow Node created from a Figma FrameNode.
 */
export type ReactFlowFrameNode = Node<{ label: string }, 'default'>;

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
  const opacity = locked ? LOCKED_OPACITY : frameProperties.opacity;

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
      backgroundColor: NODE_STYLES.backgroundColor,
      border: NODE_STYLES.border,
      borderRadius: NODE_STYLES.borderRadius,
      padding: NODE_STYLES.padding,
      minWidth: NODE_STYLES.minWidth,
      boxShadow: NODE_STYLES.boxShadow,
      opacity: opacity,
      transform: `rotate(${frameProperties.rotation}deg)`,
      cursor: locked ? NODE_STYLES.cursorLocked : NODE_STYLES.cursorNormal,
      fontSize: NODE_STYLES.fontSize,
      fontWeight: NODE_STYLES.fontWeight,
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

/**
 * Transforms an array of FrameProperties into a flat array of React Flow nodes.
 *
 * This is a convenience function that processes multiple root frames and their
 * nested children, creating a single flat array of React Flow nodes suitable
 * for direct use with ReactFlow.
 *
 * @param framePropertiesArray - Array of root FrameProperties to convert
 * @returns A flat array of all React Flow Node objects
 *
 * @example
 * ```tsx
 * import { getAllFrameNodes } from '@widget/utils/extractFrameProperties';
 * import { transformAllFramesToReactFlowNodes } from '@utils/createReactFlowNode';
 * import { ReactFlow } from '@xyflow/react';
 *
 * // Get all frames from canvas
 * const allFrames = getAllFrameNodes(commands);
 * 
 * // Transform to ReactFlow nodes
 * const reactFlowNodes = transformAllFramesToReactFlowNodes(allFrames);
 *
 * // Use in ReactFlow
 * <ReactFlow nodes={reactFlowNodes} />
 * ```
 */
export function transformAllFramesToReactFlowNodes(
  framePropertiesArray: FrameProperties[]
): ReactFlowFrameNode[] {
  const allNodes: ReactFlowFrameNode[] = [];

  for (const frameProperties of framePropertiesArray) {
    const nodes = createReactFlowNodesFromFrame(frameProperties);
    allNodes.push(...nodes);
  }

  return allNodes;
}
