/**
 * Node Renderer Utilities
 *
 * Shared utilities for computing node positions and types.
 * Used by both Skia and other rendering engines.
 */

import type { DesignNode } from "@shared-types/types";
import type {
  FrameNodeData,
  SVGNodeData,
  TextNodeData,
} from "@components/nodes/node.types";

/**
 * Node with computed absolute position
 */
export interface AbsoluteNode {
  id: string;
  parentId?: string;
  x: number;
  y: number;
  absoluteX: number;
  absoluteY: number;
  width: number;
  height: number;
  type: string;
  data: FrameNodeData | SVGNodeData | TextNodeData;
}

/**
 * Compute absolute positions for all nodes by traversing the parent hierarchy
 */
export function computeAbsolutePositions(nodes: DesignNode[]): AbsoluteNode[] {
  // Build lookup maps
  const nodeMap = new Map<string, DesignNode>();
  const childrenMap = new Map<string, DesignNode[]>();

  for (const node of nodes) {
    nodeMap.set(node.id, node);
    if (node.parentId) {
      if (!childrenMap.has(node.parentId)) {
        childrenMap.set(node.parentId, []);
      }
      childrenMap.get(node.parentId)!.push(node);
    }
  }

  // Recursively compute absolute positions
  const result: AbsoluteNode[] = [];

  function processNode(
    node: DesignNode,
    parentAbsX: number,
    parentAbsY: number,
  ) {
    const localX = node.position?.x ?? 0;
    const localY = node.position?.y ?? 0;
    const absoluteX = parentAbsX + localX;
    const absoluteY = parentAbsY + localY;

    // Get width and height with proper type handling
    const nodeWidth =
      typeof node.width === "number"
        ? node.width
        : typeof node.data?.width === "number"
          ? node.data.width
          : 100;
    const nodeHeight =
      typeof node.height === "number"
        ? node.height
        : typeof node.data?.height === "number"
          ? node.data.height
          : 100;

    result.push({
      id: node.id,
      parentId: node.parentId,
      x: localX,
      y: localY,
      absoluteX,
      absoluteY,
      width: nodeWidth,
      height: nodeHeight,
      type: node.type,
      data: node.data as FrameNodeData | SVGNodeData | TextNodeData,
    });

    // Process children
    const children = childrenMap.get(node.id) || [];
    for (const child of children) {
      processNode(child, absoluteX, absoluteY);
    }
  }

  // Start from root nodes (no parent)
  for (const node of nodes) {
    if (!node.parentId) {
      processNode(node, 0, 0);
    }
  }

  return result;
}
