import { DesignNode, FrameNodeType, TextNodeType } from "@/shared/types/types.ts";
import { FigmaNodeType } from "../../../ReactFlowFrameNode.tsx";

// Re-export for convenience
export type { DesignNode, FrameNodeType, TextNodeType };

/**
 * Constants for node styling
 */
const LOCKED_OPACITY = 0.5;



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
 * This function recursively processes Figma FrameProperties and its children,
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

  // Create node for the current frame
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
 * This is a convenience function that processes multiple root frames and their
 * nested children, creating a single flat array of React Flow nodes suitable
 * for direct use with ReactFlow.
 *
 * @param framePropertiesArray - Array of root FrameProperties to convert
 * @returns A flat array of all React Flow Node objects
 *
 * @example
 * ```tsx
 * import { platform } from '@widget/platform';
 * import { transformAllFramesToReactFlowNodes } from '@utils/createReactFlowNode';
 * import { ReactFlow } from '@xyflow/react';
 *
 * // Get all nodes from platform (platform-specific implementation)
 * const commands = await platform.getInstance();
 * const allNodes = commands.getAllNodes();
 * const frames = allNodes.filter(node => node.type === 'FRAME');
 * 
 * // Transform to ReactFlow nodes
 * const reactFlowNodes = transformAllFramesToReactFlowNodes(frames);
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

/**
 * Creates a React Flow Node from Figma TextNodeType.
 *
 * This function transforms Figma TextNode properties into a format
 * compatible with React Flow's Node interface, with styling applied
 * directly in the node definition.
 *
 * @param textProperties - The Figma TextNodeType to convert
 * @returns A React Flow Node object representing the text node
 *
 * @example
 * ```tsx
 * import { createReactFlowTextNode } from '@utils/createReactFlowNode';
 * import { ReactFlow } from '@xyflow/react';
 *
 * // Create a node from text properties
 * const node = createReactFlowTextNode(textProperties);
 *
 * // Use in ReactFlow
 * <ReactFlow nodes={[node]} />
 * ```
 *
 * @see https://developers.figma.com/docs/plugins/api/TextNode/
 * @see https://reactflow.dev/api-reference/types/node
 */
export function createReactFlowTextNode(
  textProperties: TextProperties,
): FigmaNodeType {
  const locked = textProperties.locked;
  const opacity = locked ? LOCKED_OPACITY : textProperties.opacity;

  return {
    id: textProperties.id,
    type: 'textNode',
    position: {
      x: textProperties.x,
      y: textProperties.y,
    },
    data: {
      label: textProperties.name,
      locked: locked,
      visible: textProperties.visible,
      opacity: opacity,
      rotation: textProperties.rotation,
      nodeType: 'TEXT',
      text: textProperties.characters,
    },
    width: textProperties.width,
    height: textProperties.height,
    hidden: false,
    draggable: false,
    selectable: false,
  };
}

/**
 * Transforms an array of TextNodeType into an array of React Flow nodes.
 *
 * This is a convenience function that processes text nodes, creating
 * an array of React Flow nodes suitable for direct use with ReactFlow.
 *
 * @param textPropertiesArray - Array of TextNodeType to convert
 * @returns An array of all React Flow Node objects
 *
 * @example
 * ```tsx
 * import { platform } from '@widget/platform';
 * import { transformAllTextsToReactFlowNodes } from '@utils/createReactFlowNode';
 * import { ReactFlow } from '@xyflow/react';
 *
 * // Get all nodes from platform (platform-specific implementation)
 * const commands = await platform.getInstance();
 * const allNodes = commands.getAllNodes();
 * const texts = allNodes.filter(node => node.type === 'TEXT');
 * 
 * // Transform to ReactFlow nodes
 * const reactFlowNodes = transformAllTextsToReactFlowNodes(texts);
 *
 * // Use in ReactFlow
 * <ReactFlow nodes={reactFlowNodes} />
 * ```
 */
export function transformAllTextsToReactFlowNodes(
  textPropertiesArray: TextProperties[]
): FigmaNodeType[] {
  const allNodes: FigmaNodeType[] = [];

  for (const textProperties of textPropertiesArray) {
    const node = createReactFlowTextNode(textProperties);
    allNodes.push(node);
  }

  return allNodes;
}

/**
 * Transforms a DesignNode (frame or text) into React Flow nodes, including children recursively.
 *
 * This function handles the unified DesignNode type and preserves the hierarchy
 * by recursively transforming children.
 *
 * @param node - A DesignNode (FrameNodeType or TextNodeType) to convert
 * @returns An array of React Flow Node objects (flattened for ReactFlow)
 *
 * @example
 * ```tsx
 * import { transformDesignNodeToReactFlowNodes } from '@utils/createReactFlowNode';
 * import { ReactFlow } from '@xyflow/react';
 *
 * // Transform a design node with children
 * const reactFlowNodes = transformDesignNodeToReactFlowNodes(designNode);
 *
 * // Use in ReactFlow
 * <ReactFlow nodes={reactFlowNodes} />
 * ```
 */
export function transformDesignNodeToReactFlowNodes(
  node: DesignNode
): FigmaNodeType[] {
  const nodes: FigmaNodeType[] = [];

  if (node.type === 'FRAME') {
    // Create the frame node
    const frameNode = createReactFlowNode(node as FrameNodeType);
    nodes.push(frameNode);

    // Recursively process children if they exist
    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        const childNodes = transformDesignNodeToReactFlowNodes(child);
        nodes.push(...childNodes);
      }
    }
  } else if (node.type === 'TEXT') {
    // Create the text node
    const textNode = createReactFlowTextNode(node as TextNodeType);
    nodes.push(textNode);
  }

  return nodes;
}

/**
 * Transforms an array of DesignNodes into a flat array of React Flow nodes.
 *
 * This is the main transformation function that handles the unified node list
 * and preserves hierarchies for frames with children.
 *
 * @param designNodes - Array of DesignNodes to convert
 * @returns A flat array of all React Flow Node objects
 *
 * @example
 * ```tsx
 * import { transformDesignNodesToReactFlowNodes } from '@utils/createReactFlowNode';
 * import { ReactFlow } from '@xyflow/react';
 *
 * // Get all nodes from the API
 * const { nodes } = await getAllNodesResponse();
 * 
 * // Transform to ReactFlow nodes
 * const reactFlowNodes = transformDesignNodesToReactFlowNodes(nodes);
 *
 * // Use in ReactFlow
 * <ReactFlow nodes={reactFlowNodes} />
 * ```
 */
export function transformDesignNodesToReactFlowNodes(
  designNodes: DesignNode[]
): FigmaNodeType[] {
  const allNodes: FigmaNodeType[] = [];

  for (const node of designNodes) {
    const nodes = transformDesignNodeToReactFlowNodes(node);
    allNodes.push(...nodes);
  }

  return allNodes;
}
