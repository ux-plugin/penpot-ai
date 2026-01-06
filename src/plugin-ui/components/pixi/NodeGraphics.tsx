/**
 * NodeGraphics Component
 *
 * Declarative React component for rendering design nodes as PixiJS Graphics.
 * Supports Figma frame nodes with fills, strokes, and corner radius.
 */

import { Graphics } from 'pixi.js';
import type { DesignNode } from '@shared-types/types';
import type { FrameNodeData } from '@components/nodes/node.types';
import {
  figmaColorToHex,
  figmaToPixiBlendMode,
  computeAbsolutePositions,
  type AbsoluteNode,
} from '@/plugin-ui/utils/pixiNodeRenderer';

// Paint type from Figma
interface Paint {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: { r: number; g: number; b: number };
}

export interface NodeGraphicsProps {
  /** The design node to render */
  node: AbsoluteNode;
  /** Callback when node is clicked */
  onClick?: (nodeId: string) => void;
  /** Optional override for x position */
  x?: number;
  /** Optional override for y position */
  y?: number;
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
  bl: number
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
 * Create draw function for frame node
 */
function createFrameDrawFunction(
  data: FrameNodeData,
  width: number,
  height: number
): (g: Graphics) => void {
  return (g: Graphics) => {
    // Clear previous drawing
    g.clear();

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
      if (fill.visible !== false && fill.type === 'SOLID' && fill.color) {
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
        bottomLeft
      );
    } else {
      g.rect(0, 0, width, height);
    }
    g.fill();

    // Handle strokes
    if (data.strokes && data.strokes.length > 0 && data.strokeWeight) {
      const stroke = data.strokes[0] as Paint;
      if (stroke.visible !== false && stroke.type === 'SOLID' && stroke.color) {
        const strokeColor = figmaColorToHex(stroke.color);
        const strokeWidth = data.strokeWeight.top || 1;

        // Stroke alignment: 0 = outer, 0.5 = center, 1 = inner
        const alignment =
          data.strokeAlign === 'INSIDE'
            ? 1
            : data.strokeAlign === 'OUTSIDE'
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
            bottomLeft
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
 * Create draw function for bounding box (transparent hit area)
 */
function createBoundingBoxDrawFunction(
  width: number,
  height: number
): (g: Graphics) => void {
  return (g: Graphics) => {
    g.clear();
    g.fill({ color: 0x3b82f6, alpha: 0 });
    g.rect(0, 0, width, height);
    g.fill();
  };
}

/**
 * Imperative node graphics component
 * 
 * This creates a Graphics object imperatively and returns it for use
 * with PixiJS containers. Since pixi-viewport doesn't work with @pixi/react's
 * declarative JSX, we use this approach.
 */
export function createNodeGraphics(
  node: AbsoluteNode,
  onClick?: (nodeId: string) => void
): Graphics {
  const { width, height, data } = node;
  const renderMode = data.renderMode || 'css';

  const g = new Graphics();

  // Determine draw function based on render mode
  let drawFunction: (g: Graphics) => void;
  if (renderMode === 'bounding-box') {
    drawFunction = createBoundingBoxDrawFunction(width, height);
  } else if (renderMode === 'svg' && !data.svg) {
    // Render SVG nodes without data as regular rectangles (no loading placeholder)
    drawFunction = createFrameDrawFunction(data as FrameNodeData, width, height);
  } else {
    // Render as frame with fills/strokes
    drawFunction = createFrameDrawFunction(data as FrameNodeData, width, height);
  }

  // Draw the graphics
  drawFunction(g);

  // Apply transformations
  g.x = node.absoluteX;
  g.y = node.absoluteY;
  g.rotation = ((data.rotation || 0) * Math.PI) / 180;
  g.alpha = data.opacity ?? 1;

  // Apply blend mode
  if (data.blendMode && typeof data.blendMode === 'string') {
    const blendMode = figmaToPixiBlendMode[data.blendMode];
    if (blendMode) {
      g.blendMode = blendMode;
    }
  }

  // Make interactive
  g.eventMode = 'static';
  g.cursor = 'pointer';
  g.label = node.id;

  // Click handler
  if (onClick) {
    g.on('pointerdown', () => onClick(node.id));
  }

  // Hover effect
  const originalAlpha = data.opacity ?? 1;
  g.on('pointerenter', () => {
    g.alpha = Math.max(0.7, originalAlpha - 0.2);
  });
  g.on('pointerleave', () => {
    g.alpha = originalAlpha;
  });

  return g;
}

/**
 * Props for creating node graphics
 */
export interface CreateNodeGraphicsOptions {
  nodes: DesignNode[];
  onClick?: (nodeId: string) => void;
}

/**
 * Create graphics for all nodes
 */
export function createAllNodeGraphics(
  options: CreateNodeGraphicsOptions
): Graphics[] {
  const { nodes, onClick } = options;
  const absoluteNodes = computeAbsolutePositions(nodes);

  return absoluteNodes.map((node) => createNodeGraphics(node, onClick));
}

/**
 * Re-export types for convenience
 */
export { type AbsoluteNode } from '@/plugin-ui/utils/pixiNodeRenderer';

