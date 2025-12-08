import type {
  BaseSceneNode,
  IDesignPlatform,
  ViewportBounds,
} from "@widget/platform/IDesignPlatform";
import { FrameProperties, TextProperties } from "@/shared/types/types.ts";

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
 * Extracts all FrameNodes from the current page (entire canvas),
 * along with their children (recursively).
 *
 * Unlike getFrameNodesInViewport, this function returns ALL frames
 * on the canvas regardless of viewport visibility.
 *
 * @param commands - The design platform instance (e.g., Figma, Penpot, or Dev)
 * @returns An array of FrameProperties for all frames on the canvas
 *
 * @example
 * ```typescript
 * const commands = await platform.getInstance();
 * const allFrames = getAllFrameNodes(commands);
 * console.log('All frames on canvas:', allFrames);
 * ```
 */
export function getAllFrameNodes(
  commands: IDesignPlatform,
): FrameProperties[] {
  const currentPageChildren = commands.currentPage.children;
  const allFrames: FrameProperties[] = [];

  for (const child of currentPageChildren) {
    // Only process FRAME nodes
    if (child.type === "FRAME") {
      // Cast to FrameNode for the detailed property extraction
      const frameNode = child as unknown as FrameNode;
      // Extract all properties of the frame and its children
      allFrames.push(getAllFrameProperties(frameNode));
    }
  }

  return allFrames;
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

/**
 * Extracts all properties from a TextNode.
 * 
 * @param textNode - The TextNode to extract properties from
 * @returns TextProperties object containing all text node properties
 * 
 * @see https://developers.figma.com/docs/plugins/api/TextNode/
 */
export function getAllTextProperties(textNode: TextNode): TextProperties {
  const textProperties: TextProperties = {
    id: textNode.id,
    name: textNode.name,
    type: textNode.type,
    visible: textNode.visible,
    locked: textNode.locked,

    // Position and size
    x: textNode.x,
    y: textNode.y,
    width: textNode.width,
    height: textNode.height,
    rotation: textNode.rotation,

    // Text content
    characters: textNode.characters,

    // Text style properties
    fontSize: textNode.fontSize,
    fontName: textNode.fontName,
    textAlignHorizontal: textNode.textAlignHorizontal,
    textAlignVertical: textNode.textAlignVertical,
    letterSpacing: textNode.letterSpacing,
    lineHeight: textNode.lineHeight,
    textCase: textNode.textCase,
    textDecoration: textNode.textDecoration,

    // Style properties
    fills: textNode.fills,
    strokes: textNode.strokes,
    strokeWeight: textNode.strokeWeight,
    opacity: textNode.opacity,
    blendMode: textNode.blendMode,

    // Style IDs
    fillStyleId: textNode.fillStyleId,
    strokeStyleId: textNode.strokeStyleId,
    effectStyleId: textNode.effectStyleId,
    textStyleId: textNode.textStyleId,

    // Effects
    effects: textNode.effects,
  };

  return textProperties;
}

/**
 * Extracts all TextNodes from the current page (entire canvas).
 *
 * This function returns ALL text nodes on the canvas regardless of viewport visibility.
 *
 * @param commands - The design platform instance (e.g., Figma, Penpot, or Dev)
 * @returns An array of TextProperties for all text nodes on the canvas
 *
 * @example
 * ```typescript
 * const commands = await platform.getInstance();
 * const allTexts = getAllTextNodes(commands);
 * console.log('All text nodes on canvas:', allTexts);
 * ```
 */
export function getAllTextNodes(
  commands: IDesignPlatform,
): TextProperties[] {
  const currentPageChildren = commands.currentPage.children;
  const allTexts: TextProperties[] = [];

  for (const child of currentPageChildren) {
    // Only process TEXT nodes
    if (child.type === "TEXT") {
      // Cast to TextNode for the detailed property extraction
      const textNode = child as unknown as TextNode;
      // Extract all properties of the text node
      allTexts.push(getAllTextProperties(textNode));
    }
  }

  return allTexts;
}

/**
 * Extracts all TextNodes that are visible in the current user viewport.
 *
 * This function iterates through all top-level children of the current page
 * and returns the properties of TextNodes whose bounding boxes intersect
 * with the current viewport bounds.
 *
 * @param commands - The design platform instance (e.g., Figma, Penpot, or Dev)
 * @returns An array of TextProperties for text nodes visible in the viewport
 *
 * @example
 * ```typescript
 * const commands = await platform.getInstance();
 * const visibleTexts = getTextNodesInViewport(commands);
 * console.log('Text nodes in viewport:', visibleTexts);
 * ```
 */
export function getTextNodesInViewport(
  commands: IDesignPlatform,
): TextProperties[] {
  const viewportBounds = commands.viewport.bounds;
  const currentPageChildren = commands.currentPage.children;
  const textsInViewport: TextProperties[] = [];

  for (const child of currentPageChildren) {
    // Only process TEXT nodes
    if (child.type === "TEXT") {
      // Use BaseSceneNode properties for intersection check
      const node = child as BaseSceneNode;

      // Check if this text node intersects with the viewport
      if (isNodeInViewport(node, viewportBounds)) {
        // Cast to TextNode for the detailed property extraction
        const textNode = child as unknown as TextNode;
        // Extract all properties of the text node
        textsInViewport.push(getAllTextProperties(textNode));
      }
    }
  }

  return textsInViewport;
}
