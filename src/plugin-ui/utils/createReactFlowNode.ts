import type { Node } from '@xyflow/react';

/**
 * Data structure representing essential Figma FrameNode properties
 * that are relevant for creating a React Flow node.
 */
export interface FrameNodeData {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  locked: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  layoutMode: string;
  opacity: number;
  children?: FrameNodeData[];
}

/**
 * Extended data stored in the React Flow node's data property.
 * Contains the original frame properties plus any additional UI state.
 */
export interface ReactFlowFrameNodeData extends Record<string, unknown> {
  label: string;
  frameType: string;
  visible: boolean;
  locked: boolean;
  rotation: number;
  layoutMode: string;
  opacity: number;
  originalId: string;
}

/**
 * Type alias for a React Flow Node created from a Figma FrameNode.
 */
export type ReactFlowFrameNode = Node<ReactFlowFrameNodeData, 'frame'>;

/**
 * Creates a React Flow Node from Figma FrameNode information.
 *
 * This function transforms Figma FrameNode properties into a format
 * compatible with React Flow's Node interface, preserving essential
 * visual and layout information.
 *
 * @param frameNode - The Figma FrameNode data to convert
 * @param parentId - Optional parent node ID for nested frames
 * @returns A React Flow Node object representing the frame
 *
 * @see https://developers.figma.com/docs/plugins/api/FrameNode/
 * @see https://reactflow.dev/api-reference/types/node
 */
export function createReactFlowNode(
  frameNode: FrameNodeData,
  parentId?: string
): ReactFlowFrameNode {
  return {
    id: frameNode.id,
    type: 'frame',
    position: {
      x: frameNode.x,
      y: frameNode.y,
    },
    data: {
      label: frameNode.name,
      frameType: frameNode.type,
      visible: frameNode.visible,
      locked: frameNode.locked,
      rotation: frameNode.rotation,
      layoutMode: frameNode.layoutMode,
      opacity: frameNode.opacity,
      originalId: frameNode.id,
    },
    width: frameNode.width,
    height: frameNode.height,
    hidden: !frameNode.visible,
    draggable: !frameNode.locked,
    selectable: !frameNode.locked,
    ...(parentId && { parentId }),
  };
}

/**
 * Creates React Flow Nodes from a FrameNode and all its nested children.
 *
 * This function recursively processes a Figma FrameNode and its children,
 * creating a flat array of React Flow nodes suitable for use with React Flow.
 *
 * @param frameNode - The root Figma FrameNode data to convert
 * @param parentId - Optional parent node ID for the root frame
 * @returns An array of React Flow Node objects
 */
export function createReactFlowNodesFromFrame(
  frameNode: FrameNodeData,
  parentId?: string
): ReactFlowFrameNode[] {
  const nodes: ReactFlowFrameNode[] = [];

  // Create node for the current frame
  const currentNode = createReactFlowNode(frameNode, parentId);
  nodes.push(currentNode);

  // Recursively process children
  if (frameNode.children && frameNode.children.length > 0) {
    for (const child of frameNode.children) {
      const childNodes = createReactFlowNodesFromFrame(child, frameNode.id);
      nodes.push(...childNodes);
    }
  }

  return nodes;
}
