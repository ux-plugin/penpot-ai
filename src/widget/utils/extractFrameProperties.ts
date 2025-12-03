import type {
  BaseSceneNode,
  IDesignPlatform,
  ViewportBounds,
} from "@widget/platform/IDesignPlatform";
import { FrameProperties } from "@/shared/types/types.ts";

export function getAllFrameProperties(frameNode: FrameNode): FrameProperties {
  const frameProperties: FrameProperties = {
    id: frameNode.id,
    name: frameNode.name,
    type: frameNode.type,
    visible: frameNode.visible,
    locked: frameNode.locked,

    // Position and size
    x: frameNode.x,
    y: frameNode.y,
    width: frameNode.width,
    height: frameNode.height,
    rotation: frameNode.rotation,

    // Layout properties
    layoutMode: frameNode.layoutMode,
    layoutAlign: frameNode.layoutAlign,
    layoutGrow: frameNode.layoutGrow,
    primaryAxisSizingMode: frameNode.primaryAxisSizingMode,
    counterAxisSizingMode: frameNode.counterAxisSizingMode,
    primaryAxisAlignItems: frameNode.primaryAxisAlignItems,
    counterAxisAlignItems: frameNode.counterAxisAlignItems,
    paddingLeft: frameNode.paddingLeft,
    paddingRight: frameNode.paddingRight,
    paddingTop: frameNode.paddingTop,
    paddingBottom: frameNode.paddingBottom,
    itemSpacing: frameNode.itemSpacing,

    // Style properties
    fills: frameNode.fills,
    strokes: frameNode.strokes,
    strokeWeight: frameNode.strokeWeight,
    strokeAlign: frameNode.strokeAlign,
    cornerRadius: frameNode.cornerRadius,
    opacity: frameNode.opacity,
    blendMode: frameNode.blendMode,

    // Style IDs
    fillStyleId: frameNode.fillStyleId,
    strokeStyleId: frameNode.strokeStyleId,
    effectStyleId: frameNode.effectStyleId,

    // Effects and other styles
    effects: frameNode.effects,

    // Initialize an empty children array
    children: [],
  };

  // Recursively get properties of all children frames
  frameNode.children.forEach((child) => {
    if (child.type === "FRAME") {
      frameProperties.children.push(getAllFrameProperties(child as FrameNode));
    }
  });

  return frameProperties;
}

/**
 * Checks if a node's bounding box intersects with the viewport bounds.
 * Uses axis-aligned bounding box (AABB) intersection test.
 * @param node - The scene node to check (must have x, y, width, height properties)
 * @param viewportBounds - The viewport bounds to check against
 * @returns True if the node intersects with the viewport, false otherwise
 */
function isNodeInViewport(
  node: { x: number; y: number; width: number; height: number },
  viewportBounds: ViewportBounds,
): boolean {
  const nodeRight = node.x + node.width;
  const nodeBottom = node.y + node.height;
  const viewportRight = viewportBounds.x + viewportBounds.width;
  const viewportBottom = viewportBounds.y + viewportBounds.height;

  // Check for non-intersection (any of these means no intersection)
  const noIntersection =
    nodeRight < viewportBounds.x ||
    node.x > viewportRight ||
    nodeBottom < viewportBounds.y ||
    node.y > viewportBottom;

  return !noIntersection;
}

/**
 * Extracts all FrameNodes that are visible in the current user viewport,
 * along with their children (recursively).
 *
 * This function iterates through all top-level children of the current page
 * and returns the properties of FrameNodes whose bounding boxes intersect
 * with the current viewport bounds.
 *
 * @param commands - The design platform instance (e.g., Figma, Penpot, or Dev)
 * @returns An array of FrameProperties for frames visible in the viewport
 *
 * @example
 * ```typescript
 * const commands = await platform.getInstance();
 * const visibleFrames = getFrameNodesInViewport(commands);
 * console.log('Frames in viewport:', visibleFrames);
 * ```
 */
export function getFrameNodesInViewport(
  commands: IDesignPlatform,
): FrameProperties[] {
  const viewportBounds = commands.viewport.bounds;
  const currentPageChildren = commands.currentPage.children;
  const framesInViewport: FrameProperties[] = [];

  for (const child of currentPageChildren) {
    // Only process FRAME nodes
    if (child.type === "FRAME") {
      // Use BaseSceneNode properties for intersection check, then cast to FrameNode for getAllFrameProperties
      const node = child as BaseSceneNode;

      // Check if this frame intersects with the viewport
      if (isNodeInViewport(node, viewportBounds)) {
        // Cast to FrameNode for the detailed property extraction
        const frameNode = child as unknown as FrameNode;
        // Extract all properties of the frame and its children
        framesInViewport.push(getAllFrameProperties(frameNode));
      }
    }
  }

  return framesInViewport;
}
