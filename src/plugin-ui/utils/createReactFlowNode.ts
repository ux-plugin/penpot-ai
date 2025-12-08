import { FrameProperties } from "@/shared/types/types.ts";
import { FigmaNodeType } from "../../../ReactFlowFrameNode.tsx";

// Re-export FrameProperties for convenience
export type { FrameProperties };

/**
 * Constants for node styling
 */
const LOCKED_OPACITY = 0.5;



/**
 * Creates a React Flow Node from Figma FrameProperties.
 *
 * This function transforms Figma FrameNode, ComponentNode, or ComponentSetNode properties into a format
 * compatible with React Flow's Node interface, with styling applied
 * directly in the node definition.
 *
 * @param frameProperties - The Figma FrameProperties to convert
 * @param parentId - Optional parent node ID for nested frames
 * @returns A React Flow Node object representing the frame/component
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
 * @see https://developers.figma.com/docs/plugins/api/ComponentNode/
 * @see https://developers.figma.com/docs/plugins/api/ComponentSetNode/
 * @see https://reactflow.dev/api-reference/types/node
 */
export function createReactFlowNode(
  frameProperties: FrameProperties,
): FigmaNodeType {
  const locked = frameProperties.locked;
  const opacity = locked ? LOCKED_OPACITY : frameProperties.opacity;

  return {
    id: frameProperties.id,
    type: 'figmaNode',
    position: {
      x: frameProperties.x,
      y: frameProperties.y,
    },
    data: {
      label: frameProperties.name,
      locked: locked,
      visible: frameProperties.visible,
      opacity: opacity,
      rotation: frameProperties.rotation,
      nodeType: frameProperties.type as 'FRAME' | 'COMPONENT' | 'COMPONENT_SET',
    },
    width: frameProperties.width,
    height: frameProperties.height,
    hidden: false,
    draggable: false,
    selectable: false,
  };
}

/**
 * Creates React Flow Nodes from FrameProperties and all its nested children.
 *
 * This function recursively processes Figma FrameProperties (which can represent
 * FrameNode, ComponentNode, or ComponentSetNode) and its children,
 * creating a flat array of React Flow nodes suitable for use with React Flow.
 *
 * @param frameProperties - The root Figma FrameProperties to convert
 * @param parentId - Optional parent node ID for the root frame
 * @returns An array of React Flow Node objects
 */
export function createReactFlowNodesFromFrame(
  frameProperties: FrameProperties,
): FigmaNodeType[] {
  const nodes: FigmaNodeType[] = [];

  // Create node for the current frame/component
  const currentNode = createReactFlowNode(frameProperties);
  nodes.push(currentNode);

  // Recursively process children
  if (frameProperties.children && frameProperties.children.length > 0) {
    for (const child of frameProperties.children) {
      const childNodes = createReactFlowNodesFromFrame(child);
      nodes.push(...childNodes);
    }
  }

  return nodes;
}

/**
 * Transforms an array of FrameProperties into a flat array of React Flow nodes.
 *
 * This is a convenience function that processes multiple root frames (which can be
 * FrameNode, ComponentNode, or ComponentSetNode) and their nested children,
 * creating a single flat array of React Flow nodes suitable for direct use with ReactFlow.
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
 * // Get all frames, components, and component sets from canvas
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
): FigmaNodeType[] {
  const allNodes: FigmaNodeType[] = [];

  for (const frameProperties of framePropertiesArray) {
    const nodes = createReactFlowNodesFromFrame(frameProperties);
    allNodes.push(...nodes);
  }

  return allNodes;
}

