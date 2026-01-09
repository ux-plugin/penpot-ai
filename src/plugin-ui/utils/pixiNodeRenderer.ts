/**
 * PixiJS Node Renderer Utilities
 *
 * Converts Figma node properties to PixiJS graphics for GPU-accelerated rendering.
 * Handles fills, strokes, corner radius, blend modes, and SVG textures.
 * Returns React component props for use with @pixi/react.
 */

import React from "react";
import { Graphics, Sprite, Assets, Container, Texture } from "pixi.js";
import type { BLEND_MODES } from "pixi.js";
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
 * Figma blend mode to PixiJS blend mode mapping
 */
export const figmaToPixiBlendMode: Record<string, BLEND_MODES> = {
  PASS_THROUGH: "normal" as BLEND_MODES,
  NORMAL: "normal" as BLEND_MODES,
  DARKEN: "darken" as BLEND_MODES,
  MULTIPLY: "multiply" as BLEND_MODES,
  COLOR_BURN: "color-burn" as BLEND_MODES,
  LIGHTEN: "lighten" as BLEND_MODES,
  SCREEN: "screen" as BLEND_MODES,
  COLOR_DODGE: "color-dodge" as BLEND_MODES,
  OVERLAY: "overlay" as BLEND_MODES,
  SOFT_LIGHT: "soft-light" as BLEND_MODES,
  HARD_LIGHT: "hard-light" as BLEND_MODES,
  DIFFERENCE: "difference" as BLEND_MODES,
  EXCLUSION: "exclusion" as BLEND_MODES,
  HUE: "hue" as BLEND_MODES,
  SATURATION: "saturation" as BLEND_MODES,
  COLOR: "color" as BLEND_MODES,
  LUMINOSITY: "luminosity" as BLEND_MODES,
};

/**
 * Convert Figma RGBA color (0-1 range) to hex number
 */
export function figmaColorToHex(color: {
  r: number;
  g: number;
  b: number;
}): number {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  return (r << 16) | (g << 8) | b;
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

/**
 * Draw a rounded rectangle with per-corner radius support
 */
function drawRoundedRectWithCorners(
  g: Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  tl: number,
  tr: number,
  br: number,
  bl: number,
) {
  // Clamp radii to not exceed half of width/height
  const maxRadius = Math.min(w / 2, h / 2);
  tl = Math.min(tl, maxRadius);
  tr = Math.min(tr, maxRadius);
  br = Math.min(br, maxRadius);
  bl = Math.min(bl, maxRadius);

  g.moveTo(x + tl, y);
  g.lineTo(x + w - tr, y);
  if (tr > 0) g.arcTo(x + w, y, x + w, y + tr, tr);
  g.lineTo(x + w, y + h - br);
  if (br > 0) g.arcTo(x + w, y + h, x + w - br, y + h, br);
  g.lineTo(x + bl, y + h);
  if (bl > 0) g.arcTo(x, y + h, x, y + h - bl, bl);
  g.lineTo(x, y + tl);
  if (tl > 0) g.arcTo(x, y, x + tl, y, tl);
  g.closePath();
}

/**
 * Draw a Figma frame node as PixiJS Graphics
 */
export function drawFigmaFrame(
  data: FrameNodeData,
  width: number,
  height: number,
): Graphics {
  const g = new Graphics();

  // Get corner radius
  const cr = data.cornerRadius || {
    topLeft: 0,
    topRight: 0,
    bottomRight: 0,
    bottomLeft: 0,
  };
  const { topLeft, topRight, bottomRight, bottomLeft } = cr;
  const isUniformRadius =
    topLeft === topRight &&
    topRight === bottomRight &&
    bottomRight === bottomLeft;

  // Handle fills
  if (data.fills && data.fills.length > 0) {
    const fill = data.fills[0] as Paint;
    if (fill.visible !== false && fill.type === "SOLID" && fill.color) {
      const color = figmaColorToHex(fill.color);
      const alpha = fill.opacity ?? 1;
      g.fill({ color, alpha });
    } else {
      g.fill({ color: 0xffffff, alpha: 0 });
    }
  } else {
    g.fill({ color: 0xffffff, alpha: 0 });
  }

  // Draw shape
  if (isUniformRadius && topLeft > 0) {
    g.roundRect(0, 0, width, height, topLeft);
  } else if (
    !isUniformRadius &&
    (topLeft > 0 || topRight > 0 || bottomRight > 0 || bottomLeft > 0)
  ) {
    drawRoundedRectWithCorners(
      g,
      0,
      0,
      width,
      height,
      topLeft,
      topRight,
      bottomRight,
      bottomLeft,
    );
  } else {
    g.rect(0, 0, width, height);
  }
  g.fill();

  // Handle strokes
  if (data.strokes && data.strokes.length > 0 && data.strokeWeight) {
    const stroke = data.strokes[0] as Paint;
    if (stroke.visible !== false && stroke.type === "SOLID" && stroke.color) {
      const strokeColor = figmaColorToHex(stroke.color);
      const strokeWidth = data.strokeWeight.top || 1;

      // Stroke alignment: 0 = outer, 0.5 = center, 1 = inner
      const alignment =
        data.strokeAlign === "INSIDE"
          ? 1
          : data.strokeAlign === "OUTSIDE"
            ? 0
            : 0.5;

      g.stroke({ color: strokeColor, width: strokeWidth, alignment });

      // Redraw shape for stroke
      if (isUniformRadius && topLeft > 0) {
        g.roundRect(0, 0, width, height, topLeft);
      } else if (
        !isUniformRadius &&
        (topLeft > 0 || topRight > 0 || bottomRight > 0 || bottomLeft > 0)
      ) {
        drawRoundedRectWithCorners(
          g,
          0,
          0,
          width,
          height,
          topLeft,
          topRight,
          bottomRight,
          bottomLeft,
        );
      } else {
        g.rect(0, 0, width, height);
      }
      g.stroke();
    }
  }

  return g;
}

/**
 * Draw a bounding box (transparent rectangle for hit detection)
 */
export function drawBoundingBox(width: number, height: number): Graphics {
  const g = new Graphics();
  g.fill({ color: 0x3b82f6, alpha: 0 });
  g.rect(0, 0, width, height);
  g.fill();
  return g;
}

/**
 * Create a Sprite from an SVG string
 */
export async function createSVGSprite(
  svg: string,
  width: number,
  height: number,
): Promise<Sprite> {
  const svgString = svg;

  // Create blob URL from SVG
  const svgBlob = new Blob([svgString], {
    type: "image/svg+xml;charset=utf-8",
  });
  const url = URL.createObjectURL(svgBlob);

  try {
    // Load texture
    const texture = await Assets.load(url);
    const sprite = new Sprite(texture);
    sprite.width = width;
    sprite.height = height;
    return sprite;
  } finally {
    // Clean up blob URL
    URL.revokeObjectURL(url);
  }
}

/**
 * Create a placeholder graphics for loading state
 */
export function createLoadingPlaceholder(
  width: number,
  height: number,
): Graphics {
  const g = new Graphics();
  g.fill({ color: 0xf3f4f6, alpha: 1 });
  g.rect(0, 0, width, height);
  g.fill();

  // Draw loading indicator (simple border)
  g.stroke({ color: 0xd1d5db, width: 1 });
  g.rect(0, 0, width, height);
  g.stroke();

  return g;
}

/**
 * React component props for a PixiJS node
 */
export interface PixiNodeComponentProps {
  key: string;
  x: number;
  y: number;
  rotation?: number;
  alpha?: number;
  blendMode?: BLEND_MODES;
  eventMode?: "static" | "dynamic" | "passive" | "auto" | "none";
  cursor?: string;
  onPointerDown?: (event: any) => void;
  onPointerEnter?: (event: any) => void;
  onPointerLeave?: (event: any) => void;
  children?: React.ReactNode;
}

/**
 * Props for a pixiGraphics component
 */
export interface PixiGraphicsProps extends PixiNodeComponentProps {
  draw: (graphics: Graphics) => void;
}

/**
 * Props for a pixiSprite component
 */
export interface PixiSpriteProps extends PixiNodeComponentProps {
  texture: Texture;
  width: number;
  height: number;
}

/**
 * Union type for node component props
 */
export type NodeComponentProps = PixiGraphicsProps | PixiSpriteProps;

/**
 * Create a draw function for Graphics component from FrameNodeData
 */
function createFrameDrawFunction(
  data: FrameNodeData,
  width: number,
  height: number,
): (graphics: Graphics) => void {
  return (g: Graphics) => {
    // Get corner radius
    const cr = data.cornerRadius || {
      topLeft: 0,
      topRight: 0,
      bottomRight: 0,
      bottomLeft: 0,
    };
    const { topLeft, topRight, bottomRight, bottomLeft } = cr;
    const isUniformRadius =
      topLeft === topRight &&
      topRight === bottomRight &&
      bottomRight === bottomLeft;

    // Handle fills
    if (data.fills && data.fills.length > 0) {
      const fill = data.fills[0] as Paint;
      if (fill.visible !== false && fill.type === "SOLID" && fill.color) {
        const color = figmaColorToHex(fill.color);
        const alpha = fill.opacity ?? 1;
        g.fill({ color, alpha });
      } else {
        g.fill({ color: 0xffffff, alpha: 0 });
      }
    } else {
      g.fill({ color: 0xffffff, alpha: 0 });
    }

    // Draw shape
    if (isUniformRadius && topLeft > 0) {
      g.roundRect(0, 0, width, height, topLeft);
    } else if (
      !isUniformRadius &&
      (topLeft > 0 || topRight > 0 || bottomRight > 0 || bottomLeft > 0)
    ) {
      drawRoundedRectWithCorners(
        g,
        0,
        0,
        width,
        height,
        topLeft,
        topRight,
        bottomRight,
        bottomLeft,
      );
    } else {
      g.rect(0, 0, width, height);
    }
    g.fill();

    // Handle strokes
    if (data.strokes && data.strokes.length > 0 && data.strokeWeight) {
      const stroke = data.strokes[0] as Paint;
      if (stroke.visible !== false && stroke.type === "SOLID" && stroke.color) {
        const strokeColor = figmaColorToHex(stroke.color);
        const strokeWidth = data.strokeWeight.top || 1;

        // Stroke alignment: 0 = outer, 0.5 = center, 1 = inner
        const alignment =
          data.strokeAlign === "INSIDE"
            ? 1
            : data.strokeAlign === "OUTSIDE"
              ? 0
              : 0.5;

        g.stroke({ color: strokeColor, width: strokeWidth, alignment });

        // Redraw shape for stroke
        if (isUniformRadius && topLeft > 0) {
          g.roundRect(0, 0, width, height, topLeft);
        } else if (
          !isUniformRadius &&
          (topLeft > 0 || topRight > 0 || bottomRight > 0 || bottomLeft > 0)
        ) {
          drawRoundedRectWithCorners(
            g,
            0,
            0,
            width,
            height,
            topLeft,
            topRight,
            bottomRight,
            bottomLeft,
          );
        } else {
          g.rect(0, 0, width, height);
        }
        g.stroke();
      }
    }
  };
}

/**
 * Create a draw function for bounding box Graphics component
 */
function createBoundingBoxDrawFunction(
  width: number,
  height: number,
): (graphics: Graphics) => void {
  return (g: Graphics) => {
    g.fill({ color: 0x3b82f6, alpha: 0 });
    g.rect(0, 0, width, height);
    g.fill();
  };
}

/**
 * Create a draw function for loading placeholder Graphics component
 */
function createLoadingPlaceholderDrawFunction(
  width: number,
  height: number,
): (graphics: Graphics) => void {
  return (g: Graphics) => {
    g.fill({ color: 0xf3f4f6, alpha: 1 });
    g.rect(0, 0, width, height);
    g.fill();

    // Draw loading indicator (simple border)
    g.stroke({ color: 0xd1d5db, width: 1 });
    g.rect(0, 0, width, height);
    g.stroke();
  };
}

/**
 * Load SVG texture for sprite component
 */
export async function loadSVGTexture(svg: string): Promise<Texture> {
  const svgString = svg;

  // Create blob URL from SVG
  const svgBlob = new Blob([svgString], {
    type: "image/svg+xml;charset=utf-8",
  });
  const url = URL.createObjectURL(svgBlob);

  try {
    // Load texture
    const texture = await Assets.load(url);
    return texture;
  } finally {
    // Clean up blob URL
    URL.revokeObjectURL(url);
  }
}

/**
 * Render a single node to React component props
 */
export async function renderNodeToComponentProps(
  node: AbsoluteNode,
  onNodeClick?: (nodeId: string) => void,
): Promise<NodeComponentProps> {
  try {
    const { width, height, data } = node;
    const renderMode = data.renderMode || "css";

    const baseProps: PixiNodeComponentProps = {
      key: node.id,
      x: node.absoluteX,
      y: node.absoluteY,
      rotation: ((data.rotation || 0) * Math.PI) / 180,
      alpha: data.opacity ?? 1,
      eventMode: "static",
      cursor: "pointer",
    };

    // Apply blend mode
    if (data.blendMode && typeof data.blendMode === "string") {
      const blendMode = figmaToPixiBlendMode[data.blendMode];
      if (blendMode) {
        baseProps.blendMode = blendMode;
      }
    }

    // Click handler
    if (onNodeClick) {
      baseProps.onPointerDown = () => onNodeClick(node.id);
    }

    // Hover effect
    const originalAlpha = data.opacity ?? 1;
    baseProps.onPointerEnter = (event: any) => {
      if (event.target) {
        event.target.alpha = Math.max(0.7, originalAlpha - 0.2);
      }
    };
    baseProps.onPointerLeave = (event: any) => {
      if (event.target) {
        event.target.alpha = originalAlpha;
      }
    };

    if (renderMode === "svg" && data.svg) {
      // Render as SVG sprite
      try {
        const texture = await loadSVGTexture(data.svg);
        const spriteProps: PixiSpriteProps = {
          ...baseProps,
          texture,
          width,
          height,
        };
        return spriteProps;
      } catch (error) {
        console.error(
          `[PixiRenderer] Failed to load SVG for node ${node.id}:`,
          error,
        );
        // Fall through to graphics rendering
      }
    }

    // Render as graphics (frame, bounding box, or fallback)
    let drawFunction: (graphics: Graphics) => void;
    if (renderMode === "bounding-box") {
      drawFunction = createBoundingBoxDrawFunction(width, height);
    } else if (renderMode === "svg" && data.svg) {
      // Fallback to loading placeholder if SVG failed
      drawFunction = createLoadingPlaceholderDrawFunction(width, height);
    } else {
      // Render as frame with fills/strokes (css mode or fallback)
      drawFunction = createFrameDrawFunction(
        data as FrameNodeData,
        width,
        height,
      );
    }

    const graphicsProps: PixiGraphicsProps = {
      ...baseProps,
      draw: drawFunction,
    };

    return graphicsProps;
  } catch (error) {
    console.error(`[PixiRenderer] Failed to render node ${node.id}:`, error);
    // Return a placeholder graphics component
    return {
      key: node.id,
      x: node.absoluteX,
      y: node.absoluteY,
      draw: createLoadingPlaceholderDrawFunction(
        node.width || 100,
        node.height || 100,
      ),
      eventMode: "static",
    };
  }
}

/**
 * Legacy function: Render a single node to a PixiJS Container
 * @deprecated Use renderNodeToComponentProps instead
 */
export async function renderNodeToContainer(
  node: AbsoluteNode,
  onNodeClick?: (nodeId: string) => void,
): Promise<Container> {
  try {
    const container = new Container();
    const { width, height, data } = node;
    const renderMode = data.renderMode || "css";

    let displayObject: Graphics | Sprite;

    if (renderMode === "svg" && data.svg) {
      // Render as SVG sprite
      try {
        displayObject = await createSVGSprite(data.svg, width, height);
      } catch (error) {
        console.error(
          `[PixiRenderer] Failed to load SVG for node ${node.id}:`,
          error,
        );
        displayObject = createLoadingPlaceholder(width, height);
      }
    } else if (renderMode === "bounding-box") {
      // Render as transparent bounding box
      displayObject = drawBoundingBox(width, height);
    } else {
      // Render as frame with fills/strokes (css mode or fallback)
      displayObject = drawFigmaFrame(data as FrameNodeData, width, height);
    }

    container.addChild(displayObject);

    // Apply transformations
    container.x = node.absoluteX;
    container.y = node.absoluteY;
    container.rotation = ((data.rotation || 0) * Math.PI) / 180;
    container.alpha = data.opacity ?? 1;

    // Apply blend mode
    if (data.blendMode && typeof data.blendMode === "string") {
      const blendMode = figmaToPixiBlendMode[data.blendMode];
      if (blendMode) {
        container.blendMode = blendMode;
      }
    }

    // Make interactive
    container.eventMode = "static";
    container.cursor = "pointer";

    // Click handler
    if (onNodeClick) {
      container.on("pointerdown", () => onNodeClick(node.id));
    }

    // Hover effect
    const originalAlpha = data.opacity ?? 1;
    container.on("pointerover", () => {
      container.alpha = Math.max(0.7, originalAlpha - 0.2);
    });
    container.on("pointerout", () => {
      container.alpha = originalAlpha;
    });

    // Store node id for debugging
    container.label = node.id;

    return container;
  } catch (error) {
    console.error(`[PixiRenderer] Failed to render node ${node.id}:`, error);
    // Return a placeholder container instead of crashing
    const placeholder = new Container();
    placeholder.label = node.id;
    return placeholder;
  }
}

/**
 * Batch render all nodes to React component props
 */
export async function renderAllNodesToComponentProps(
  nodes: DesignNode[],
  onNodeClick?: (nodeId: string) => void,
): Promise<NodeComponentProps[]> {
  // Compute absolute positions
  const absoluteNodes = computeAbsolutePositions(nodes);

  // Render all nodes in parallel
  const componentProps = await Promise.all(
    absoluteNodes.map((node) => renderNodeToComponentProps(node, onNodeClick)),
  );

  return componentProps;
}

/**
 * Legacy function: Batch render all nodes to containers
 * @deprecated Use renderAllNodesToComponentProps instead
 */
export async function renderAllNodes(
  nodes: DesignNode[],
  onNodeClick?: (nodeId: string) => void,
): Promise<Container[]> {
  // Compute absolute positions
  const absoluteNodes = computeAbsolutePositions(nodes);

  // Render all nodes in parallel
  const containers = await Promise.all(
    absoluteNodes.map((node) => renderNodeToContainer(node, onNodeClick)),
  );

  return containers;
}
